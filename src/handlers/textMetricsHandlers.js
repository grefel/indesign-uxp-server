/**
 * Text metrics handlers — line-level measurement, wrap simulation and
 * fitting text frame heights to their content.
 *
 * All positions/lengths are millimeters (document ruler origin), text sizes
 * are points.
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { parseItemId } from '../utils/itemUtils.js';
import { TEXT_HELPERS, resolveTextFrameSnippet } from '../utils/textSnippets.js';

function optionalNumber(value, label, { min = -Infinity, exclusiveMin = false } = {}) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || (exclusiveMin && n === min)) {
        throw new Error(`${label} must be a number${min > -Infinity ? ` ${exclusiveMin ? '>' : '>='} ${min}` : ''}, got: ${JSON.stringify(value)}`);
    }
    return n;
}

export class TextMetricsHandlers {
    /**
     * Per-line metrics of a text frame plus overset status.
     */
    static async getTextMetrics(args) {
        const op = 'Get Text Metrics';
        let itemId;
        try { itemId = parseItemId(args.itemId); }
        catch (e) { return formatErrorResponse(e.message, op); }

        const code = `
            ${resolveTextFrameSnippet(itemId)}
            ${TEXT_HELPERS}
            ${withMillimetersUnitsSnippet(`
                const lines = __readLines(frame);
                return {
                    success: true,
                    itemId: ${itemId},
                    units: { position: 'mm', textSize: 'pt' },
                    frame: __frameInfo(frame),
                    lineCount: lines.length,
                    textBlock: __textBlock(frame, lines),
                    overset: __oversetInfo(frame),
                    lines,
                };
            `)}
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, op)
            : formatErrorResponse(result?.error || 'Failed to read text metrics', op);
    }

    /**
     * Simulates the line breaks of a frame for an assumed width / point size /
     * sample text on a temporary duplicate, which is removed afterwards.
     */
    static async measureText(args) {
        const op = 'Measure Text';
        let itemId, width, pointSize, leading;
        try {
            itemId = parseItemId(args.itemId);
            width = optionalNumber(args.width, 'width', { min: 0, exclusiveMin: true });
            pointSize = optionalNumber(args.pointSize, 'pointSize', { min: 0, exclusiveMin: true });
            leading = optionalNumber(args.leading, 'leading', { min: 0, exclusiveMin: true });
        } catch (e) { return formatErrorResponse(e.message, op); }
        const text = typeof args.text === 'string' ? args.text : null;

        const code = `
            ${resolveTextFrameSnippet(itemId)}
            const { AutoSizingTypeEnum, AutoSizingReferenceEnum } = require('indesign');
            ${TEXT_HELPERS}
            ${withMillimetersUnitsSnippet(`
                const srcBounds = frame.geometricBounds;
                const srcHeight = srcBounds[2] - srcBounds[0];
                const inset = __arr(frame.textFramePreferences.insetSpacing);
                const insetBottom = inset.length === 4 ? inset[2] : inset[0];
                const testWidth = ${width ?? 'null'} ?? (srcBounds[3] - srcBounds[1]);
                // Ein Duplikat eines verketteten Rahmens ist unverkettet und enthält nur dessen eigenen Text.
                const dup = frame.duplicate();
                try {
                    dup.geometricBounds = [srcBounds[0], srcBounds[1], srcBounds[2], srcBounds[1] + testWidth];
                    const body = dup.texts.item(0);
                    ${text !== null ? `body.contents = ${JSON.stringify(text)};` : ''}
                    let pointSizeScale = null;
                    ${pointSize !== null ? `
                    // Gemischte Schriftgrade proportional skalieren, damit Auszeichnungen erhalten bleiben
                    const refSize = dup.characters.length ? dup.characters.item(0).pointSize : ${pointSize};
                    pointSizeScale = ${pointSize} / refSize;
                    const ranges = dup.parentStory.textStyleRanges.everyItem().getElements();
                    for (const rg of ranges) {
                        const ld = rg.leading;
                        rg.pointSize = rg.pointSize * pointSizeScale;
                        if (typeof ld === 'number') rg.leading = ld * pointSizeScale;
                    }` : ''}
                    ${leading !== null ? `body.leading = ${leading};` : ''}
                    const tfp = dup.textFramePreferences;
                    tfp.autoSizingReferencePoint = AutoSizingReferenceEnum.TOP_LEFT_POINT;
                    tfp.autoSizingType = AutoSizingTypeEnum.HEIGHT_ONLY;
                    const lines = __readLines(dup);
                    const top = srcBounds[0];
                    const last = lines[lines.length - 1];
                    const requiredHeightToBaseline = last ? __r(last.baseline + insetBottom - top) : 0;
                    const requiredHeightToDescender = last ? __r(last.bottom + insetBottom - top) : 0;
                    return {
                        success: true,
                        itemId: ${itemId},
                        units: { position: 'mm', textSize: 'pt' },
                        assumed: {
                            width: __r(testWidth),
                            pointSize: ${pointSize ?? 'null'},
                            pointSizeScale: __r(pointSizeScale),
                            leading: ${leading ?? 'null'},
                            sampleText: ${text !== null},
                        },
                        sourceIsThreaded: !!(frame.previousTextFrame || frame.nextTextFrame),
                        lineCount: lines.length,
                        hyphenatedLines: lines.filter(l => l.hyphenated).length,
                        currentHeight: __r(srcHeight),
                        requiredHeightToBaseline,
                        requiredHeightToDescender,
                        fitsCurrentHeight: requiredHeightToBaseline <= srcHeight + 0.001,
                        textBlock: __textBlock(dup, lines),
                        lines,
                    };
                } finally {
                    dup.remove();
                }
            `)}
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, op)
            : formatErrorResponse(result?.error || 'Failed to measure text', op);
    }

    /**
     * Shrinks/grows a text frame's height to its content and optionally moves
     * it so the last baseline (or descender) sits at a given y position.
     */
    static async fitTextFrameHeight(args) {
        const op = 'Fit Text Frame Height';
        const fitTo = args.fitTo ?? 'descender';
        const alignTarget = args.alignTarget ?? 'lastBaseline';
        let itemId, alignBaselineTo;
        try {
            itemId = parseItemId(args.itemId);
            alignBaselineTo = optionalNumber(args.alignBaselineTo, 'alignBaselineTo');
            if (!['descender', 'baseline'].includes(fitTo)) throw new Error(`fitTo must be 'descender' or 'baseline'`);
            if (!['lastBaseline', 'descender'].includes(alignTarget)) throw new Error(`alignTarget must be 'lastBaseline' or 'descender'`);
        } catch (e) { return formatErrorResponse(e.message, op); }

        const code = `
            ${resolveTextFrameSnippet(itemId)}
            const { AutoSizingTypeEnum, AutoSizingReferenceEnum } = require('indesign');
            ${TEXT_HELPERS}
            ${withMillimetersUnitsSnippet(`
                if (Math.abs(frame.rotationAngle) > 0.001 || Math.abs(frame.shearAngle) > 0.001) {
                    return { success: false, error: 'Rotated or sheared frames are not supported' };
                }
                const before = frame.geometricBounds.map(__r);
                const tfp = frame.textFramePreferences;
                const originalAutoSizing = String(tfp.autoSizingType);
                // Nur der letzte Rahmen einer Kette darf wachsen; bei Folgerahmen zählen die aktuell enthaltenen Zeilen.
                if (!frame.nextTextFrame) {
                    // InDesigns Auto-Größe passt Übersatz ein, setzt die Unterkante aber auf die letzte Grundlinie.
                    const savedRef = tfp.autoSizingReferencePoint;
                    tfp.autoSizingReferencePoint = AutoSizingReferenceEnum.TOP_LEFT_POINT;
                    tfp.autoSizingType = AutoSizingTypeEnum.HEIGHT_ONLY;
                    tfp.autoSizingType = AutoSizingTypeEnum.OFF;
                    tfp.autoSizingReferencePoint = savedRef;
                } else if (originalAutoSizing !== 'OFF') {
                    tfp.autoSizingType = AutoSizingTypeEnum.OFF;
                }
                let lines = __readLines(frame);
                if (!lines.length) return { success: false, error: 'Frame contains no lines' };
                const inset = __arr(tfp.insetSpacing);
                const insetBottom = inset.length === 4 ? inset[2] : inset[0];
                let last = lines[lines.length - 1];
                const gb = frame.geometricBounds;
                let bottom = (${JSON.stringify(fitTo)} === 'descender' ? last.bottom : last.baseline) + insetBottom;
                frame.geometricBounds = [gb[0], gb[1], bottom, gb[3]];
                // Rundung kann die letzte Zeile in den Übersatz schieben → minimal nachgeben
                for (let i = 0; i < 5 && !frame.nextTextFrame && frame.overflows; i++) {
                    bottom += 0.01;
                    frame.geometricBounds = [gb[0], gb[1], bottom, gb[3]];
                }
                let moved = 0;
                ${alignBaselineTo !== null ? `
                lines = __readLines(frame);
                last = lines[lines.length - 1];
                const current = ${JSON.stringify(alignTarget)} === 'descender' ? last.bottom : last.baseline;
                moved = ${alignBaselineTo} - current;
                const b = frame.geometricBounds;
                frame.geometricBounds = [b[0] + moved, b[1], b[2] + moved, b[3]];` : ''}
                lines = __readLines(frame);
                last = lines[lines.length - 1];
                const after = frame.geometricBounds.map(__r);
                return {
                    success: true,
                    itemId: ${itemId},
                    units: 'mm',
                    fitTo: ${JSON.stringify(fitTo)},
                    before,
                    after,
                    height: __r(after[2] - after[0]),
                    movedBy: __r(moved),
                    lastBaseline: last.baseline,
                    descenderBottom: last.bottom,
                    lineCount: lines.length,
                    autoSizingDisabled: originalAutoSizing !== 'OFF' ? originalAutoSizing : null,
                    overset: __oversetInfo(frame),
                };
            `)}
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, op)
            : formatErrorResponse(result?.error || 'Failed to fit text frame height', op);
    }
}
