const { WebSocketServer } = require('ws');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const WS_PORT = 3001;
const HTTP_PORT = 3000;
const TIMEOUT_MS = 30000;
// Kurzer DOM-Test vor Ausführungen, solange InDesign als blockiert gilt
const PROBE_TIMEOUT_MS = 3000;
const PROBE_CODE = 'return app.documents.length;';
const BLOCKED_HINT =
  'InDesign is not responding – most likely a modal dialog is open in InDesign ' +
  '(e.g. missing fonts/links, save or import options). Please check InDesign, close the dialog and retry.';

// L1: Optional auth token — set BRIDGE_TOKEN env var to require Bearer auth on /execute.
// Without it the bridge is open to any local process; token is recommended for shared machines.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;
if (!BRIDGE_TOKEN) {
  console.warn('[Bridge] WARNING: BRIDGE_TOKEN not set. Any local process can send InDesign commands.');
  console.warn('[Bridge]   To enable auth: export BRIDGE_TOKEN="$(openssl rand -hex 32)" before starting.');
}

const app = express();
app.use(express.json());

// Auth middleware — only applied when BRIDGE_TOKEN is configured
if (BRIDGE_TOKEN) {
  app.use('/execute', (req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${BRIDGE_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid BRIDGE_TOKEN' });
    }
    next();
  });
}

let pluginSocket = null;
let pluginInfo = null; // { version, ... } aus der hello-Nachricht des Plugins
// Zeitpunkt des letzten Timeouts ohne seither eingegangene Antwort des Plugins
let blockedSince = null;
const pending = new Map(); // id -> { resolve, reject, timer }

// Serial execution queue — one UXP execution in flight at a time to prevent
// concurrent DOM mutations from corrupting InDesign document state (H2).
const requestQueue = [];
let processingQueue = false;

function drainQueue() {
  if (processingQueue || requestQueue.length === 0) return;

  const socket = pluginSocket;
  if (!socket) {
    // Drain all queued items with a connection error
    while (requestQueue.length > 0) {
      const item = requestQueue.shift();
      item.reject(new Error('Plugin not connected'));
    }
    return;
  }

  processingQueue = true;
  const { code, resolve, reject, timeoutMs = TIMEOUT_MS } = requestQueue.shift();
  const id = uuidv4();

  const timer = setTimeout(() => {
    pending.delete(id);
    processingQueue = false;
    if (!blockedSince) blockedSince = Date.now();
    reject(new Error(`Execution timed out after ${Math.round(timeoutMs / 1000)}s. ${BLOCKED_HINT}`));
    drainQueue();
  }, timeoutMs);

  pending.set(id, {
    resolve: (result) => {
      processingQueue = false;
      resolve(result);
      drainQueue();
    },
    reject: (err) => {
      processingQueue = false;
      reject(err);
      drainQueue();
    },
    timer,
  });

  // Guard against WebSocket transitioning to CLOSING between null-check and send (L2)
  try {
    // deadline: Plugin verwirft Aufträge, die erst nach dem Timeout ankommen (z. B. nach
    // Schließen eines Dialogs), damit sie nicht verspätet doch noch ausgeführt werden.
    socket.send(JSON.stringify({ type: 'execute', id, code, deadline: Date.now() + timeoutMs }));
    console.log('[Bridge] Sending execute:', id, code.slice(0, 100));
  } catch (err) {
    clearTimeout(timer);
    pending.delete(id);
    processingQueue = false;
    reject(new Error('Failed to send to plugin: ' + err.message));
    drainQueue();
  }
}

function enqueueExecution(code, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ code, resolve, reject, timeoutMs });
    drainQueue();
  });
}

// Liefert true, wenn InDesign ein triviales DOM-Skript zügig beantwortet
async function probeInDesign() {
  try {
    await enqueueExecution(PROBE_CODE, PROBE_TIMEOUT_MS);
    blockedSince = null;
    return true;
  } catch {
    return false;
  }
}

function blockedError() {
  const secs = Math.round((Date.now() - blockedSince) / 1000);
  return `InDesign blocked (no response for ${secs}s). ${BLOCKED_HINT}`;
}

// WebSocket server — UXP plugin connects here
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws) => {
  console.log('[Bridge] Plugin connected');
  pluginSocket = ws;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('[Bridge] Invalid JSON from plugin:', data.toString());
      return;
    }

    console.log('[Bridge] From plugin:', JSON.stringify(msg).slice(0, 200));

    if (msg.type === 'hello') {
      pluginInfo = { version: msg.version || null, dialogGuard: msg.dialogGuard === true };
      return;
    }

    // Jede Antwort, auch eine verspätete, zeigt: InDesign reagiert wieder
    if (msg.type === 'result' || msg.type === 'error' || msg.type === 'stale') blockedSince = null;

    const item = pending.get(msg.id);
    if (!item) return;

    clearTimeout(item.timer);
    pending.delete(msg.id);

    if (msg.type === 'result') {
      item.resolve(msg.result);
    } else if (msg.type === 'error') {
      item.reject(new Error(msg.error));
    } else if (msg.type === 'pong') {
      item.resolve('pong');
    }
  });

  ws.on('close', () => {
    console.log('[Bridge] Plugin disconnected');
    pluginSocket = null;
    pluginInfo = null;
    blockedSince = null;
    // Reject any in-flight pending entry
    for (const [id, item] of pending.entries()) {
      clearTimeout(item.timer);
      item.reject(new Error('Plugin disconnected'));
      pending.delete(id);
    }
    // processingQueue will be unblocked via the reject→drainQueue chain above;
    // if for some reason it isn't, reset it so reconnect can proceed
    processingQueue = false;
    // Drain any items waiting in queue with a connection error
    drainQueue();
  });

  ws.on('error', (err) => {
    console.error('[Bridge] WebSocket error:', err);
  });
});

// HTTP API — MCP server calls these endpoints

// /status?probe=1 prüft zusätzlich aktiv mit kurzem Timeout, ob InDesign reagiert
app.get('/status', async (req, res) => {
  let responsive = null;
  if (req.query.probe && pluginSocket && !processingQueue && requestQueue.length === 0) {
    responsive = await probeInDesign();
  }
  res.json({
    connected: pluginSocket !== null,
    queueDepth: requestQueue.length,
    busy: processingQueue,
    blocked: blockedSince !== null,
    blockedSince: blockedSince ? new Date(blockedSince).toISOString() : null,
    responsive,
    plugin: pluginInfo,
    hint: blockedSince ? BLOCKED_HINT : undefined,
  });
});

app.post('/execute', async (req, res) => {
  if (!pluginSocket) {
    return res.status(503).json({
      error: 'Plugin not connected. Open InDesign, then load the Bridge Panel via UXP Developer Tool.'
    });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing "code" in request body' });
  }

  try {
    // Nach einem Timeout erst kurz testen, statt erneut 30 s zu warten
    if (blockedSince && !(await probeInDesign())) {
      return res.status(503).json({ error: blockedError(), blocked: true });
    }
    const result = await enqueueExecution(code);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[Bridge] HTTP server on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[Bridge] WebSocket server on ws://127.0.0.1:${WS_PORT}`);
  console.log('[Bridge] Waiting for UXP plugin to connect...');
});
