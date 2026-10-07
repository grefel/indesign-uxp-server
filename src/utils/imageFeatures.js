/**
 * Bildmerkmale für die Layout-Ausrichtung: Schwerpunkt, Fokus (Saliency),
 * Hauptachse, Standlinie, gerade Kanten (Sobel + Hough), äußere Motivkanten
 * und Blickrichtung – reine Pixelanalyse auf dem verkleinerten Graubild.
 *
 * computeImageFeatures() liefert platzierungsunabhängige Werte im Bildraum
 * (normiert 0..1, Dateiorientierung); sie werden im Sidecar
 * `<datei>.freespace.json` unter `features` gecacht. placeFeatures() rechnet
 * sie für die aktuelle Platzierung (Spiegelung, Clip) in Seiten-mm um.
 *
 * Winkel: Grad, 0 = horizontal, positiv = gegen den Uhrzeigersinn (nach
 * rechts steigend) wie InDesign-Drehwinkel, Bereich (−90, 90].
 */
import { promises as fs } from 'fs';
import { loadGray, MASK_VERSION, makeNormToPage, boundsToRect, rectToArray, r1 } from './imageMask.js';

export const FEATURES_VERSION = 1;
export const FEATURES_SIZE = 512;
const memoryCache = new Map();

const clamp01 = v => Math.max(0, Math.min(1, v));
const rd = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d + 0;
const DEG = 180 / Math.PI;
/** Ganzzahliger Winkel ohne −0. */
const deg = v => Math.round(v) + 0;

/** Parameter prüfen und Defaults setzen. */
export function normalizeFeatureParams({ whiteThreshold = 250, axisTolerance = 5, maxEdges = 6 } = {}) {
    const w = Number(whiteThreshold), t = Number(axisTolerance), m = Number(maxEdges);
    if (!Number.isFinite(w) || w < 1 || w > 255) throw new Error(`whiteThreshold must be 1..255, got: ${JSON.stringify(whiteThreshold)}`);
    if (!Number.isFinite(t) || t < 0 || t > 30) throw new Error(`axisTolerance must be 0..30 degrees, got: ${JSON.stringify(axisTolerance)}`);
    if (!Number.isInteger(m) || m < 0 || m > 12) throw new Error(`maxEdges must be an integer 0..12, got: ${JSON.stringify(maxEdges)}`);
    return { whiteThreshold: w, axisTolerance: t, maxEdges: m };
}

// ---------------------------------------------------------------- Maske

/** Binäre Box-Dilatation/-Erosion (separabel, Rand neutral). */
function morph(src, w, h, r, dilate) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const pass = (get, set, len, lines) => {
        const pre = new Int32Array(len + 1);
        for (let l = 0; l < lines; l++) {
            for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + get(l, i);
            for (let i = 0; i < len; i++) {
                const a = Math.max(0, i - r), b = Math.min(len - 1, i + r);
                const s = pre[b + 1] - pre[a];
                set(l, i, dilate ? (s > 0 ? 1 : 0) : (s === b - a + 1 ? 1 : 0));
            }
        }
    };
    pass((y, x) => src[y * w + x], (y, x, v) => { tmp[y * w + x] = v; }, w, h);
    pass((x, y) => tmp[y * w + x], (x, y, v) => { out[y * w + x] = v; }, h, w);
    return out;
}

/**
 * Motivmaske je Pixel: Luminanz < whiteThreshold, morphologisch geschlossen
 * (überbrückt feine Lücken in Konturen) und mit gefüllten Löchern (weiße
 * Flächen innerhalb des Motivs, z. B. Sohle, Schnürsenkel).
 */
export function motifPixelMask(gray, w, h, { whiteThreshold = 250, closeRadius = null } = {}) {
    const raw = new Uint8Array(w * h);
    for (let i = 0; i < raw.length; i++) raw[i] = gray[i] < whiteThreshold ? 1 : 0;
    const r = closeRadius ?? Math.max(1, Math.round(Math.max(w, h) * 0.006));
    const mask = morph(morph(raw, w, h, r, true), w, h, r, false);
    // Löcher füllen: vom Rand erreichbarer Hintergrund bleibt frei
    const reached = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const push = i => { if (!mask[i] && !reached[i]) { reached[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
        const i = stack[--sp], x = i % w;
        if (i >= w) push(i - w);
        if (i < (h - 1) * w) push(i + w);
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
    }
    for (let i = 0; i < mask.length; i++) if (!mask[i] && !reached[i]) mask[i] = 1;
    return mask;
}

/** BBox der Maske in Pixeln [x0, y0, x1, y1] (exklusiv) oder null. */
export function maskBBox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const off = y * w;
        for (let x = 0; x < w; x++) {
            if (!mask[off + x]) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// ---------------------------------------------------------------- Schwerpunkt, Achse, Richtung

/** Schwerpunkt gewichtet mit Tinte (1 − Luminanz), nur Motivpixel. Pixelkoordinaten. */
export function inkCentroid(gray, w, h, whiteThreshold = 250) {
    let s = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) {
        const off = y * w;
        for (let x = 0; x < w; x++) {
            const g = gray[off + x];
            if (g >= whiteThreshold) continue;
            const m = (255 - g) / 255;
            s += m; sx += m * (x + 0.5); sy += m * (y + 0.5);
        }
    }
    return s ? [sx / s, sy / s] : null;
}

/**
 * Hauptachse per PCA der Maskenpixel (Pixelraum, seitenverhältnistreu).
 * @returns {{c:number[], u:number[], tMin:number, tMax:number, l1:number, l2:number, ecc:number}|null}
 */
export function principalAxis(mask, w, h) {
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; sx += i % w + 0.5; sy += Math.floor(i / w) + 0.5; }
    if (n < 3) return null;
    const cx = sx / n, cy = sy / n;
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const dx = i % w + 0.5 - cx, dy = Math.floor(i / w) + 0.5 - cy;
        xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    xx /= n; yy /= n; xy /= n;
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
    const tr = (xx + yy) / 2, det = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
    const l1 = tr + det, l2 = Math.max(0, tr - det);
    const u = [Math.cos(theta), Math.sin(theta)];
    let tMin = Infinity, tMax = -Infinity;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const t = (i % w + 0.5 - cx) * u[0] + (Math.floor(i / w) + 0.5 - cy) * u[1];
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
    }
    return { c: [cx, cy], u, tMin, tMax, l1, l2, ecc: l1 > 0 ? Math.sqrt(1 - l2 / l1) : 0 };
}

/**
 * Blick-/Bewegungsrichtung: Entlang der Hauptachse wird die Maskenmasse der
 * beiden äußeren Viertel verglichen; das schmalere (spitzere) Ende gilt als
 * Richtung. Confidence sinkt bei geringer Asymmetrie und rundlichen Motiven.
 * @returns {{v:number[]|null, conf:number}} v = Einheitsvektor im Pixelraum
 */
export function motifDirection(mask, w, h, axis) {
    if (!axis || axis.tMax - axis.tMin < 4) return { v: null, conf: 0 };
    const bins = 20, prof = new Float64Array(bins);
    const span = axis.tMax - axis.tMin;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const t = (i % w + 0.5 - axis.c[0]) * axis.u[0] + (Math.floor(i / w) + 0.5 - axis.c[1]) * axis.u[1];
        prof[Math.min(bins - 1, Math.floor((t - axis.tMin) / span * bins))]++;
    }
    let a = 0, b = 0;
    for (let k = 0; k < 5; k++) { a += prof[k]; b += prof[bins - 1 - k]; }
    if (a + b === 0) return { v: null, conf: 0 };
    const asym = Math.abs(a - b) / (a + b);
    const conf = clamp01(asym * 1.6) * clamp01((axis.ecc - 0.3) / 0.5);
    const sign = a < b ? -1 : 1;
    return { v: [axis.u[0] * sign, axis.u[1] * sign], conf };
}

// ---------------------------------------------------------------- Standlinie

/**
 * Standlinie: Gerade durch die unterste Motivkante je Spalte. Untere
 * Tangente je Winkel (±maxAngle), gewählt nach Stützung mit Vorzug flacher
 * Winkel, dann Kleinste-Quadrate auf den Stützpunkten. Nur plausible Linien (flach, Stützung ≥ minQuality der
 * Motivspalten über ≥ minSpan der Motivbreite, höchstens 10 % der Spalten
 * reichen tiefer) werden geliefert. Bei perspektivischen Motiven trägt oft nur
 * ein Teil der Unterkante (quality dann niedrig, aber > 0.2).
 * @returns {{p0:number[], p1:number[], x0:number, x1:number, quality:number}|null} Pixelraum
 */
export function groundLine(mask, w, h, bbox, { maxAngle = 10, minQuality = 0.2, minSpan = 0.2 } = {}) {
    if (!bbox) return null;
    const [bx0, , bx1] = bbox;
    const xs = [], ys = [];
    for (let x = bx0; x < bx1; x++) {
        for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { xs.push(x + 0.5); ys.push(y + 1); break; }
    }
    const n = xs.length;
    if (n < 10) return null;
    const tol = Math.max(1.5, h * 0.008);
    // Je Winkel die untere Tangente (3 % Ausreißer erlaubt), bewertet nach Stützung; flache Winkel bevorzugt
    const nOut = Math.floor(n * 0.03);
    let best = null;
    for (let a = -maxAngle; a <= maxAngle + 1e-9; a += 0.5) {
        const k = Math.tan(-a / DEG);
        const v = xs.map((x, i) => ys[i] - k * x).sort((p, q) => q - p);
        const d = v[nOut];
        let cnt = 0;
        for (let i = 0; i < n; i++) if (Math.abs(ys[i] - k * xs[i] - d) <= tol) cnt++;
        const score = cnt * (1 - 0.5 * Math.abs(a) / maxAngle);
        if (!best || score > best.score) best = { score, k, d };
    }
    let { k, d } = best;
    let inl = [];
    for (let it = 0; it < 3; it++) {
        inl = [];
        for (let i = 0; i < n; i++) if (Math.abs(ys[i] - (k * xs[i] + d)) <= tol) inl.push(i);
        if (inl.length < 5) return null;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const i of inl) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
        const m = inl.length, den = m * sxx - sx * sx;
        if (Math.abs(den) < 1e-9) return null;
        k = (m * sxy - sx * sy) / den;
        d = (sy - k * sx) / m;
    }
    const quality = inl.length / n;
    const ix0 = xs[inl[0]] - 0.5, ix1 = xs[inl[inl.length - 1]] + 0.5;
    let below = 0;
    for (let i = 0; i < n; i++) if (ys[i] > k * xs[i] + d + tol) below++;
    const angle = -Math.atan(k) * DEG;
    if (Math.abs(angle) > maxAngle || quality < minQuality || (ix1 - ix0) < minSpan * (bx1 - bx0) || below / n > 0.1) return null;
    return { p0: [bx0, k * bx0 + d], p1: [bx1, k * bx1 + d], x0: ix0, x1: ix1, quality };
}

// ---------------------------------------------------------------- Kanten

/** Sobel-Gradienten (Ränder 0). */
export function sobel(gray, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const a = gray[i - w - 1], b = gray[i - w], c = gray[i - w + 1];
            const d = gray[i - 1], f = gray[i + 1];
            const g = gray[i + w - 1], hh = gray[i + w], k = gray[i + w + 1];
            const sx = (c + 2 * f + k) - (a + 2 * d + g);
            const sy = (g + 2 * hh + k) - (a + 2 * b + c);
            gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
        }
    }
    return { gx, gy, mag };
}

/**
 * Gerade Kantensegmente: Kantenpixel (Sobel ≥ threshold, Non-Maximum-
 * Suppression) stimmen orientierungsbeschränkt in einem Hough-Raum ab;
 * iterativ wird das stärkste Maximum genommen, entlang der Geraden der längste
 * Lauf mit kleinen Lücken bestimmt, per PCA verfeinert und seine Pixel
 * aus dem Akkumulator entfernt.
 * @returns {Array<{p0:number[], p1:number[], len:number, strength:number}>} Pixelraum, nach len·strength sortiert
 */
export function houghSegments(sob, w, h, { threshold = 100, minLen = null, maxGap = null, max = 12, angleWindow = 6 } = {}) {
    const { gx, gy, mag } = sob;
    minLen ??= Math.max(10, Math.min(w, h) * 0.06);
    maxGap ??= Math.max(3, Math.max(w, h) * 0.012);
    const bandDist = Math.max(3, Math.min(w, h) * 0.015);
    const ex = [], ey = [], ephi = [], emag = [];
    for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
            const i = y * w + x, m = mag[i];
            if (m < threshold) continue;
            // Non-Maximum-Suppression entlang der quantisierten Gradientenrichtung
            const ang = (Math.atan2(gy[i], gx[i]) * DEG + 180) % 180;
            let o;
            if (ang < 22.5 || ang >= 157.5) o = 1;
            else if (ang < 67.5) o = w + 1;
            else if (ang < 112.5) o = w;
            else o = w - 1;
            if (m < mag[i - o] || m < mag[i + o]) continue;
            ex.push(x + 0.5); ey.push(y + 0.5); ephi.push(ang); emag.push(m);
        }
    }
    const ne = ex.length;
    if (!ne) return [];
    const diag = Math.ceil(Math.hypot(w, h));
    const nR = 2 * diag + 1, acc = new Int32Array(180 * nR);
    const cosT = new Float64Array(180), sinT = new Float64Array(180);
    for (let t = 0; t < 180; t++) { cosT[t] = Math.cos(t / DEG); sinT[t] = Math.sin(t / DEG); }
    const vote = (i, s) => {
        const p = Math.round(ephi[i]);
        for (let d = -angleWindow; d <= angleWindow; d++) {
            let t = p + d, x = ex[i], y = ey[i];
            let sign = 1;
            if (t < 0) { t += 180; sign = -1; } else if (t >= 180) { t -= 180; sign = -1; }
            const rho = Math.round(sign * (x * cosT[t] + y * sinT[t])) + diag;
            acc[t * nR + rho] += s;
        }
    };
    const used = new Uint8Array(ne);
    for (let i = 0; i < ne; i++) vote(i, 1);

    const segs = [];
    for (let iter = 0; iter < max * 4 && segs.length < max; iter++) {
        let bi = 0;
        for (let j = 1; j < acc.length; j++) if (acc[j] > acc[bi]) bi = j;
        if (acc[bi] < minLen * 0.5) break;
        const t = Math.floor(bi / nR), rho = bi % nR - diag;
        const c = cosT[t], s = sinT[t];
        const near = [];
        for (let i = 0; i < ne; i++) {
            if (used[i]) continue;
            if (Math.abs(ex[i] * c + ey[i] * s - rho) > 1.5) continue;
            const da = Math.abs(ephi[i] - t);
            if (Math.min(da, 180 - da) > 12) continue;
            near.push(i);
        }
        if (!near.length) { acc[bi] = 0; continue; }
        // Längster Lauf entlang der Geraden (Richtung (−sin, cos))
        const tp = near.map(i => ({ i, t: -ex[i] * s + ey[i] * c })).sort((a, b) => a.t - b.t);
        let bestRun = [0, 0], start = 0;
        for (let k = 1; k <= tp.length; k++) {
            if (k === tp.length || tp[k].t - tp[k - 1].t > maxGap) {
                if (tp[k - 1].t - tp[start].t > tp[bestRun[1]].t - tp[bestRun[0]].t) bestRun = [start, k - 1];
                start = k;
            }
        }
        const run = tp.slice(bestRun[0], bestRun[1] + 1).map(p => p.i);
        const runLen = tp[bestRun[1]].t - tp[bestRun[0]].t;
        const remove = runLen >= minLen ? run : near;
        for (const i of remove) { used[i] = 1; vote(i, -1); }
        if (runLen < minLen || run.length < minLen * 0.5) continue;
        // PCA-Verfeinerung
        let mx = 0, my = 0, sm = 0;
        for (const i of run) { mx += ex[i]; my += ey[i]; sm += emag[i]; }
        mx /= run.length; my /= run.length;
        let xx = 0, yy = 0, xy = 0;
        for (const i of run) { const dx = ex[i] - mx, dy = ey[i] - my; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
        const th = 0.5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(th), uy = Math.sin(th);
        let a0 = Infinity, a1 = -Infinity;
        for (const i of run) { const q = (ex[i] - mx) * ux + (ey[i] - my) * uy; if (q < a0) a0 = q; if (q > a1) a1 = q; }
        const seg = {
            p0: [mx + a0 * ux, my + a0 * uy], p1: [mx + a1 * ux, my + a1 * uy],
            len: a1 - a0,
            strength: clamp01(sm / run.length / 1020),
        };
        // Eng benachbarte, überlappende Parallele (Doppelkante, schmales Band) nur einmal
        const dup = segs.some(o => {
            const oa = Math.atan2(o.p1[1] - o.p0[1], o.p1[0] - o.p0[0]);
            let dA = Math.abs(oa - th) % Math.PI; dA = Math.min(dA, Math.PI - dA);
            if (dA > 4 / DEG) return false;
            const ox = Math.cos(oa), oy = Math.sin(oa);
            if (Math.abs((mx - o.p0[0]) * -oy + (my - o.p0[1]) * ox) > bandDist) return false;
            const q = p => (p[0] - o.p0[0]) * ox + (p[1] - o.p0[1]) * oy;
            const [s0, s1] = [q(seg.p0), q(seg.p1)].sort((a, b) => a - b);
            return Math.min(s1, o.len) - Math.max(s0, 0) > 0.3 * Math.min(seg.len, o.len);
        });
        if (!dup) segs.push(seg);
    }
    return segs.sort((a, b) => b.len * b.strength - a.len * a.strength);
}

// ---------------------------------------------------------------- Extremkanten

/**
 * Äußere Motivkanten. „hard“, wenn die Kante über einen zusammenhängenden
 * Abschnitt ≥ 15 % der Motivausdehnung auf (fast) derselben Koordinate liegt
 * (achsparallele gerade Kante), sonst nur ein Punkt (z. B. Spitze, Rundung).
 * @returns {object} { left|right|top|bottom: { v, hard, span:[a,b] } } Pixelraum
 */
export function motifExtremes(mask, w, h, bbox) {
    if (!bbox) return null;
    const [x0, y0, x1, y1] = bbox;
    const side = (len, lines, edge, cmp, tolPx, extent) => {
        // edge(l) = äußerste Motivkoordinate in Zeile/Spalte l (oder null)
        let best = null;
        for (let l = 0; l < lines; l++) {
            const e = edge(l);
            if (e !== null && (best === null || cmp(e, best))) best = e;
        }
        let run = [0, -1], s = -1, gap = 0, last = -1;
        for (let l = 0; l <= lines; l++) {
            const e = l < lines ? edge(l) : null;
            const hit = e !== null && Math.abs(e - best) <= tolPx;
            if (hit) { if (s < 0) s = l; last = l; gap = 0; }
            else if (s >= 0 && ++gap > 2) {
                if (last - s > run[1] - run[0]) run = [s, last];
                s = -1; gap = 0;
            }
        }
        if (s >= 0 && last - s > run[1] - run[0]) run = [s, last];
        const runLen = run[1] - run[0] + 1;
        return { v: best, hard: runLen >= Math.max(4, extent * 0.15), span: [run[0], run[1] + 1] };
    };
    const tolX = Math.max(1.5, w * 0.006), tolY = Math.max(1.5, h * 0.006);
    const rowEdge = (y, fromLeft) => {
        if (fromLeft) { for (let x = 0; x < w; x++) if (mask[y * w + x]) return x; }
        else { for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) return x + 1; }
        return null;
    };
    const colEdge = (x, fromTop) => {
        if (fromTop) { for (let y = 0; y < h; y++) if (mask[y * w + x]) return y; }
        else { for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) return y + 1; }
        return null;
    };
    return {
        left: side(w, h, y => rowEdge(y, true), (a, b) => a < b, tolX, y1 - y0),
        right: side(w, h, y => rowEdge(y, false), (a, b) => a > b, tolX, y1 - y0),
        top: side(h, w, x => colEdge(x, true), (a, b) => a < b, tolY, x1 - x0),
        bottom: side(h, w, x => colEdge(x, false), (a, b) => a > b, tolY, x1 - x0),
    };
}

// ---------------------------------------------------------------- Saliency / Fokus

/**
 * Interessenzentrum: Blockweise Kantendichte, lokale Helligkeitsstreuung und
 * Farbsättigung, gewichtet mit Motivanteil und mildem Center-Bias um den
 * Motivschwerpunkt, geglättet. Fokusregion = zusammenhängende Top-10-%-Blöcke
 * um das Maximum, Punkt = deren gewichteter Schwerpunkt.
 * confidence: Konzentration der Saliency in der Region (Lift gegenüber
 * Gleichverteilung) × Anteil der Region an allen Top-Blöcken.
 * @returns {{pt:number[], region:number[], conf:number}|null} Pixelraum, region [x0,y0,x1,y1]
 */
export function saliencyFocus(gray, sat, w, h, mask, mag, center, bbox, { topShare = 0.1 } = {}) {
    if (!bbox) return null;
    const B = Math.max(4, Math.round(Math.max(w, h) / 48));
    const bc = Math.ceil(w / B), br = Math.ceil(h / B), nb = bc * br;
    const fG = new Float64Array(nb), fV = new Float64Array(nb), fS = new Float64Array(nb), fM = new Float64Array(nb);
    for (let r = 0; r < br; r++) for (let c = 0; c < bc; c++) {
        let n = 0, sg = 0, s1 = 0, s2 = 0, ss = 0, sm = 0;
        for (let y = r * B; y < Math.min(h, (r + 1) * B); y++) for (let x = c * B; x < Math.min(w, (c + 1) * B); x++) {
            const i = y * w + x, g = gray[i];
            n++; sg += mag[i]; s1 += g; s2 += g * g; sm += mask[i];
            if (sat) ss += sat[i];
        }
        const k = r * bc + c;
        fG[k] = sg / n; fV[k] = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2)); fS[k] = ss / n; fM[k] = sm / n;
    }
    const p95 = arr => {
        const v = Array.from(arr).filter((x, k) => fM[k] > 0).sort((a, b) => a - b);
        return v.length ? Math.max(1e-9, v[Math.floor(v.length * 0.95)]) : 1;
    };
    const nG = p95(fG), nV = p95(fV), nS = p95(fS);
    const useSat = sat && nS >= 20;
    const wG = useSat ? 0.45 : 0.55, wV = useSat ? 0.3 : 0.45, wS = useSat ? 0.25 : 0;
    const sx = Math.max(B, (bbox[2] - bbox[0]) * 0.45), sy = Math.max(B, (bbox[3] - bbox[1]) * 0.45);
    let S = new Float64Array(nb);
    for (let r = 0; r < br; r++) for (let c = 0; c < bc; c++) {
        const k = r * bc + c;
        if (!fM[k]) continue;
        const dx = ((c + 0.5) * B - center[0]) / sx, dy = ((r + 0.5) * B - center[1]) / sy;
        const bias = 0.7 + 0.3 * Math.exp(-(dx * dx + dy * dy) / 2);
        S[k] = (wG * Math.min(1, fG[k] / nG) + wV * Math.min(1, fV[k] / nV) + wS * Math.min(1, fS[k] / nS)) * fM[k] * bias;
    }
    for (let pass = 0; pass < 2; pass++) {
        const T = new Float64Array(nb);
        for (let r = 0; r < br; r++) for (let c = 0; c < bc; c++) {
            let s = 0, n = 0;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= br || cc >= bc) continue;
                s += S[rr * bc + cc]; n++;
            }
            T[r * bc + c] = s / n;
        }
        S = T;
    }
    const motifBlocks = [];
    for (let k = 0; k < nb; k++) if (fM[k] > 0) motifBlocks.push(k);
    if (!motifBlocks.length) return null;
    const sorted = motifBlocks.map(k => S[k]).sort((a, b) => b - a);
    const nTop = Math.max(1, Math.round(motifBlocks.length * topShare));
    const thr = sorted[nTop - 1];
    let peak = motifBlocks[0];
    for (const k of motifBlocks) if (S[k] > S[peak]) peak = k;
    // Zusammenhängende Top-Blöcke um das Maximum (8er-Nachbarschaft)
    const inComp = new Uint8Array(nb), stack = [peak];
    inComp[peak] = 1;
    const comp = [];
    while (stack.length) {
        const k = stack.pop(); comp.push(k);
        const r = Math.floor(k / bc), c = k % bc;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= br || cc >= bc) continue;
            const q = rr * bc + cc;
            if (!inComp[q] && fM[q] > 0 && S[q] >= thr) { inComp[q] = 1; stack.push(q); }
        }
    }
    let sw = 0, px = 0, py = 0, rx0 = w, ry0 = h, rx1 = 0, ry1 = 0, sComp = 0, sAll = 0;
    for (const k of motifBlocks) sAll += S[k];
    for (const k of comp) {
        const r = Math.floor(k / bc), c = k % bc;
        sw += S[k]; px += S[k] * (c + 0.5) * B; py += S[k] * (r + 0.5) * B;
        rx0 = Math.min(rx0, c * B); ry0 = Math.min(ry0, r * B);
        rx1 = Math.max(rx1, Math.min(w, (c + 1) * B)); ry1 = Math.max(ry1, Math.min(h, (r + 1) * B));
        sComp += S[k];
    }
    const lift = (sComp / sAll) / (comp.length / motifBlocks.length);
    const conf = clamp01((lift - 1) / 3) * Math.min(1, comp.length / nTop);
    // Region auf Motiv-BBox begrenzen (Blockraster ragt sonst über das Motiv)
    const region = [Math.max(rx0, bbox[0]), Math.max(ry0, bbox[1]), Math.min(rx1, bbox[2]), Math.min(ry1, bbox[3])];
    return { pt: [px / sw, py / sw], region, conf };
}

// ---------------------------------------------------------------- Gesamt

/**
 * Alle Merkmale aus Graupixeln (optional Sättigung), normiert 0..1 im
 * Bildraum (Dateiorientierung). Punkte [x, y], Rechtecke [x0, y0, x1, y1],
 * Richtungsvektor in normierten Einheiten.
 */
export function computeImageFeatures(gray, w, h, { sat = null, whiteThreshold = 250 } = {}) {
    const mask = motifPixelMask(gray, w, h, { whiteThreshold });
    const bbox = maskBBox(mask, w, h);
    const nx = x => rd(x / w), ny = y => rd(y / h);
    const P = p => [nx(p[0]), ny(p[1])];
    const R = r => [nx(r[0]), ny(r[1]), nx(r[2]), ny(r[3])];
    const out = { aspect: rd(w / h, 4), size: [w, h], motif: bbox ? R(bbox) : null };
    if (!bbox) return { ...out, centroid: null, focus: null, axis: null, ground: null, edges: [], extremes: null, direction: { v: null, conf: 0 } };

    const ink = inkCentroid(gray, w, h, whiteThreshold);
    const axis = principalAxis(mask, w, h);
    const sob = sobel(gray, w, h);
    const focus = saliencyFocus(gray, sat, w, h, mask, sob.mag, axis.c, bbox);
    const ground = groundLine(mask, w, h, bbox);
    const edges = houghSegments(sob, w, h);
    const ext = motifExtremes(mask, w, h, bbox);
    const dir = motifDirection(mask, w, h, axis);

    out.centroid = ink ? P(ink) : P(axis.c);
    out.focus = focus ? { pt: P(focus.pt), region: R(focus.region), conf: rd(focus.conf, 2) } : null;
    out.axis = {
        c: P(axis.c),
        p0: P([axis.c[0] + axis.tMin * axis.u[0], axis.c[1] + axis.tMin * axis.u[1]]),
        p1: P([axis.c[0] + axis.tMax * axis.u[0], axis.c[1] + axis.tMax * axis.u[1]]),
        ecc: rd(axis.ecc, 2),
    };
    out.ground = ground ? { p0: P(ground.p0), p1: P(ground.p1), x: [nx(ground.x0), nx(ground.x1)], quality: rd(ground.quality, 2) } : null;
    out.edges = edges.map(s => [nx(s.p0[0]), ny(s.p0[1]), nx(s.p1[0]), ny(s.p1[1]), rd(s.strength, 2)]);
    const ex = (e, horizontal) => ({ v: horizontal ? nx(e.v) : ny(e.v), hard: e.hard, span: horizontal ? [ny(e.span[0]), ny(e.span[1])] : [nx(e.span[0]), nx(e.span[1])] });
    out.extremes = { left: ex(ext.left, true), right: ex(ext.right, true), top: ex(ext.top, false), bottom: ex(ext.bottom, false) };
    out.direction = { v: dir.v ? [rd(dir.v[0] / w * Math.max(w, h), 4), rd(dir.v[1] / h * Math.max(w, h), 4)] : null, conf: rd(dir.conf, 2) };
    return out;
}

// ---------------------------------------------------------------- Platzierung

/** Winkel einer Strecke in Seitenkoordinaten (y nach unten), Konvention s. Dateikopf. */
export function pageAngle(dx, dy) {
    let a = Math.atan2(-dy, dx) * DEG;
    if (a <= -90) a += 180;
    if (a > 90) a -= 180;
    return a + 0;
}

/** Klasse einer Linie bei gegebener Toleranz (Grad). */
export function lineClass(angle, tol) {
    if (Math.abs(angle) <= tol) return 'horizontal';
    if (90 - Math.abs(angle) <= tol) return 'vertical';
    return 'diagonal';
}

/** Mapper normiert (Datei) → normiert (Seitenorientierung) und Seiten-mm. */
export function makeMappers({ imageBounds, flipH = false, flipV = false }) {
    const [t, l, b, r] = imageBounds;
    const W = r - l, H = b - t;
    const n = ([x, y]) => [flipH ? 1 - x : x, flipV ? 1 - y : y];
    const pt = p => { const [x, y] = n(p); return [l + x * W, t + y * H]; };
    const toPage = makeNormToPage({ imageBounds, flipH, flipV });
    const rect = q => toPage(q[0], q[1], q[2], q[3]);
    const nRect = q => { const [x0, y0] = n([q[0], q[1]]), [x1, y1] = n([q[2], q[3]]); return [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)]; };
    return { n, pt, rect, nRect, W, H };
}

const P1 = p => [r1(p[0]), r1(p[1])];
const N3 = p => p.map(v => rd(v));

function cutSides(full, clip) {
    if (!full || !clip) return [];
    const eps = 0.05, s = [];
    if (full.top < clip.top - eps) s.push('top');
    if (full.bottom > clip.bottom + eps) s.push('bottom');
    if (full.left < clip.left - eps) s.push('left');
    if (full.right > clip.right + eps) s.push('right');
    return s;
}

const inside = (p, c) => !c || (p[0] >= c.left && p[0] <= c.right && p[1] >= c.top && p[1] <= c.bottom);

/**
 * Merkmale in Seiten-mm für die aktuelle Platzierung (kompakt, gerundet).
 * @param {object} f Ergebnis von computeImageFeatures
 * @param {object} placement { imageBounds, flipH, flipV, clip }
 */
export function placeFeatures(f, placement, { axisTolerance = 5, maxEdges = 6 } = {}) {
    const m = makeMappers(placement);
    const clip = placement.clip ? boundsToRect(placement.clip) : null;
    const out = {};
    if (!f.motif) return { motif: null };
    const motifRect = m.rect(f.motif);
    const ptOut = p => ({ page: P1(m.pt(p)), norm: N3(m.n(p)) });

    out.centroid = ptOut(f.centroid);
    if (f.focus) {
        const fp = m.pt(f.focus.pt);
        const reg = m.rect(f.focus.region);
        out.focus = { page: P1(fp), norm: N3(m.n(f.focus.pt)), region: { page: rectToArray(reg), norm: N3(m.nRect(f.focus.region)) }, confidence: f.focus.conf, visible: inside(fp, clip) };
        // Mindestausschnitt: Fokusregion + Puffer 10 % der Motivausdehnung, innerhalb der Motiv-BBox
        const bx = (f.motif[2] - f.motif[0]) * 0.1, by = (f.motif[3] - f.motif[1]) * 0.1;
        const r = f.focus.region;
        const minN = [Math.max(f.motif[0], r[0] - bx), Math.max(f.motif[1], r[1] - by), Math.min(f.motif[2], r[2] + bx), Math.min(f.motif[3], r[3] + by)];
        const minRect = m.rect(minN);
        out.safeCrop = {
            min: { page: rectToArray(minRect), norm: N3(m.nRect(minN)) },
            motif: { page: rectToArray(motifRect), norm: N3(m.nRect(f.motif)) },
            minCutNow: cutSides(minRect, clip),
            motifCutNow: cutSides(motifRect, clip),
        };
    }
    if (f.axis) {
        const a = m.pt(f.axis.p0), b = m.pt(f.axis.p1);
        out.principalAxis = {
            angle: deg(pageAngle(b[0] - a[0], b[1] - a[1])),
            length: r1(Math.hypot(b[0] - a[0], b[1] - a[1])),
            eccentricity: f.axis.ecc,
            center: P1(m.pt(f.axis.c)),
            ends: [P1(a), P1(b)].sort((p, q) => p[0] - q[0] || p[1] - q[1]),
        };
    }
    if (f.ground) {
        const a = m.pt(f.ground.p0), b = m.pt(f.ground.p1);
        const [L, R] = a[0] <= b[0] ? [a, b] : [b, a];
        const xs = [m.pt([f.ground.x[0], 0])[0], m.pt([f.ground.x[1], 0])[0]].sort((p, q) => p - q);
        out.groundLine = { angle: deg(pageAngle(R[0] - L[0], R[1] - L[1])), yLeft: r1(L[1]), yRight: r1(R[1]), x: [r1(L[0]), r1(R[0])], support: xs.map(r1), quality: f.ground.quality };
        if (placement.flipV) out.groundLine.flippedV = true;
    } else out.groundLine = null;

    const edges = (f.edges || []).map(([x0, y0, x1, y1, s]) => {
        let a = m.pt([x0, y0]), b = m.pt([x1, y1]), na = m.n([x0, y0]), nb = m.n([x1, y1]);
        if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) { [a, b] = [b, a]; [na, nb] = [nb, na]; }
        const angle = pageAngle(b[0] - a[0], b[1] - a[1]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const cls = lineClass(angle, axisTolerance);
        return { cls, angle: deg(angle), length: r1(len), strength: s, from: P1(a), to: P1(b), norm: N3([...na, ...nb]), score: len * s };
    });
    edges.sort((p, q) => (p.cls === 'diagonal') - (q.cls === 'diagonal') || q.score - p.score);
    // Achsparallele Linien zuerst (für Ausrichtung am wichtigsten), dann nach Länge × Stärke
    out.edges = edges.slice(0, maxEdges).map(({ score, ...e }) => e);

    if (f.extremes) {
        const e = f.extremes;
        const xv = v => m.pt([v, 0])[0], yv = v => m.pt([0, v])[1];
        const vert = (src) => ({ x: r1(xv(src.v)), hard: src.hard, y: [yv(src.span[0]), yv(src.span[1])].sort((p, q) => p - q).map(r1) });
        const horz = (src) => ({ y: r1(yv(src.v)), hard: src.hard, x: [xv(src.span[0]), xv(src.span[1])].sort((p, q) => p - q).map(r1) });
        out.extremes = {
            left: vert(placement.flipH ? e.right : e.left),
            right: vert(placement.flipH ? e.left : e.right),
            top: horz(placement.flipV ? e.bottom : e.top),
            bottom: horz(placement.flipV ? e.top : e.bottom),
        };
    }
    out.direction = directionOut(f.direction, placement, m);
    return out;
}

function directionOut(d, placement, m) {
    if (!d?.v || d.conf < 0.1) return { dir: 'none', confidence: d?.conf ?? 0 };
    const dx = d.v[0] * (placement.flipH ? -1 : 1) * m.W, dy = d.v[1] * (placement.flipV ? -1 : 1) * m.H;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    return { dir, confidence: d.conf, angle: deg(Math.atan2(-dy, dx) * DEG) };
}

/**
 * Sehr kompakte Zusammenfassung für get_layout_model: Fokuspunkt,
 * Standlinie, Richtung (Seiten-mm, aktuelle Platzierung).
 */
export function featureSummary(f, placement) {
    if (!f?.motif) return null;
    const p = placeFeatures(f, placement, { maxEdges: 0 });
    const s = {};
    if (p.focus) s.focus = [...p.focus.page, p.focus.confidence];
    if (p.groundLine) s.groundLine = [p.groundLine.x[0], p.groundLine.yLeft, p.groundLine.x[1], p.groundLine.yRight];
    s.direction = p.direction.dir === 'none' ? 'none' : `${p.direction.dir} ${p.direction.confidence}`;
    return s;
}

// ---------------------------------------------------------------- Cache

const featureKey = p => `w${p.whiteThreshold}_s${FEATURES_SIZE}`;

async function readSidecar(sidecar, stat) {
    try {
        const json = JSON.parse(await fs.readFile(sidecar, 'utf8'));
        if (json.version === MASK_VERSION && json.fileSize === stat.size && json.mtimeMs === stat.mtimeMs) return json;
    } catch { /* fehlt oder defekt */ }
    return null;
}

/**
 * Merkmale eines Bildes mit Cache (Speicher + Sidecar `features`).
 * Wirft { code: 'unsupported' } für nicht lesbare Formate.
 */
export async function getImageFeatures(filePath, params = {}, { useCache = true } = {}) {
    const p = normalizeFeatureParams(params);
    const stat = await fs.stat(filePath);
    const key = featureKey(p);
    const sidecar = `${filePath}.freespace.json`;
    const memKey = `${filePath}|${stat.size}|${stat.mtimeMs}|${key}`;
    if (useCache) {
        if (memoryCache.has(memKey)) return { ...memoryCache.get(memKey), cache: 'memory' };
        const json = await readSidecar(sidecar, stat);
        const hit = json?.features?.version === FEATURES_VERSION ? json.features.entries?.[key] : null;
        if (hit) { memoryCache.set(memKey, hit); return { ...hit, cache: 'sidecar' }; }
    }
    const img = await loadGray(filePath, FEATURES_SIZE, { saturation: true });
    const f = {
        pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight, orientation: img.orientation,
        ...computeImageFeatures(img.gray, img.width, img.height, { sat: img.sat, whiteThreshold: p.whiteThreshold }),
    };
    let cache = 'computed';
    if (useCache) {
        memoryCache.set(memKey, f);
        try {
            const json = (await readSidecar(sidecar, stat)) || {
                version: MASK_VERSION, fileSize: stat.size, mtimeMs: stat.mtimeMs,
                image: { pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight, format: img.format, orientation: img.orientation },
                entries: {},
            };
            if (json.features?.version !== FEATURES_VERSION) json.features = { version: FEATURES_VERSION, entries: {} };
            json.features.entries[key] = f;
            await fs.writeFile(sidecar, JSON.stringify(json));
            cache = 'computed+saved';
        } catch { /* Link-Ordner nicht beschreibbar */ }
    }
    return { ...f, cache };
}

/**
 * Bereits berechnete Merkmale ohne Analyse (Speicher oder Sidecar), sonst null.
 * Bevorzugt den Standard-Schlüssel (whiteThreshold 250).
 */
export async function readCachedFeatures(filePath) {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return null; }
    const def = featureKey(normalizeFeatureParams());
    const memKey = `${filePath}|${stat.size}|${stat.mtimeMs}|${def}`;
    if (memoryCache.has(memKey)) return memoryCache.get(memKey);
    const json = await readSidecar(`${filePath}.freespace.json`, stat);
    const entries = json?.features?.version === FEATURES_VERSION ? json.features.entries : null;
    if (!entries) return null;
    return entries[def] || Object.values(entries)[0] || null;
}

