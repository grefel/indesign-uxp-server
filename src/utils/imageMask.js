/**
 * Motiv-/Freiflächen-Maske für platzierte Bilder.
 *
 * Ablauf: Bild laden (sharp, auf Weiß geflattet, Graustufe) → Raster mit
 * quadratischen Zellen → pro Zelle Motivanteil und Pixel-BBox des Motivs →
 * normierte Maske (0..1, Bildraum). Diese ist platzierungsunabhängig und
 * wird als Sidecar-JSON neben dem Link gecacht. Die Umrechnung in Seiten-mm
 * (Platzierung, Spiegelung, Beschnitt durch Rahmen/Seite) und die
 * Kollisionsprüfung sind reine Funktionen.
 *
 * Rechtecke im Seitenraum: { top, left, bottom, right } in mm.
 */
import { promises as fs } from 'fs';

export const MASK_VERSION = 1;
const MM_PER_INCH = 25.4;
const memoryCache = new Map();

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Für LLM-Ausgaben: mm auf 0,1 mm. */
export const r1 = v => round(v, 1);

/**
 * Normalisiert die Masken-Parameter (Grenzen prüfen, Defaults setzen).
 */
export function normalizeMaskParams({ grid = 32, whiteThreshold = 250, occupiedRatio = 0.02, fillHoles = true } = {}) {
    const g = Number(grid), w = Number(whiteThreshold), o = Number(occupiedRatio);
    if (!Number.isInteger(g) || g < 4 || g > 256) throw new Error(`grid must be an integer 4..256, got: ${JSON.stringify(grid)}`);
    if (!Number.isFinite(w) || w < 1 || w > 255) throw new Error(`whiteThreshold must be 1..255, got: ${JSON.stringify(whiteThreshold)}`);
    if (!Number.isFinite(o) || o < 0 || o >= 1) throw new Error(`occupiedRatio must be 0..<1, got: ${JSON.stringify(occupiedRatio)}`);
    return { grid: g, whiteThreshold: w, occupiedRatio: o, fillHoles: fillHoles !== false };
}

/** Rasterdimension: quadratische Zellen, längere Bildseite = grid Zellen. */
export function gridDims(width, height, grid) {
    if (width >= height) return { cols: grid, rows: Math.max(1, Math.round(grid * height / width)) };
    return { cols: Math.max(1, Math.round(grid * width / height)), rows: grid };
}

/**
 * Reine Maskenberechnung aus Graustufenpixeln (1 Kanal, 0..255).
 * Pixel ist Motiv, wenn Luminanz < whiteThreshold. Zelle belegt, wenn
 * Motivanteil > occupiedRatio; ihre Ausdehnung ist die BBox ihrer Motivpixel.
 * Mit fillHoles zählen eingeschlossene freie Zellen als Motiv (volle Zelle).
 * @returns {{cols:number, rows:number, maskRows:string[], cells:number[][]}}
 *   cells: [row, col, x0, y0, x1, y1] normiert 0..1 (Bildraum)
 */
export function buildMask(gray, width, height, { grid, whiteThreshold, occupiedRatio, fillHoles = true }) {
    const { cols, rows } = gridDims(width, height, grid);
    const n = cols * rows;
    const count = new Uint32Array(n);
    const minX = new Int32Array(n).fill(width), maxX = new Int32Array(n).fill(-1);
    const minY = new Int32Array(n).fill(height), maxY = new Int32Array(n).fill(-1);
    const colOf = new Uint16Array(width);
    for (let x = 0; x < width; x++) colOf[x] = Math.min(cols - 1, Math.floor(x * cols / width));

    for (let y = 0; y < height; y++) {
        const rowBase = Math.min(rows - 1, Math.floor(y * rows / height)) * cols;
        const off = y * width;
        for (let x = 0; x < width; x++) {
            if (gray[off + x] >= whiteThreshold) continue;
            const i = rowBase + colOf[x];
            count[i]++;
            if (x < minX[i]) minX[i] = x;
            if (x > maxX[i]) maxX[i] = x;
            if (y < minY[i]) minY[i] = y;
            if (y > maxY[i]) maxY[i] = y;
        }
    }

    const cellBox = i => {
        const r = Math.floor(i / cols), c = i % cols;
        return [Math.floor(c * width / cols), Math.floor(r * height / rows),
            Math.floor((c + 1) * width / cols), Math.floor((r + 1) * height / rows)];
    };
    const occ = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const [x0, y0, x1, y1] = cellBox(i);
        occ[i] = count[i] / Math.max(1, (x1 - x0) * (y1 - y0)) > occupiedRatio ? 1 : 0;
    }
    // Vom Rand nicht erreichbare freie Zellen (z. B. weiße Schnürsenkel/Sohle) gehören zum Motiv
    const holes = fillHoles ? enclosedFreeCells(occ, cols, rows) : new Uint8Array(n);

    const maskRows = [];
    const cells = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (occ[i]) {
                line += '#';
                cells.push([r, c,
                    round(minX[i] / width, 5), round(minY[i] / height, 5),
                    round((maxX[i] + 1) / width, 5), round((maxY[i] + 1) / height, 5)]);
            } else if (holes[i]) {
                line += '#';
                const [x0, y0, x1, y1] = cellBox(i);
                cells.push([r, c, round(x0 / width, 5), round(y0 / height, 5), round(x1 / width, 5), round(y1 / height, 5)]);
            } else {
                line += '.';
            }
        }
        maskRows.push(line);
    }
    return { cols, rows, maskRows, cells };
}

/** Freie Zellen ohne 4er-Verbindung zum Rasterrand. */
function enclosedFreeCells(occ, cols, rows) {
    const n = cols * rows;
    const reached = new Uint8Array(n);
    const stack = [];
    const push = i => { if (!occ[i] && !reached[i]) { reached[i] = 1; stack.push(i); } };
    for (let c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
    for (let r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
    while (stack.length) {
        const i = stack.pop(), r = Math.floor(i / cols), c = i % cols;
        if (r > 0) push(i - cols);
        if (r < rows - 1) push(i + cols);
        if (c > 0) push(i - 1);
        if (c < cols - 1) push(i + 1);
    }
    const holes = new Uint8Array(n);
    for (let i = 0; i < n; i++) holes[i] = !occ[i] && !reached[i] ? 1 : 0;
    return holes;
}

/** Größe, ab der vor der Analyse verkleinert wird (längere Seite in px). */
function analysisSize(grid) {
    return Math.max(1024, grid * 16);
}

let sharpModule;
async function loadSharp() {
    if (sharpModule === undefined) {
        try { sharpModule = (await import('sharp')).default; }
        catch { sharpModule = null; }
    }
    return sharpModule;
}

/**
 * Lädt ein Bild als Graustufen-Rohpixel (Alpha auf Weiß geflattet,
 * ggf. verkleinert). Wirft { code: 'unsupported' } bei nicht lesbaren Formaten.
 * Mit saturation: true wird RGB dekodiert und zusätzlich `sat` (max−min je
 * Pixel, 0..255) geliefert; gray dann per Rec.-709-Luma (wie libvips).
 */
export async function loadGray(filePath, maxSide = 1024, { saturation = false } = {}) {
    const sharp = await loadSharp();
    if (!sharp) throw Object.assign(new Error('Image library "sharp" is not installed'), { code: 'unsupported' });
    let meta;
    try {
        meta = await sharp(filePath, { failOn: 'none', limitInputPixels: false }).metadata();
    } catch (e) {
        throw Object.assign(new Error(`Unsupported or unreadable image format: ${e.message}`), { code: 'unsupported' });
    }
    const pipeline = sharp(filePath, { failOn: 'none', limitInputPixels: false })
        .flatten({ background: '#ffffff' })
        .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    let gray, sat = null, info;
    if (saturation) {
        const out = await pipeline.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        info = out.info;
        if (info.channels !== 3) throw new Error(`Unexpected channel count ${info.channels}`);
        const n = info.width * info.height, d = out.data;
        gray = new Uint8Array(n);
        sat = new Uint8Array(n);
        for (let i = 0, j = 0; i < n; i++, j += 3) {
            const R = d[j], G = d[j + 1], B = d[j + 2];
            gray[i] = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B);
            sat[i] = Math.max(R, G, B) - Math.min(R, G, B);
        }
    } else {
        const out = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
        info = out.info;
        if (info.channels !== 1) throw new Error(`Unexpected channel count ${info.channels}`);
        gray = out.data;
    }
    return {
        gray,
        ...(sat ? { sat } : {}),
        width: info.width,
        height: info.height,
        pixelWidth: meta.width,
        pixelHeight: meta.height,
        format: meta.format,
        orientation: meta.orientation ?? 1,
    };
}

function cacheKey(p) {
    return `g${p.grid}_w${p.whiteThreshold}_o${p.occupiedRatio}${p.fillHoles ? '_f' : ''}`;
}

/**
 * Normierte Motivmaske eines Bildes, mit Cache (Speicher + Sidecar-JSON
 * `<datei>.freespace.json`). Ist der Ordner nicht beschreibbar, wird ohne
 * Sidecar weitergearbeitet.
 * @returns {Promise<object>} { pixelWidth, pixelHeight, format, orientation, cols, rows, maskRows, cells, cache }
 */
export async function getMotifMask(filePath, params, { useCache = true } = {}) {
    const p = normalizeMaskParams(params);
    const stat = await fs.stat(filePath);
    const key = cacheKey(p);
    const sidecar = `${filePath}.freespace.json`;
    const memKey = `${filePath}|${stat.size}|${stat.mtimeMs}|${key}`;

    if (useCache) {
        if (memoryCache.has(memKey)) return { ...memoryCache.get(memKey), cache: 'memory' };
        try {
            const json = JSON.parse(await fs.readFile(sidecar, 'utf8'));
            if (json.version === MASK_VERSION && json.fileSize === stat.size
                && json.mtimeMs === stat.mtimeMs && json.entries?.[key]) {
                const mask = { ...json.image, ...json.entries[key] };
                memoryCache.set(memKey, mask);
                return { ...mask, cache: 'sidecar' };
            }
        } catch { /* kein oder veralteter Sidecar */ }
    }

    const img = await loadGray(filePath, analysisSize(p.grid));
    const image = { pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight, format: img.format, orientation: img.orientation };
    const entry = buildMask(img.gray, img.width, img.height, p);
    const mask = { ...image, ...entry };
    memoryCache.set(memKey, mask);

    let cache = 'computed';
    if (useCache) {
        try {
            let json = null;
            try { json = JSON.parse(await fs.readFile(sidecar, 'utf8')); } catch { /* neu anlegen */ }
            if (!json || json.version !== MASK_VERSION || json.fileSize !== stat.size || json.mtimeMs !== stat.mtimeMs) {
                json = { version: MASK_VERSION, fileSize: stat.size, mtimeMs: stat.mtimeMs, image, entries: {} };
            }
            json.entries[key] = entry;
            await fs.writeFile(sidecar, JSON.stringify(json));
            cache = 'computed+saved';
        } catch { /* Link-Ordner nicht beschreibbar */ }
    }
    return { ...mask, cache };
}

// ---------------------------------------------------------------- Geometrie

/** Schnittrechteck oder null. */
export function intersectRect(a, b) {
    const r = {
        top: Math.max(a.top, b.top), left: Math.max(a.left, b.left),
        bottom: Math.min(a.bottom, b.bottom), right: Math.min(a.right, b.right),
    };
    return r.top < r.bottom && r.left < r.right ? r : null;
}

/** InDesign-geometricBounds [top, left, bottom, right] → Rechteck. */
export function boundsToRect(b) {
    return { top: b[0], left: b[1], bottom: b[2], right: b[3] };
}

/** Rechteck → [top, left, bottom, right] (gerundet auf 0,1 mm), null bleibt null. */
export function rectToArray(r, f = r1) {
    return r ? [f(r.top), f(r.left), f(r.bottom), f(r.right)] : null;
}

/** Umschließendes Rechteck; null-Einträge werden ignoriert, leer → null. */
export function unionRect(rects) {
    rects = rects.filter(Boolean);
    if (!rects.length) return null;
    return rects.reduce((u, r) => ({
        top: Math.min(u.top, r.top), left: Math.min(u.left, r.left),
        bottom: Math.max(u.bottom, r.bottom), right: Math.max(u.right, r.right),
    }));
}

/**
 * Platzierung aus InDesign-Geometrie (mm): Clip = Rahmen ∩ Seite,
 * Spiegelung aus String(image.absoluteFlip).
 * @param {{imageBounds:number[], frameBounds:number[], pageBounds?:number[]|null, flip?:string}} g
 * @returns {{imageBounds:number[], flipH:boolean, flipV:boolean, clip:number[]}}
 */
export function placementFromGeometry({ imageBounds, frameBounds, pageBounds = null, flip = '' }) {
    const f = String(flip || '').toUpperCase();
    const both = f.includes('BOTH') || f.includes('HORIZONTAL_AND_VERTICAL');
    const flipH = both || /(^|\.)HORIZONTAL$/.test(f);
    const flipV = both || /(^|\.)VERTICAL$/.test(f);
    const frameRect = boundsToRect(frameBounds);
    const clip = pageBounds ? intersectRect(frameRect, boundsToRect(pageBounds)) : frameRect;
    return { imageBounds, flipH, flipV, clip: clip ? [clip.top, clip.left, clip.bottom, clip.right] : [0, 0, 0, 0] };
}

/**
 * Motivrechtecke (mm) einer platzierten Maske, standardmäßig nur der
 * sichtbare Teil – Eingabe für checkRect().
 */
export function motifRects(placed, { visibleOnly = true } = {}) {
    return placed.cells.map(c => (visibleOnly ? c.visible : c.rect)).filter(Boolean);
}

/**
 * Bildet normierte Bildkoordinaten auf Seiten-mm ab.
 * @param {object} placement { imageBounds:[t,l,b,r], flipH, flipV }
 */
export function makeNormToPage({ imageBounds, flipH = false, flipV = false }) {
    const [t, l, b, rr] = imageBounds;
    const w = rr - l, h = b - t;
    return (x0, y0, x1, y1) => {
        const xa = flipH ? 1 - x1 : x0, xb = flipH ? 1 - x0 : x1;
        const ya = flipV ? 1 - y1 : y0, yb = flipV ? 1 - y0 : y1;
        return { top: t + ya * h, left: l + xa * w, bottom: t + yb * h, right: l + xb * w };
    };
}

/**
 * Maske in Seitenkoordinaten: Motivzellen als mm-Rechtecke (voll und
 * beschnitten auf clip), Zeilen-/Spaltenindex in Seitenorientierung.
 */
export function placeMask(mask, placement) {
    const toPage = makeNormToPage(placement);
    const { cols, rows } = mask;
    const clip = placement.clip ? boundsToRect(placement.clip) : null;
    const cells = mask.cells.map(([r, c, x0, y0, x1, y1]) => {
        const rect = toPage(x0, y0, x1, y1);
        return {
            row: placement.flipV ? rows - 1 - r : r,
            col: placement.flipH ? cols - 1 - c : c,
            rect,
            visible: clip ? intersectRect(rect, clip) : rect,
        };
    });
    return { cols, rows, clip, cells, toPage };
}

/**
 * Pro Rasterzeile: [top, bottom, l1, r1, l2, r2, …] der sichtbaren
 * Motivteile in mm. Läufe mit höchstens einer freien Zelle dazwischen werden
 * zusammengefasst; leere Zeilen entfallen.
 */
export function rowSpans(placed, { visibleOnly = true } = {}) {
    const byRow = new Map();
    for (const cell of placed.cells) {
        const rect = visibleOnly ? cell.visible : cell.rect;
        if (!rect) continue;
        if (!byRow.has(cell.row)) byRow.set(cell.row, []);
        byRow.get(cell.row).push({ col: cell.col, rect });
    }
    const spans = [];
    for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
        const items = byRow.get(row).sort((a, b) => a.col - b.col);
        const runs = [];
        for (const it of items) {
            const last = runs[runs.length - 1];
            if (last && it.col - last.col <= 2) {
                last.col = it.col;
                last.left = Math.min(last.left, it.rect.left);
                last.right = Math.max(last.right, it.rect.right);
            } else {
                runs.push({ col: it.col, left: it.rect.left, right: it.rect.right });
            }
        }
        const top = Math.min(...items.map(i => i.rect.top));
        const bottom = Math.max(...items.map(i => i.rect.bottom));
        spans.push([r1(top), r1(bottom), ...runs.flatMap(rn => [r1(rn.left), r1(rn.right)])]);
    }
    return spans;
}

/** Maskenzeilen in Seitenorientierung (Spiegelungen angewandt). */
export function orientedMaskRows(mask, { flipH = false, flipV = false } = {}) {
    let rowsArr = flipV ? [...mask.maskRows].reverse() : [...mask.maskRows];
    if (flipH) rowsArr = rowsArr.map(s => [...s].reverse().join(''));
    return rowsArr;
}

/**
 * Größte freie Rechtecke (Zellraster, Seitenorientierung) innerhalb des
 * sichtbaren Bildbereichs, in mm (auf den Clip beschnitten). Zellen gelten als
 * verfügbar, wenn frei und zumindest teilweise sichtbar. Greedy, überlappungsfrei.
 */
export function largestFreeRects(placed, placement, { count = 3, minCells = 4 } = {}) {
    const { cols, rows, clip } = placed;
    const [t, l, b, rr] = placement.imageBounds;
    const cw = (rr - l) / cols, ch = (b - t) / rows;
    const cellRect = (r, c) => ({ top: t + r * ch, left: l + c * cw, bottom: t + (r + 1) * ch, right: l + (c + 1) * cw });
    const avail = Array.from({ length: rows }, () => new Uint8Array(cols).fill(1));
    for (const cell of placed.cells) avail[cell.row][cell.col] = 0;
    if (clip) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            if (!intersectRect(cellRect(r, c), clip)) avail[r][c] = 0;
        }
    }

    const result = [];
    for (let k = 0; k < count; k++) {
        const best = maxRectangle(avail, rows, cols);
        if (!best || best.area < minCells) break;
        for (let r = best.r0; r <= best.r1; r++) for (let c = best.c0; c <= best.c1; c++) avail[r][c] = 0;
        let rect = {
            top: t + best.r0 * ch, left: l + best.c0 * cw,
            bottom: t + (best.r1 + 1) * ch, right: l + (best.c1 + 1) * cw,
        };
        if (clip) rect = intersectRect(rect, clip) ?? rect;
        result.push({ bounds: rectToArray(rect), width: r1(rect.right - rect.left), height: r1(rect.bottom - rect.top) });
    }
    return result;
}

/** Größtes Rechteck aus Einsen (Histogramm-Verfahren). */
function maxRectangle(grid, rows, cols) {
    const heights = new Array(cols).fill(0);
    let best = null;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) heights[c] = grid[r][c] ? heights[c] + 1 : 0;
        const stack = [];
        for (let c = 0; c <= cols; c++) {
            const h = c < cols ? heights[c] : 0;
            let start = c;
            while (stack.length && stack[stack.length - 1].h >= h) {
                const top = stack.pop();
                const area = top.h * (c - top.start);
                if (top.h > 0 && (!best || area > best.area)) {
                    best = { area, r0: r - top.h + 1, r1: r, c0: top.start, c1: c - 1 };
                }
                start = top.start;
            }
            stack.push({ h, start });
        }
    }
    return best;
}

/** Euklidischer Abstand zweier achsparalleler Rechtecke (0 bei Berührung/Überlappung). */
export function rectDistance(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
}

/** Länge der Vereinigung von Intervallen [a, b]. */
function unionLength(intervals) {
    const s = intervals.slice().sort((p, q) => p[0] - q[0]);
    let total = 0, cur = null;
    for (const [a, b] of s) {
        if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; }
        else cur[1] = Math.max(cur[1], b);
    }
    if (cur) total += cur[1] - cur[0];
    return total;
}

/**
 * Prüft ein Rechteck gegen Motivrechtecke (sichtbarer Teil).
 * @returns {{ collides:boolean, distance:number|null, overlapX?:number, overlapY?:number, motifX?:number[] }}
 *   distance: minimaler Abstand zum Motiv (0 bei Überlappung), null ohne Motiv.
 *   overlapX/overlapY: vom Motiv überdeckte Länge innerhalb des Rechtecks
 *   (horizontal bzw. vertikal); motifX: x-Bereich des Motivs im Rechteckband.
 */
export function checkRect(rect, motifRects, minGap = 0) {
    let distance = null;
    const hitsX = [], hitsY = [];
    let mxMin = Infinity, mxMax = -Infinity;
    for (const m of motifRects) {
        const d = rectDistance(rect, m);
        if (distance === null || d < distance) distance = d;
        if (d < minGap || (minGap === 0 && intersectRect(rect, m))) {
            const ix = [Math.max(rect.left, m.left), Math.min(rect.right, m.right)];
            const iy = [Math.max(rect.top, m.top), Math.min(rect.bottom, m.bottom)];
            if (ix[1] > ix[0]) hitsX.push(ix);
            if (iy[1] > iy[0]) hitsY.push(iy);
            mxMin = Math.min(mxMin, m.left); mxMax = Math.max(mxMax, m.right);
        }
    }
    const collides = mxMax > -Infinity;
    if (!collides) return { collides, distance: distance === null ? null : r1(distance) };
    return {
        collides,
        distance: r1(distance),
        overlapX: r1(unionLength(hitsX)),
        overlapY: r1(unionLength(hitsY)),
        motifX: [r1(mxMin), r1(mxMax)],
    };
}

/**
 * Auflösungsreserven bis 200 ppi (bezogen auf die aktuelle Bildgröße).
 */
export function resolutionInfo(mask, imageBounds, targetPpi = 200) {
    const w = imageBounds[3] - imageBounds[1], h = imageBounds[2] - imageBounds[0];
    const maxW = mask.pixelWidth / targetPpi * MM_PER_INCH;
    const maxH = mask.pixelHeight / targetPpi * MM_PER_INCH;
    return {
        maxWidthMmAt200dpi: r1(maxW),
        maxHeightMmAt200dpi: r1(maxH),
        maxScaleFactorAt200dpi: round(Math.min(maxW / w, maxH / h), 3),
    };
}
