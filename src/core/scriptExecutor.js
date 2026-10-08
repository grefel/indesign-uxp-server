/**
 * Core script execution functionality
 */
const BRIDGE_URL = 'http://127.0.0.1:3000';

// L1: read auth token from env — must match BRIDGE_TOKEN set when starting bridge/server.js
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;

function bridgeHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (BRIDGE_TOKEN) headers['Authorization'] = `Bearer ${BRIDGE_TOKEN}`;
    return headers;
}

const BLOCKED_HINT =
    'InDesign is not responding – most likely a modal dialog is open in InDesign ' +
    '(e.g. missing fonts/links, save or import options). Please check InDesign, close the dialog and retry.';

/**
 * Kapselt Code so, dass InDesign während der Ausführung keine Dialoge zeigt
 * (NEVER_INTERACT) und der vorherige Wert danach wiederhergestellt wird.
 * Der Originalcode läuft als eigene async IIFE, damit seine Deklarationen und
 * `return` unverändert funktionieren.
 */
export function wrapWithDialogGuard(code) {
    return `
        const __mcpSp = app.scriptPreferences;
        const __mcpPrevUil = __mcpSp.userInteractionLevel;
        __mcpSp.userInteractionLevel = require('indesign').UserInteractionLevels.NEVER_INTERACT;
        try {
            return await (async () => {
${code}
            })();
        } finally {
            try { __mcpSp.userInteractionLevel = __mcpPrevUil; } catch (e) {}
        }
    `;
}

export class ScriptExecutor {
    static BLOCKED_HINT = BLOCKED_HINT;

    /**
     * Execute JS code inside InDesign via the UXP bridge
     * @param {string} code - JS code with `app` in scope (UXP InDesign API)
     * @returns {any} The serialized result
     */
    static async executeViaUXP(code) {
        let response;
        // L5: 35s timeout — slightly longer than bridge's 30s execution timeout so we
        // get the bridge's own error message rather than a generic fetch abort
        const post = () => fetch(`${BRIDGE_URL}/execute`, {
            method: 'POST',
            headers: bridgeHeaders(),
            body: JSON.stringify({ code: wrapWithDialogGuard(code) }),
            signal: AbortSignal.timeout(35000),
        });
        try {
            try {
                response = await post();
            } catch (err) {
                // Keep-Alive-Socket nach > 5 s Leerlauf vom Bridge-Server geschlossen: einmal neu verbinden
                if (!['ECONNRESET', 'UND_ERR_SOCKET'].includes(err.cause?.code)) throw err;
                response = await post();
            }
        } catch (err) {
            // Bridge erreichbar, aber keine Antwort: InDesign hängt (meist modaler Dialog)
            if (err.name === 'TimeoutError') {
                throw new Error(`No response from bridge within 35s. ${BLOCKED_HINT}`);
            }
            // Fast-fail with a clear message when the bridge process isn't running (L5)
            if (err.name === 'TypeError' || err.code === 'ECONNREFUSED') {
                throw new Error(
                    'Bridge not reachable. Start it first: cd bridge && node server.js'
                );
            }
            throw err;
        }

        const data = await response.json();

        if (!response.ok) {
            const msg = data.error || `Bridge error: ${response.status}`;
            // Ältere Bridge-Version meldet nur den nackten Timeout
            if (/timed out/i.test(msg) && !msg.includes('modal dialog')) {
                throw new Error(`${msg}. ${BLOCKED_HINT}`);
            }
            throw new Error(msg);
        }

        return data.result;
    }

    /**
     * Check if the UXP bridge is running and plugin is connected
     * @returns {boolean}
     */
    static async isUXPAvailable() {
        try {
            const response = await fetch(`${BRIDGE_URL}/status`, {
                headers: bridgeHeaders(),
                signal: AbortSignal.timeout(1000),
            });
            const data = await response.json();
            return data.connected === true;
        } catch {
            return false;
        }
    }

}
