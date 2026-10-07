/**
 * Bildanalyse per Code: Freiflächen-Maske platzierter Bilder und
 * Kollisionsprüfung Text ↔ Motiv, ohne dass ein LLM das Bild ansehen muss.
 *
 * InDesign liefert nur Geometrie und Linkpfad; Pixelanalyse und Geometrie
 * laufen in Node (src/utils/imageMask.js). Positionen/Längen in mm.
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { parseItemId, findItemByIdSnippet } from '../utils/itemUtils.js';
import {
    getMotifMask, normalizeMaskParams, placeMask, rowSpans, orientedMaskRows,
    largestFreeRects, resolutionInfo, checkRect, boundsToRect, rectToArray, r1,
    placementFromGeometry, motifRects, unionRect,
} from '../utils/imageMask.js';

/**
 * UXP-Snippet: bindet `image` (Grafik) und `frame` (Container) zu itemId und
 * liefert `__placement()` mit Link, Auflösung, Bounds (mm) und Transformation.
 * `doc` muss im Scope sein, Einheiten auf mm gesetzt.
 */
function resolveImageSnippet(itemId) {
    return `
            ${findItemByIdSnippet('__item', itemId)}
            if (!__item) return { success: false, error: 'No page item with id ${itemId}' };
            const __r = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
            let image = null;
            if (['Image', 'EPS', 'PDF', 'PICT', 'WMF', 'SVG', 'ImportedPage', 'Graphic'].includes(__item.constructor.name)) {
                image = __item;
            } else {
                const g = __item.allGraphics;
                if (g && g.length) image = g[0];
            }
            if (!image) return { success: false, error: 'Item ${itemId} (' + __item.constructor.name + ') contains no placed graphic' };
            const frame = image.parent;
            function __placement() {
                const link = image.itemLink;
                const page = frame.parentPage;
                const num = v => (typeof v === 'number' ? v : null);
                let actualPpi = null, effectivePpi = null;
                try { actualPpi = image.actualPpi; effectivePpi = image.effectivePpi; } catch (e) {}
                return {
                    imageId: image.id,
                    imageType: image.constructor.name,
                    frameId: frame.id,
                    frameType: frame.constructor.name,
                    layer: frame.itemLayer ? frame.itemLayer.name : null,
                    filePath: link ? link.filePath : null,
                    linkStatus: link ? String(link.status) : null,
                    actualPpi, effectivePpi,
                    imageBounds: image.geometricBounds.map(__r),
                    frameBounds: frame.geometricBounds.map(__r),
                    pageBounds: page ? page.bounds.map(__r) : null,
                    pageName: page ? page.name : null,
                    rotation: __r(num(image.absoluteRotationAngle) || 0),
                    shear: __r(num(image.absoluteShearAngle) || 0),
                    hScale: __r(num(image.absoluteHorizontalScale)),
                    vScale: __r(num(image.absoluteVerticalScale)),
                    flip: String(image.absoluteFlip),
                };
            }
    `;
}

/** UXP-Snippet: Zeilenboxen von Textrahmen (everyItem, ein Roundtrip je Eigenschaft). */
const LINE_BOXES_SNIPPET = `
            const __arr = v => (Array.isArray(v) ? v : [v]);
            function __lineBoxes(tf) {
                const L = tf.lines;
                const n = L.length;
                if (!n) return [];
                const ev = L.everyItem();
                const contents = __arr(ev.contents), baseline = __arr(ev.baseline),
                      ascent = __arr(ev.ascent), descent = __arr(ev.descent),
                      x1 = __arr(ev.horizontalOffset), x2 = __arr(ev.endHorizontalOffset);
                const out = [];
                for (let i = 0; i < n; i++) {
                    const text = String(contents[i]).replace(/[\\r\\n]$/, '');
                    if (!text.trim()) continue;
                    out.push({ i, text, top: baseline[i] - ascent[i], bottom: baseline[i] + descent[i], left: x1[i], right: x2[i] });
                }
                return out;
            }
`;

const UNSUPPORTED_HINT = 'Supported formats: JPEG, PNG, TIFF, WebP, GIF, AVIF. For PSD/AI/PDF/EPS export a JPEG/PNG preview of the image and analyse that instead.';

function placementFromInfo(info) {
    return placementFromGeometry(info);
}

function placementWarnings(info, mask) {
    const w = [];
    if (Math.abs(info.rotation) > 0.01 || Math.abs(info.shear) > 0.01) {
        w.push(`Image is rotated (${info.rotation}°) or sheared (${info.shear}°); mm coordinates assume an axis-aligned image within its geometric bounds and are approximate.`);
    }
    if (mask.orientation && mask.orientation > 1) {
        w.push(`File has EXIF orientation ${mask.orientation}; mask assumes unrotated pixel data.`);
    }
    if (info.frameType !== 'Rectangle') {
        w.push(`Frame is a ${info.frameType}; its bounding box is used as clipping area.`);
    }
    return w;
}

async function loadImagePlacement(itemId, extraBody = '', extraReturn = '') {
    const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            ${withMillimetersUnitsSnippet(`
                ${resolveImageSnippet(itemId)}
                ${extraBody}
                return { success: true, info: __placement() ${extraReturn} };
            `)}
    `;
    return ScriptExecutor.executeViaUXP(code);
}

async function maskFor(info, params, useCache) {
    if (!info.filePath) throw Object.assign(new Error('Graphic has no file link'), { code: 'nolink' });
    try {
        return await getMotifMask(info.filePath, params, { useCache });
    } catch (e) {
        if (e.code === 'ENOENT') throw Object.assign(new Error(`Linked file not found: ${info.filePath} (link status ${info.linkStatus})`), { code: 'missing' });
        throw e;
    }
}

function cutSides(full, clip) {
    if (!full || !clip) return [];
    const eps = 0.05;
    const s = [];
    if (full.top < clip.top - eps) s.push('top');
    if (full.bottom > clip.bottom + eps) s.push('bottom');
    if (full.left < clip.left - eps) s.push('left');
    if (full.right > clip.right + eps) s.push('right');
    return s;
}

const area = r => (r ? (r.bottom - r.top) * (r.right - r.left) : 0);

export class ImageAnalysisHandlers {
    /**
     * Motiv-/Freiflächen-Maske eines platzierten Bildes in aktueller Platzierung.
     */
    static async analyzeImageFreeSpace(args) {
        const op = 'Analyze Image Free Space';
        let itemId, params;
        try {
            itemId = parseItemId(args.itemId);
            params = normalizeMaskParams(args);
        } catch (e) { return formatErrorResponse(e.message, op); }
        const useCache = args.useCache !== false;

        const res = await loadImagePlacement(itemId);
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to read image placement', op);
        const info = res.info;

        let mask;
        try { mask = await maskFor(info, params, useCache); }
        catch (e) {
            return formatErrorResponse(e.code === 'unsupported' ? { unsupported: true, error: e.message, hint: UNSUPPORTED_HINT, filePath: info.filePath } : e.message, op);
        }

        const placement = placementFromInfo(info);
        const placed = placeMask(mask, placement);
        const fullBBox = unionRect(placed.cells.map(c => c.rect));
        const visBBox = unionRect(placed.cells.map(c => c.visible));
        const visibleArea = placed.cells.reduce((s, c) => s + area(c.visible), 0);
        const fullArea = placed.cells.reduce((s, c) => s + area(c.rect), 0);
        const ib = info.imageBounds;
        const toNorm = r => r && [
            (r.top - ib[0]) / (ib[2] - ib[0]), (r.left - ib[1]) / (ib[3] - ib[1]),
            (r.bottom - ib[0]) / (ib[2] - ib[0]), (r.right - ib[1]) / (ib[3] - ib[1]),
        ].map(v => Math.round(v * 1000) / 1000);

        const result = {
            itemId,
            imageId: info.imageId,
            frameId: info.frameId,
            layer: info.layer,
            file: info.filePath,
            units: 'mm',
            pixels: [mask.pixelWidth, mask.pixelHeight],
            effectivePpi: info.effectivePpi,
            imageBounds: info.imageBounds.map(r1),
            frameBounds: info.frameBounds.map(r1),
            pageBounds: info.pageBounds ? info.pageBounds.map(r1) : null,
            grid: [mask.cols, mask.rows],
            cellMm: [r1((ib[3] - ib[1]) / mask.cols), r1((ib[2] - ib[0]) / mask.rows)],
            maskRows: orientedMaskRows(mask, placement),
            motifBBox: { norm: toNorm(fullBBox), page: rectToArray(fullBBox) },
            visible: {
                clip: placement.clip.map(r1),
                motifBBox: rectToArray(visBBox),
                motifVisibleRatio: fullArea ? Math.round(visibleArea / fullArea * 1000) / 1000 : null,
                motifCutAt: cutSides(fullBBox, placed.clip),
            },
            rowSpans: rowSpans(placed),
            freeRects: largestFreeRects(placed, placement),
            ...resolutionInfo(mask, info.imageBounds),
            cache: mask.cache,
        };
        const warnings = placementWarnings(info, mask);
        if (warnings.length) result.warnings = warnings;
        return formatResponse(result, op);
    }

    /**
     * Prüft Textrahmen (zeilengenau) und/oder Rechtecke gegen das sichtbare
     * Motiv eines Bildes.
     */
    static async checkMotifCollision(args) {
        const op = 'Check Motif Collision';
        let imageItemId, itemIds = null, rects = [], params, minGap;
        try {
            imageItemId = parseItemId(args.imageItemId, 'imageItemId');
            if (args.itemIds !== undefined && args.itemIds !== null) {
                if (!Array.isArray(args.itemIds)) throw new Error('itemIds must be an array of ids');
                itemIds = args.itemIds.map(v => parseItemId(v, 'itemIds[]'));
            }
            if (args.rects !== undefined && args.rects !== null) {
                if (!Array.isArray(args.rects)) throw new Error('rects must be an array');
                rects = args.rects.map((r, i) => {
                    const v = ['top', 'left', 'bottom', 'right'].map(k => Number(r?.[k]));
                    if (v.some(x => !Number.isFinite(x)) || v[2] <= v[0] || v[3] <= v[1]) {
                        throw new Error(`rects[${i}] needs numeric top < bottom and left < right (mm)`);
                    }
                    return { label: r.label ?? `rect${i}`, top: v[0], left: v[1], bottom: v[2], right: v[3] };
                });
            }
            minGap = Number(args.minGap ?? 0);
            if (!Number.isFinite(minGap) || minGap < 0) throw new Error('minGap must be a number >= 0 (mm)');
            params = normalizeMaskParams({ grid: 64, ...args });
        } catch (e) { return formatErrorResponse(e.message, op); }
        const useCache = args.useCache !== false;
        // Ohne Angaben: alle Textrahmen auf Seite und Ebene des Bildes
        const autoFrames = itemIds === null && rects.length === 0;

        const extraBody = `
            ${LINE_BOXES_SNIPPET}
            const __frames = [];
            const __missing = [];
            ${autoFrames ? `
            const __pg = frame.parentPage;
            if (__pg) {
                const all = __pg.allPageItems;
                for (let i = 0; i < all.length; i++) {
                    const it = all[i];
                    if (it.constructor.name === 'TextFrame' && it.itemLayer.id === frame.itemLayer.id) __frames.push(it);
                }
            }` : `
            for (const id of ${JSON.stringify(itemIds || [])}) {
                let f = null;
                try { const c = doc.pageItems.itemByID(id); if (c.isValid) f = c.getElements()[0]; } catch (e) {}
                if (!f) { const all = doc.allPageItems; for (let i = 0; i < all.length; i++) if (all[i].id === id) { f = all[i]; break; } }
                if (f) __frames.push(f); else __missing.push(id);
            }`}
            const __items = __frames.map(f => f.constructor.name === 'TextFrame'
                ? { id: f.id, type: 'TextFrame', lines: __lineBoxes(f), bounds: f.geometricBounds, overflows: f.overflows }
                : { id: f.id, type: f.constructor.name, bounds: f.geometricBounds });
        `;
        const res = await loadImagePlacement(imageItemId, extraBody, ', items: __items, missing: __missing');
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to read items', op);
        const info = res.info;

        let mask;
        try { mask = await maskFor(info, params, useCache); }
        catch (e) {
            return formatErrorResponse(e.code === 'unsupported' ? { unsupported: true, error: e.message, hint: UNSUPPORTED_HINT, filePath: info.filePath } : e.message, op);
        }
        const placement = placementFromInfo(info);
        const placed = placeMask(mask, placement);
        const motif = motifRects(placed);

        const results = [];
        for (const it of res.items) {
            if (it.type !== 'TextFrame') {
                const c = checkRect(boundsToRect(it.bounds), motif, minGap);
                results.push(c.collides
                    ? { id: it.id, ok: false, type: it.type, distance: c.distance, overlapX: c.overlapX, overlapY: c.overlapY }
                    : { id: it.id, ok: true, type: it.type, distance: c.distance });
                continue;
            }
            const collisions = [];
            let minDist = null;
            for (const ln of it.lines) {
                const c = checkRect(ln, motif, minGap);
                if (c.distance !== null && (minDist === null || c.distance < minDist)) minDist = c.distance;
                if (c.collides) {
                    collisions.push({
                        line: ln.i,
                        text: ln.text.length > 30 ? ln.text.slice(0, 29) + '…' : ln.text,
                        box: rectToArray(ln),
                        overlapX: c.overlapX, overlapY: c.overlapY, motifX: c.motifX,
                    });
                }
            }
            const entry = { id: it.id, ok: collisions.length === 0, distance: minDist };
            if (collisions.length) entry.collisions = collisions;
            if (it.overflows) entry.overset = true;
            results.push(entry);
        }
        for (const r of rects) {
            const c = checkRect(r, motif, minGap);
            results.push(c.collides
                ? { label: r.label, ok: false, distance: c.distance, overlapX: c.overlapX, overlapY: c.overlapY, motifX: c.motifX }
                : { label: r.label, ok: true, distance: c.distance });
        }

        const out = {
            imageId: info.imageId,
            frameId: info.frameId,
            units: 'mm',
            minGap,
            allOk: results.every(r => r.ok),
            results,
        };
        if (autoFrames) out.checked = 'all text frames on the image page and layer';
        if (res.missing?.length) out.missingIds = res.missing;
        const warnings = placementWarnings(info, mask);
        if (warnings.length) out.warnings = warnings;
        return formatResponse(out, op);
    }
}
