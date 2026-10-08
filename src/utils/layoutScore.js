/**
 * Layout-Bewertung für kleine Artikel-Anzeigen – reine Logik ohne InDesign.
 *
 * Eingabe ist eine Szene (s. Typedefs unten), die score_layout aus InDesign
 * liest und ein Solver auch synthetisch bauen kann. Ausgabe: harte Regeln
 * H1–H12 (Verstoß ⇒ ungültig) und gewichteter Score aus S1–S10 (je 0..1,
 * 1 = gut). Fehlen Daten für ein Kriterium, ist es null und zählt nicht.
 *
 * Längen in mm (Seiten-/Linealkoordinaten), Schriftgrade in pt.
 * Bounds [top, left, bottom, right]; Rechtecke intern { top, left, bottom, right }.
 */
import { boundsToRect, intersectRect, rectDistance, unionRect, rectToArray, placementFromGeometry, placeMask, motifRects } from './imageMask.js';
import { placeFeatures } from './imageFeatures.js';
import { deepMerge } from './layoutModel.js';

/**
 * @typedef {number[]} Bounds [top, left, bottom, right] in mm
 *
 * @typedef {object} SceneLine Zeile eines Textrahmens (InDesign: Line)
 * @property {number} top Baseline − Ascent (Oberlänge der Zeilenbox), mm
 * @property {number} bottom Baseline + Descent, mm
 * @property {number} baseline mm
 * @property {number} x Zeilenbeginn (horizontalOffset), mm
 * @property {number} width Zeilenbreite (endHorizontalOffset − horizontalOffset), mm
 * @property {string} text Zeileninhalt ohne Absatz-/Zeilenende
 * @property {boolean} [hyphenated] Zeile endet mit automatischer Trennung
 * @property {boolean} [paragraphEnd] letzte Zeile eines Absatzes
 *
 * @typedef {object} SceneStyle Stil des ersten Textbereichs
 * @property {number} size Schriftgrad pt
 * @property {number} leading Zeilenabstand pt
 * @property {string} [font] Schriftfamilie
 * @property {string} [fontStyle] Schriftschnitt (Bold, Regular …)
 * @property {string} [color] Farbfeldname (für H4)
 * @property {number} [ink] Schwärze 0..1 (Default 1), s. colorInk()
 * @property {number} [accent] Farbsättigung 0..1 (Default 0), s. colorInk()
 * @property {number} [capHeight] Versalhöhe mm (Default size × capHeightRatio)
 * @property {number} [ascGlyph] Höhe einer Oberlängen-Glyphe (d) über der Grundlinie, mm (Default size × ascenderRatio)
 * @property {number} [descGlyph] Tiefe einer Unterlängen-Glyphe (p) unter der Grundlinie, mm (Default size × descenderRatio)
 *
 * @typedef {object} SceneElement Textelement
 * @property {string|number} id
 * @property {string} role Rolle aus config.roles (headline, description, price …)
 * @property {Bounds} frame Rahmen
 * @property {number} [overset] Übersatz-Zeichen (Default 0)
 * @property {SceneLine[]} lines alle Zeilen (auch leere)
 * @property {SceneStyle} style
 * @property {SceneStyle|null} [original] Stil der gleichen Rolle auf der Quell-Ebene (für H4)
 *
 * @typedef {object} SceneImage Platzierte Grafik
 * @property {string|number} id
 * @property {string} [role] Default 'image'
 * @property {Bounds} frame Bildrahmen
 * @property {Bounds} imageBounds Bild (Inhalt) im Rahmen
 * @property {number[]} [effPpi] effektive Auflösung [x, y]
 * @property {Array<{top:number,left:number,bottom:number,right:number}>} [motifRects]
 *   sichtbare Motivzellen in Seiten-mm (imageMask: motifRects(placeMask(mask, placement)))
 * @property {number} [motifFullArea] Fläche des ganzen Motivs (alle Maskenzellen, unbeschnitten) in mm² – für H12
 * @property {object|null} [features] placeFeatures()-Ergebnis in Seiten-mm (safeCrop, extremes, edges, groundLine, direction, centroid)
 * @property {number} [ink] mittlere Tinte des Motivs 0..1 (Default scoring.hierarchy.imageInk)
 * @property {boolean} [frameVisible] Rahmenkanten sichtbar (Bild mit Hintergrund); Default scoring.alignment.imageFrameVisible
 *
 * @typedef {object} Scene
 * @property {object} format buildFormat()-Ergebnis: page.bounds, typeArea, margins, imageBleedBox, modules
 * @property {object} config aufgelöste Projekt-Konfiguration (roles, minPpi, scoring …)
 * @property {SceneElement[]} elements
 * @property {SceneImage[]} [images]
 */

export const PT_MM = 25.4 / 72;
const RULES = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'H12'];
const CRITERIA = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];

export const SCORING_DEFAULTS = {
    // Quell-Ebene für H4 (Originalstile); null = erste Ebene, die nicht sourceLayers.exclude passt
    sourceLayer: null,
    // Versalhöhe / Schriftgrad, wenn style.capHeight fehlt (Noto Sans 0,714)
    capHeightRatio: 0.7,
    // Oberlänge (d) bzw. Unterlänge (p) / Schriftgrad, wenn style.ascGlyph/descGlyph fehlen (Noto Sans 0,76 / 0,24)
    ascenderRatio: 0.76,
    descenderRatio: 0.24,
    // Raster der Motivmaske für H8/S-Kriterien (Zellen auf der längeren Bildseite)
    maskGrid: 64,
    rules: {
        H1: { enabled: true },
        H2: { enabled: true, tolerance: 0.05 },
        H3: { enabled: true },
        H4: { enabled: true, tolerance: 0.01 },
        H5: { enabled: true },
        // motifGap: Rahmenkante zählt nur, wenn das Motiv näher als motifGap mm an ihr liegt (sonst weiß und unsichtbar)
        H6: { enabled: true, tolerance: 0.1, motifGap: 1 },
        H7: { enabled: true, tolerance: 0.1 },
        H8: { enabled: true, minGap: 1 },
        H9: { enabled: true, tolerance: 0.05 },
        H10: { enabled: true, minFragment: 3 },
        // Rolle mit kleinster readingOrder (Headline) steht im Z-Muster vor allen anderen Lesetexten
        H11: { enabled: true },
        // sichtbarer Motivanteil ≥ config.minMotifVisible
        H12: { enabled: true },
    },
    weights: { S1: 2, S2: 1, S3: 1, S4: 1, S5: 1, S6: 1, S7: 1, S8: 1, S9: 1, S10: 0.5 },
    alignment: {
        tolerance: 0.3,
        // Linien knapp daneben (tolerance < d ≤ nearMiss) wirken unruhig
        nearMiss: 1.5,
        nearMissPenalty: 0.5,
        imageFrameVisible: false,
        wishWeight: 0.3,
        wishFalloff: 2,
        wishes: [
            { a: 'price.lastBaseline', b: ['image.groundLine', 'image.motifBottom'], tol: 0.5, weight: 1 },
            { a: 'text.capTop', b: ['image.motifTop', 'image.top'], tol: 0.5, weight: 1 },
        ],
    },
    spacing: { module: 'gap', maxModules: 4, equalityWeight: 0.4 },
    grouping: { targetRatio: 1.5, minRatio: 0.75 },
    // textCoverage: Tintenanteil einer Zeilenbox (Glyphen statt Box), damit Text und Motivfläche × Tinte vergleichbar sind
    hierarchy: { textCoverage: 0.35, boldFactor: 1.4, sizeRef: 10, sizeExponent: 0.5, accentFactor: 1.5, imageInk: 0.5 },
    // Schwerpunkt-Abweichung je Achse (Anteil der Seite), bei der S5 = 0 ist; horizontal enger als vertikal
    balance: { center: [0.5, 0.5], maxDistance: [0.2, 0.3] },
    whitespace: { module: 'gap', holeMax: 0.12, holeSoft: 0.12, gridMm: 1, holeWeight: 0.5 },
    // zero: Anteil mit S7 = 0, linear bis range[0]; über range[1] weich bis 0 über soft
    imageShare: { zero: 0.05, range: [0.35, 0.55], soft: 0.2, roles: ['image'] },
    typography: {
        ragMax: 0.15, shortLastLine: 0.2, hyphenPenalty: 0.15,
        headlineBalance: [0.3, 0.75], bodyRoles: ['description'], charsPerLine: [30, 60], charsSoft: 15,
    },
    readingFlow: { rowOverlap: 0.3 },
    gaze: { minConfidence: 0.3, fullConfidence: 0.6 },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clamp01 = v => Math.max(0, Math.min(1, v));
const rd = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const std = a => { const m = mean(a); return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : 0; };
const area = r => (r ? Math.max(0, r.bottom - r.top) * Math.max(0, r.right - r.left) : 0);
const center = r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];

// Aufgelöste Scoring-Konfiguration je Config-Objekt (Solver bewertet tausende Szenen mit derselben Config)
const scCache = new WeakMap();

/** Scoring-Konfiguration: Defaults mit config.scoring mischen; Regeln als true/false oder Objekt. Ergebnis je Config-Objekt gecacht. */
export function scoringConfig(config = {}) {
    if (isObj(config) && scCache.has(config)) return scCache.get(config);
    const s = resolveScoring(config);
    if (isObj(config)) scCache.set(config, s);
    return s;
}

function resolveScoring(config) {
    const s = deepMerge(SCORING_DEFAULTS, isObj(config.scoring) ? config.scoring : {});
    const rules = {};
    for (const k of RULES) {
        const v = config.scoring?.rules?.[k];
        if (v === false || v === true) rules[k] = { ...SCORING_DEFAULTS.rules[k], enabled: v };
        else rules[k] = s.rules[k];
    }
    s.rules = rules;
    return validateScoring(s);
}

/** Prüft den Scoring-Abschnitt; wirft mit verständlicher Meldung. */
export function validateScoring(s) {
    for (const k of CRITERIA) {
        const w = s.weights[k];
        if (typeof w !== 'number' || !(w >= 0)) throw new Error(`config.scoring.weights.${k} must be a number >= 0`);
    }
    for (const k of Object.keys(s.weights)) if (!CRITERIA.includes(k)) throw new Error(`config.scoring.weights: unknown criterion '${k}' (allowed ${CRITERIA.join(', ')})`);
    for (const k of Object.keys(s.rules)) if (!RULES.includes(k)) throw new Error(`config.scoring.rules: unknown rule '${k}'`);
    const range = (v, label) => { if (!Array.isArray(v) || v.length !== 2 || !(v[0] <= v[1])) throw new Error(`config.scoring.${label} must be [min, max]`); };
    range(s.imageShare.range, 'imageShare.range');
    if (!(s.imageShare.zero >= 0 && s.imageShare.zero < s.imageShare.range[0])) throw new Error('config.scoring.imageShare.zero must be >= 0 and < range[0]');
    if (typeof s.balance.maxDistance === 'number') s.balance.maxDistance = [s.balance.maxDistance, s.balance.maxDistance];
    if (!Array.isArray(s.balance.maxDistance) || s.balance.maxDistance.length !== 2 || !s.balance.maxDistance.every(v => v > 0)) throw new Error('config.scoring.balance.maxDistance must be [x, y] > 0');
    range(s.typography.charsPerLine, 'typography.charsPerLine');
    range(s.typography.headlineBalance, 'typography.headlineBalance');
    if (!Array.isArray(s.alignment.wishes)) throw new Error('config.scoring.alignment.wishes must be an array');
    s.alignment.wishes.forEach((w, i) => {
        for (const ref of [w?.a, ...[].concat(w?.b ?? [])]) {
            if (!parseAnchor(ref)) throw new Error(`config.scoring.alignment.wishes[${i}]: invalid anchor '${ref}' (e.g. 'price.lastBaseline', 'image.groundLine')`);
        }
        const axes = new Set([w.a, ...[].concat(w.b)].map(r => parseAnchor(r).axis));
        if (axes.size > 1) throw new Error(`config.scoring.alignment.wishes[${i}]: anchors mix x and y`);
    });
    if (s.sourceLayer !== null && typeof s.sourceLayer !== 'string') throw new Error('config.scoring.sourceLayer must be a layer name or null');
    return s;
}

// ------------------------------------------------------------------ Farbe

/**
 * Schwärze und Farbakzent einer Farbe: { space: 'CMYK'|'RGB'|'LAB', values, tint? }.
 * ink = 1 − relative Luminanz, accent = Sättigung (max − min der RGB-Kanäle), je 0..1.
 */
export function colorInk(c) {
    if (!c || !Array.isArray(c.values)) return { ink: 1, accent: 0 };
    const space = String(c.space || '').toUpperCase();
    const v = c.values;
    let rgb;
    if (space.includes('CMYK')) {
        const [C, M, Y, K] = v.map(x => x / 100);
        rgb = [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
    } else if (space.includes('RGB')) rgb = v.slice(0, 3).map(x => x / 255);
    else if (space.includes('LAB')) rgb = [v[0] / 100, v[0] / 100, v[0] / 100];
    else return { ink: 1, accent: 0 };
    const t = typeof c.tint === 'number' && c.tint >= 0 && c.tint <= 100 ? c.tint / 100 : 1;
    rgb = rgb.map(x => 1 - (1 - x) * t);
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return { ink: rd(clamp01(1 - lum)), accent: rd(Math.max(...rgb) - Math.min(...rgb)) };
}

// ------------------------------------------------------------------ Szene vorbereiten

const DASH_START = /^\s*[-–—‒]/;
const BOLD = /(bold|black|heavy|semi|demi|fett|halbfett|extra)/i;
// Glyphen über der Versalhöhe bzw. unter der Grundlinie (Text in NFD, Akzente als Kombinationszeichen)
const ASC_GLYPH = /[bdfhklijß()[\]{}|/]|\p{Ll}[\u0300-\u036f]/u;
const ACCENT_CAP = /\p{Lu}[\u0300-\u036f]/u;
const DESC_GLYPH = /[gjpqyQ(),;[\]{}|_µ]/u;
// Versal mit Akzent (Ä) ≈ 1,26 × Versalhöhe (Noto Sans)
const ACCENT_CAP_FACTOR = 1.26;

/**
 * Glyphen-Box einer Zeile: oben Grundlinie − max(Versalhöhe, Oberlänge falls
 * Oberlängen-Glyphen vorkommen), unten Grundlinie + Unterlänge falls
 * Unterlängen-Glyphen vorkommen. Enger als die Zeilenbox (Ascent/Descent).
 */
function glyphRect(l, m) {
    const t = String(l.text ?? '').normalize('NFD');
    let up = m.cap;
    if (ASC_GLYPH.test(t)) up = Math.max(up, m.asc);
    if (ACCENT_CAP.test(t)) up = Math.max(up, m.cap * ACCENT_CAP_FACTOR);
    const down = DESC_GLYPH.test(t) ? m.desc : 0;
    return { top: Math.max(l.top, l.baseline - up), bottom: Math.min(l.bottom, l.baseline + down), left: l.x, right: l.x + l.width };
}

function prepare(scene, sc) {
    const fmt = scene.format;
    const page = boundsToRect(fmt.page.bounds);
    const typeArea = boundsToRect(fmt.typeArea);
    const texts = (scene.elements || []).map(el => {
        const st = el.style || {};
        const em = st.size ? st.size * PT_MM : null;
        const capHeight = st.capHeight ?? (em ? em * sc.capHeightRatio : null);
        const gm = em || capHeight != null ? {
            cap: capHeight ?? 0,
            asc: st.ascGlyph ?? (em ? em * sc.ascenderRatio : capHeight),
            desc: st.descGlyph ?? (em ? em * sc.descenderRatio : 0),
        } : null;
        const lines = (el.lines || []).map((l, i) => {
            const rect = { top: l.top, bottom: l.bottom, left: l.x, right: l.x + l.width };
            return { ...l, i, rect, glyph: gm ? glyphRect(l, gm) : rect };
        });
        const vis = lines.filter(l => String(l.text ?? '').trim() !== '');
        const block = unionRect(vis.map(l => l.rect));
        return { ...el, kind: 'text', lines, vis, block, capHeight, style: st };
    });
    const images = (scene.images || []).map(im => {
        const role = im.role || 'image';
        const frame = boundsToRect(im.frame);
        const ib = boundsToRect(im.imageBounds || im.frame);
        const visible = intersectRect(intersectRect(frame, ib) || { top: 0, left: 0, bottom: 0, right: 0 }, page);
        const motif = (im.motifRects || []).map(r => (visible ? intersectRect(r, visible) : null)).filter(Boolean);
        const motifBox = unionRect(motif);
        const motifArea = motif.reduce((s, r) => s + area(r), 0);
        let mc = null;
        if (motifArea > 0) {
            const sx = motif.reduce((s, r) => s + center(r)[0] * area(r), 0), sy = motif.reduce((s, r) => s + center(r)[1] * area(r), 0);
            mc = [sx / motifArea, sy / motifArea];
        }
        const frameVisible = im.frameVisible ?? sc.alignment.imageFrameVisible;
        const motifShare = im.motifFullArea > 0 ? motifArea / im.motifFullArea : null;
        return { ...im, role, kind: 'image', frameRect: frame, visible, motif, motifBox, motifArea, motifShare, motifCenter: mc, frameVisible };
    });
    return { page, typeArea, texts, images, fmt };
}

/** Elementare Rechtecke eines Blocks: Glyphen-Boxen der Zeilen bzw. sichtbare Motivzellen (Rahmen, wenn sichtbar). */
function partsOf(b) {
    if (b.kind === 'text') return b.vis.map(l => l.glyph);
    if (b.frameVisible && b.visible) return [b.visible];
    return b.motif;
}

function boxOf(b) {
    if (b.kind === 'text') return b.block;
    return b.frameVisible ? b.visible : b.motifBox;
}

/** Kleinster Abstand zweier Blöcke und das nächstgelegene Paar elementarer Rechtecke. */
function blockDistance(A, B) {
    let best = null;
    for (const a of partsOf(A)) for (const b of partsOf(B)) {
        const d = rectDistance(a, b);
        if (!best || d < best.d) best = { d, a, b };
    }
    return best;
}

/** Lücken-Rechteck zwischen zwei Rechtecken und die Achse der Lücke ('v' übereinander, 'h' nebeneinander, 'd' diagonal). */
function gapBetween(a, b) {
    const xs = a.right <= b.left ? [a.right, b.left] : b.right <= a.left ? [b.right, a.left] : [Math.max(a.left, b.left), Math.min(a.right, b.right)];
    const ys = a.bottom <= b.top ? [a.bottom, b.top] : b.bottom <= a.top ? [b.bottom, a.top] : [Math.max(a.top, b.top), Math.min(a.bottom, b.bottom)];
    const xOverlap = !(a.right <= b.left || b.right <= a.left);
    const yOverlap = !(a.bottom <= b.top || b.bottom <= a.top);
    const axis = xOverlap && !yOverlap ? 'v' : yOverlap && !xOverlap ? 'h' : xOverlap && yOverlap ? 'o' : 'd';
    return { rect: { top: ys[0], bottom: ys[1], left: xs[0], right: xs[1] }, axis };
}

/**
 * Benachbarte Blockpaare: kürzeste Verbindung zwischen ihren elementaren
 * Rechtecken, ohne dass ein dritter Block in der Lücke liegt.
 */
function adjacentGaps(blocks) {
    const out = [];
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
        const A = blocks[i], B = blocks[j];
        const near = blockDistance(A, B);
        if (!near) continue;
        const g = gapBetween(near.a, near.b);
        const probe = { top: g.rect.top + 0.01, left: g.rect.left + 0.01, bottom: g.rect.bottom - 0.01, right: g.rect.right - 0.01 };
        const blocked = probe.top < probe.bottom && probe.left < probe.right
            && blocks.some((C, k) => k !== i && k !== j && partsOf(C).some(r => intersectRect(r, probe)));
        if (blocked) continue;
        out.push({ a: A, b: B, gap: near.d, axis: g.axis });
    }
    return out;
}

// ------------------------------------------------------------------ Harte Regeln

/**
 * H6: Rahmenkanten, an denen Bildinhalt sichtbar ist. Ohne Maske oder mit
 * frameVisible alle Kanten; sonst nur Kanten, denen das sichtbare Motiv näher
 * als gap kommt (angeschnitten oder knapp davor). Ein nicht weißer
 * Bildhintergrund liegt in der Maske selbst als Motiv bis an die Bildkante.
 */
function seenEdges(im, vis, page, gap) {
    const all = { top: true, left: true, bottom: true, right: true };
    if (im.frameVisible || !Array.isArray(im.motifRects)) return all;
    const mb = im.motifBox;
    const clip = intersectRect(vis, page);
    if (!mb || !clip) return { top: false, left: false, bottom: false, right: false };
    return {
        top: mb.top - clip.top < gap, left: mb.left - clip.left < gap,
        bottom: clip.bottom - mb.bottom < gap, right: clip.right - mb.right < gap,
    };
}

/**
 * Z-Muster: A vor B, wenn beide in einer Zeile liegen (vertikale Überlappung
 * > rowOverlap der kleineren Höhe) und A links beginnt, sonst wenn A höher beginnt.
 */
export function zBefore(A, B, rowOverlap = 0.3) {
    const ov = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    const minH = Math.min(A.bottom - A.top, B.bottom - B.top);
    if (ov > rowOverlap * minH) return A.left < B.left;
    return A.top < B.top;
}

/** Rolle mit der kleinsten readingOrder (Headline) oder null. */
export function leadRole(roles = {}) {
    let best = null;
    for (const [name, def] of Object.entries(roles)) {
        if (Number.isFinite(def?.readingOrder) && (best === null || def.readingOrder < roles[best].readingOrder)) best = name;
    }
    return best;
}

/** Dürfen zwei Rollen in der Lesefolge tauschen? readingOrderFlexible: true = mit allen, Array = mit diesen Rollen. */
export function orderFlexible(roles, a, b) {
    const fa = roles?.[a]?.readingOrderFlexible, fb = roles?.[b]?.readingOrderFlexible;
    return fa === true || fb === true || (Array.isArray(fa) && fa.includes(b)) || (Array.isArray(fb) && fb.includes(a));
}

function checkRules(P, scene, sc) {
    const cfg = scene.config || {};
    const R = sc.rules;
    const violations = [], skipped = [];
    const v = (rule, ids, detail) => violations.push({ rule, ids: [].concat(ids), detail });
    const on = k => R[k]?.enabled !== false;
    const ta = P.typeArea;

    if (on('H1')) for (const t of P.texts) if ((t.overset || 0) > 0) v('H1', t.id, `${t.overset} overset characters`);

    if (on('H2')) {
        const tol = R.H2.tolerance ?? 0.05;
        for (const t of P.texts) {
            const out = t.vis.filter(l => l.rect.top < ta.top - tol || l.rect.bottom > ta.bottom + tol || l.rect.left < ta.left - tol || l.rect.right > ta.right + tol);
            if (out.length) {
                const u = unionRect(out.map(l => l.rect));
                const over = [ta.top - u.top, ta.left - u.left, u.bottom - ta.bottom, u.right - ta.right].map(x => rd(Math.max(0, x), 2));
                v('H2', t.id, `${out.length} line(s) outside type area, overhang [t,l,b,r] ${over.join(', ')} mm`);
            }
        }
    }

    if (on('H3')) {
        for (const t of P.texts) {
            if (!cfg.roles?.[t.role]?.allow?.keepTogether) continue;
            if (t.vis.length > 1) v('H3', t.id, `${t.role} set in ${t.vis.length} lines, must be one`);
        }
    }

    if (on('H4')) {
        const tol = R.H4.tolerance ?? 0.01;
        for (const t of P.texts) {
            const o = t.original;
            if (!o) { skipped.push({ rule: 'H4', ids: [t.id], reason: `no original for role ${t.role} on source layer` }); continue; }
            const allow = cfg.roles?.[t.role]?.allow || {};
            for (const [k, f] of [['size', allow.pointSize], ['leading', allow.leading]]) {
                const cur = t.style[k], ref = o[k];
                if (typeof cur !== 'number' || typeof ref !== 'number') continue;
                const frac = typeof f === 'number' ? f : 0;
                if (cur < ref * (1 - frac) - tol || cur > ref * (1 + frac) + tol) {
                    v('H4', t.id, `${k} ${rd(cur, 2)} pt outside ${frac ? `±${rd(frac * 100, 1)} % of ` : ''}original ${rd(ref, 2)} pt`);
                }
            }
            for (const k of ['font', 'fontStyle', 'color']) {
                if (o[k] != null && t.style[k] != null && o[k] !== t.style[k]) v('H4', t.id, `${k} changed: '${o[k]}' → '${t.style[k]}'`);
            }
        }
    }

    if (on('H5')) {
        for (const im of P.images) {
            const min = cfg.roles?.[im.role]?.allow?.minPpi ?? cfg.minPpi ?? 200;
            if (!Array.isArray(im.effPpi)) { skipped.push({ rule: 'H5', ids: [im.id], reason: 'no effective ppi' }); continue; }
            const eff = Math.min(...im.effPpi);
            if (eff < min - 0.5) v('H5', im.id, `effective ${Math.round(eff)} ppi < ${min}`);
        }
    }

    if (on('H6')) {
        const tol = R.H6.tolerance ?? 0.1, gap = R.H6.motifGap ?? 1;
        const pg = P.page, m = P.fmt.margins, bb = boundsToRect(P.fmt.imageBleedBox);
        const bleed = [pg.top - bb.top, pg.left - bb.left, bb.bottom - pg.bottom, bb.right - pg.right];
        for (const im of P.images) {
            const ib = boundsToRect(im.imageBounds || im.frame);
            const vis = intersectRect(im.frameRect, ib);
            if (!vis) continue;
            const seen = seenEdges(im, vis, pg, gap);
            // Abstand der sichtbaren Kante zur Seitenkante, nach innen positiv
            const d = [vis.top - pg.top, vis.left - pg.left, pg.bottom - vis.bottom, pg.right - vis.right];
            const bad = [];
            ['top', 'left', 'bottom', 'right'].forEach((s, k) => {
                if (seen[s] && d[k] < m[k] - tol && d[k] > -bleed[k] + tol) bad.push(`${s} ${rd(d[k], 2)} mm from page edge`);
            });
            if (bad.length) v('H6', im.id, `image edge neither ≥ margin nor bleeding ≥ ${rd(Math.min(...bleed), 2)} mm: ${bad.join(', ')}`);
        }
    }

    if (on('H7')) {
        const tol = R.H7.tolerance ?? 0.1;
        for (const im of P.images) {
            const sc0 = im.features?.safeCrop?.min?.page;
            if (!sc0) { if (im.role === 'image') skipped.push({ rule: 'H7', ids: [im.id], reason: 'no image features (safeCrop)' }); continue; }
            const need = boundsToRect(sc0), vis = im.visible;
            const cut = !vis ? ['all'] : ['top', 'left', 'bottom', 'right'].filter((s, k) => (k < 2 ? need[s] < vis[s] - tol : need[s] > vis[s] + tol));
            if (cut.length) v('H7', im.id, `safe crop cut at ${cut.join(', ')}`);
        }
        if (cfg.allowMotifCut === false) {
            for (const im of P.images) {
                if (!im.motifBox || !im.visible) continue;
                const mb = im.motifBox, vis = im.visible;
                const cut = ['top', 'left', 'bottom', 'right'].filter((s, k) => (k < 2 ? mb[s] - vis[s] : vis[s] - mb[s]) <= tol);
                if (cut.length) v('H7', im.id, `motif cut at ${cut.join(', ')} (allowMotifCut: false)`);
            }
        }
    }

    if (on('H8')) {
        const gap = R.H8.minGap ?? 0;
        for (const im of P.images) if (!Array.isArray(im.motifRects)) skipped.push({ rule: 'H8', ids: [im.id], reason: 'no motif mask' });
        for (const t of P.texts) for (const im of P.images) {
            const hits = t.vis.filter(l => im.motif.some(r => rectDistance(l.rect, r) < gap - 1e-6 || (gap === 0 && intersectRect(l.rect, r))));
            if (hits.length) {
                const d = Math.min(...hits.map(l => Math.min(...im.motif.map(r => rectDistance(l.rect, r)))));
                v('H8', [t.id, im.id], `${hits.length} line(s) closer than ${gap} mm to motif (min ${rd(d, 2)} mm): ${hits.slice(0, 2).map(l => `'${String(l.text).slice(0, 20)}'`).join(', ')}`);
            }
        }
    }

    if (on('H9')) {
        const tol = R.H9.tolerance ?? 0.05;
        for (let i = 0; i < P.texts.length; i++) for (let j = i + 1; j < P.texts.length; j++) {
            const A = P.texts[i], B = P.texts[j];
            let worst = 0;
            for (const a of A.vis) for (const b of B.vis) {
                const x = intersectRect(a.glyph, b.glyph);
                if (x) worst = Math.max(worst, Math.min(x.bottom - x.top, x.right - x.left));
            }
            if (worst > tol) v('H9', [A.id, B.id], `glyph boxes overlap by ${rd(worst, 2)} mm`);
        }
    }

    if (on('H10')) {
        const minF = R.H10.minFragment ?? 3;
        for (const t of P.texts) {
            // Strich am Absatzanfang ist erlaubt (Aufzählung), nur ein Umbruch davor nicht
            const dash = t.lines.filter((l, k) => k > 0 && !t.lines[k - 1].paragraphEnd && DASH_START.test(String(l.text ?? '')));
            if (dash.length) v('H10', t.id, `line starts with dash: '${String(dash[0].text).slice(0, 20)}'`);
            t.lines.forEach((l, k) => {
                if (!l.hyphenated) return;
                const before = (String(l.text).match(/\p{L}+$/u) || [''])[0].length;
                const after = (String(t.lines[k + 1]?.text ?? '').match(/^\p{L}+/u) || [''])[0].length;
                if (before < minF || after < minF) v('H10', t.id, `hyphenation leaves ${before}/${after} characters (min ${minF})`);
            });
        }
    }

    if (on('H11')) {
        const lead = leadRole(cfg.roles);
        const ro = P.texts.filter(t => t.vis.length && Number.isFinite(cfg.roles?.[t.role]?.readingOrder));
        for (const a of ro.filter(t => t.role === lead)) for (const b of ro) {
            if (b.role !== lead && !zBefore(a.block, b.block, sc.readingFlow.rowOverlap)) v('H11', [a.id, b.id], `${b.role} before ${lead} in Z order`);
        }
    }

    if (on('H12')) {
        const min = cfg.minMotifVisible ?? 0;
        for (const im of P.images) {
            if (!(min > 0) || im.role !== 'image') continue;
            if (im.motifShare == null) { skipped.push({ rule: 'H12', ids: [im.id], reason: 'no motif mask (motifFullArea)' }); continue; }
            if (im.motifShare < min - 1e-3) v('H12', im.id, `${rd(im.motifShare * 100, 0)} % of motif visible < ${rd(min * 100, 0)} %`);
        }
    }
    return { violations, skipped };
}

// ------------------------------------------------------------------ Score-Kriterien

/** Anker 'rolle.merkmal' (rolle 'text'/'image' = beliebiges Element dieser Art). */
export function parseAnchor(ref) {
    const m = /^([\w-]+)\.(left|right|firstBaseline|lastBaseline|capTop|top|bottom|groundLine|motifTop|motifBottom|motifLeft|motifRight)$/.exec(String(ref ?? ''));
    if (!m) return null;
    const axis = ['left', 'right', 'motifLeft', 'motifRight'].includes(m[2]) ? 'x' : 'y';
    return { role: m[1], prop: m[2], axis };
}

/** Kanten des sichtbaren Bildbereichs, an denen das Motiv angeschnitten (also die Kante sichtbar) ist. */
function visibleFrameEdges(im, page, tol = 0.3) {
    const v = im.visible;
    if (!v) return {};
    const mb = im.motifBox;
    const out = {};
    for (const s of ['top', 'bottom', 'left', 'right']) {
        // Seitenkante (randabfallend) ist keine Gestaltungslinie
        if (Math.abs(v[s] - page[s]) <= tol) continue;
        const cut = mb && (s === 'top' || s === 'left' ? mb[s] <= v[s] + tol : mb[s] >= v[s] - tol);
        if (im.frameVisible || cut) out[s] = v[s];
    }
    return out;
}

/** Werte eines Ankers je passendem Element. */
function anchorValues(P, ref) {
    const a = parseAnchor(ref);
    const vals = [];
    for (const t of P.texts) {
        if (!(a.role === 'text' || a.role === t.role) || !t.vis.length) continue;
        const first = t.vis[0], last = t.vis[t.vis.length - 1];
        const val = {
            left: t.block.left, right: t.block.right, top: t.block.top, bottom: t.block.bottom,
            firstBaseline: first.baseline, lastBaseline: last.baseline,
            capTop: t.capHeight != null ? first.baseline - t.capHeight : null,
        }[a.prop];
        if (val != null) vals.push({ id: t.id, v: val });
    }
    for (const im of P.images) {
        if (!(a.role === 'image' || a.role === im.role)) continue;
        const f = im.features || {};
        const fe = visibleFrameEdges(im, P.page);
        let val = null;
        if (a.prop === 'groundLine') val = f.groundLine && Math.abs(f.groundLine.angle) <= 2 ? (f.groundLine.yLeft + f.groundLine.yRight) / 2 : null;
        else if (a.prop === 'motifTop') val = im.motifBox?.top;
        else if (a.prop === 'motifBottom') val = im.motifBox?.bottom;
        else if (a.prop === 'motifLeft') val = im.motifBox?.left;
        else if (a.prop === 'motifRight') val = im.motifBox?.right;
        else if (['top', 'bottom', 'left', 'right'].includes(a.prop)) val = fe[a.prop];
        if (val != null) vals.push({ id: im.id, v: val });
    }
    return vals;
}

/**
 * S1 Ausrichtung: Kandidaten-Linien je Achse. Layout-Linien (Textkanten,
 * Grundlinien, Versalhöhe; sichtbare Bildkanten) gelten als verankert, wenn
 * eine Linie eines anderen Elements, ein Motivmerkmal oder eine
 * Satzspiegelkante innerhalb der Toleranz liegt. Strafe für Beinahe-Treffer.
 */
function scoreAlignment(P, sc, detail) {
    const al = sc.alignment, tol = al.tolerance;
    const cands = []; // { axis, v, owner, kind, w, layout }
    const add = (axis, v, owner, kind, w, layout) => { if (Number.isFinite(v)) cands.push({ axis, v, owner, kind, w, layout }); };
    for (const t of P.texts) {
        if (!t.vis.length) continue;
        const lefts = t.vis.map(l => l.rect.left), rights = t.vis.map(l => l.rect.right);
        add('x', t.block.left, t.id, 'left', std(lefts) <= tol ? 1 : 0.4, true);
        add('x', t.block.right, t.id, 'right', std(rights) <= tol ? 1 : 0.4, true);
        const fb = t.vis[0].baseline, lb = t.vis[t.vis.length - 1].baseline;
        add('y', fb, t.id, 'firstBaseline', 1, true);
        if (t.vis.length > 1) add('y', lb, t.id, 'lastBaseline', 1, true);
        if (t.capHeight != null) add('y', fb - t.capHeight, t.id, 'capTop', 0.7, true);
    }
    for (const im of P.images) {
        const fe = visibleFrameEdges(im, P.page);
        for (const [s, val] of Object.entries(fe)) add(s === 'top' || s === 'bottom' ? 'y' : 'x', val, im.id, `frame.${s}`, 1, true);
        const f = im.features;
        if (f?.extremes) {
            const e = f.extremes;
            add('x', e.left.x, im.id, 'motif.left', 1, false); add('x', e.right.x, im.id, 'motif.right', 1, false);
            add('y', e.top.y, im.id, 'motif.top', 1, false); add('y', e.bottom.y, im.id, 'motif.bottom', 1, false);
        } else if (im.motifBox) {
            const b = im.motifBox;
            add('x', b.left, im.id, 'motif.left', 1, false); add('x', b.right, im.id, 'motif.right', 1, false);
            add('y', b.top, im.id, 'motif.top', 1, false); add('y', b.bottom, im.id, 'motif.bottom', 1, false);
        }
        if (f?.groundLine && Math.abs(f.groundLine.angle) <= 2) add('y', (f.groundLine.yLeft + f.groundLine.yRight) / 2, im.id, 'groundLine', 1, false);
        for (const e of f?.edges || []) {
            if (e.cls === 'horizontal') add('y', (e.from[1] + e.to[1]) / 2, im.id, 'edge.h', 1, false);
            else if (e.cls === 'vertical') add('x', (e.from[0] + e.to[0]) / 2, im.id, 'edge.v', 1, false);
        }
    }
    const ta = P.typeArea;
    add('x', ta.left, 'typeArea', 'left', 1, false); add('x', ta.right, 'typeArea', 'right', 1, false);
    add('y', ta.top, 'typeArea', 'top', 1, false); add('y', ta.bottom, 'typeArea', 'bottom', 1, false);

    const layout = cands.filter(c => c.layout);
    if (!layout.length) return { v: null, note: 'no text or visible image edges' };
    let wSum = 0, wAnch = 0, wNear = 0;
    for (const c of layout) {
        const others = cands.filter(o => o.axis === c.axis && o.owner !== c.owner);
        const d = others.length ? Math.min(...others.map(o => Math.abs(o.v - c.v))) : Infinity;
        const near = others.some(o => { const x = Math.abs(o.v - c.v); return x > tol && x <= al.nearMiss; });
        c.anchored = d <= tol;
        wSum += c.w;
        if (c.anchored) wAnch += c.w;
        if (near) { wNear += c.w; c.nearMiss = true; }
    }
    const shared = wAnch / wSum, nearFrac = wNear / wSum;
    let base = clamp01(shared - al.nearMissPenalty * nearFrac);

    // Wunsch-Ausrichtungen
    const wishRes = [];
    for (const w of al.wishes || []) {
        const A = anchorValues(P, w.a), B = [].concat(w.b).flatMap(r => anchorValues(P, r));
        if (!A.length || !B.length) continue;
        let d = Infinity;
        for (const a of A) for (const b of B) if (a.id !== b.id) d = Math.min(d, Math.abs(a.v - b.v));
        if (!Number.isFinite(d)) continue;
        const t0 = w.tol ?? tol;
        const s = d <= t0 ? 1 : clamp01(1 - (d - t0) / (al.wishFalloff || 2));
        wishRes.push({ wish: `${w.a} = ${[].concat(w.b).join('|')}`, d: rd(d, 2), s, weight: w.weight ?? 1 });
    }
    let v = base;
    if (wishRes.length && al.wishWeight > 0) {
        const ws = wishRes.reduce((s, x) => s + x.weight, 0);
        const wv = ws ? wishRes.reduce((s, x) => s + x.s * x.weight, 0) / ws : 0;
        v = (1 - al.wishWeight) * base + al.wishWeight * wv;
    }
    if (detail) {
        const lines = {};
        for (const axis of ['x', 'y']) {
            const cs = cands.filter(c => c.axis === axis).sort((a, b) => a.v - b.v);
            const clusters = [];
            for (const c of cs) {
                const last = clusters[clusters.length - 1];
                if (last && c.v - last.start <= tol) last.m.push(c); else clusters.push({ start: c.v, m: [c] });
            }
            lines[axis] = clusters.filter(cl => cl.m.some(c => c.layout) && new Set(cl.m.map(c => c.owner)).size > 1)
                .map(cl => [rd(mean(cl.m.map(c => c.v)), 2), cl.m.map(c => `${c.owner}.${c.kind}`).join(' ')]);
        }
        detail.alignment = {
            lines,
            unanchored: layout.filter(c => !c.anchored).map(c => `${c.owner}.${c.kind}@${rd(c.v, 2)}${c.nearMiss ? '~' : ''}`),
            wishes: wishRes.map(({ wish, d }) => [wish, d]),
        };
    }
    const note = `${rd(shared * 100, 0)} % anchored, ${rd(nearFrac * 100, 0)} % near-miss${wishRes.length ? `, wishes ${wishRes.map(w => `${w.s >= 0.99 ? '✓' : rd(w.d, 1)}`).join('/')}` : ''}`;
    return { v, note };
}

function moduleMm(P, key) {
    if (typeof key === 'number') return key;
    return P.fmt.modules?.[key] ?? Math.min(...P.fmt.margins) / 2;
}

function blocksOf(P) {
    return [...P.texts.filter(t => t.vis.length), ...P.images.filter(im => (im.frameVisible ? im.visible : im.motif.length))];
}

/** S2 Abstands-Rhythmus: Lücken benachbarter Blöcke als Vielfache des Moduls, gleiche Beziehungen gleich. */
function scoreSpacing(P, sc, gaps, detail) {
    const mod = moduleMm(P, sc.spacing.module);
    const rel = gaps.filter(g => g.axis !== 'd' && g.axis !== 'o' && g.gap > 0.05 && g.gap <= sc.spacing.maxModules * mod);
    if (!rel.length) return { v: null, note: 'no adjacent gaps' };
    const fit = rel.map(g => {
        const k = Math.max(1, Math.round(g.gap / mod));
        return 1 - Math.min(1, Math.abs(g.gap - k * mod) / (mod / 2));
    });
    const classes = {};
    for (const g of rel) {
        const key = `${[g.a.kind, g.b.kind].sort().join('-')}:${g.axis}`;
        (classes[key] ||= []).push(g.gap);
    }
    const eq = Object.values(classes).filter(a => a.length > 1).map(a => 1 - Math.min(1, std(a) / mean(a)));
    const f = mean(fit);
    const v = eq.length ? (1 - sc.spacing.equalityWeight) * f + sc.spacing.equalityWeight * mean(eq) : f;
    if (detail) detail.gaps = gaps.map(g => [`${g.a.id}-${g.b.id}`, g.axis, rd(g.gap, 2)]);
    return { v, note: `module ${rd(mod, 2)} mm, ${rel.length} gaps ${rel.map(g => rd(g.gap, 1)).join('/')}` };
}

/**
 * S3 Gruppierung (Gesetz der Nähe): je Text mit readingOrder das Verhältnis
 * Abstand zum Motiv / Abstand zum nächsten Text der Gruppe; ≥ targetRatio = 1,
 * ≤ minRatio = 0, Mittel über die Texte. Nächster statt lesefolge-benachbarter
 * Text, weil die Reihenfolge schon S9 bewertet.
 */
function scoreGrouping(P, sc, cfg) {
    const ro = P.texts.filter(t => t.vis.length && Number.isFinite(cfg.roles?.[t.role]?.readingOrder));
    const main = mainImage(P);
    if (ro.length < 2) return { v: null, note: 'fewer than 2 texts with readingOrder' };
    if (!main) return { v: null, note: 'no image motif' };
    const { targetRatio: hi, minRatio: lo } = sc.grouping;
    const parts = [], notes = [];
    for (const t of ro) {
        const dt = Math.min(...ro.filter(o => o !== t).map(o => blockDistance(t, o).d));
        const dm = blockDistance(t, main).d;
        const r = dm <= 0.01 ? 0 : dt > 0.01 ? dm / dt : Infinity;
        parts.push(r >= hi ? 1 : r <= lo ? 0 : (r - lo) / (hi - lo));
        notes.push(`${t.role} ${rd(dm, 1)}/${rd(dt, 1)}`);
    }
    return { v: mean(parts), note: `motif/text distance mm: ${notes.join(', ')}` };
}

function mainImage(P) {
    const imgs = P.images.filter(im => (im.role === 'image') && im.motifArea > 0);
    return imgs.sort((a, b) => b.motifArea - a.motifArea)[0] || null;
}

/** Optisches Gewicht und Schwerpunkt je Element (für S4/S5). */
function weights(P, sc) {
    const h = sc.hierarchy;
    const out = [];
    for (const t of P.texts) {
        if (!t.vis.length) continue;
        const st = t.style;
        const ink = typeof st.ink === 'number' ? st.ink : 1;
        const accent = typeof st.accent === 'number' ? st.accent : 0;
        const bold = BOLD.test(String(st.fontStyle || '')) ? h.boldFactor : 1;
        const sizeF = st.size ? (st.size / h.sizeRef) ** h.sizeExponent : 1;
        let a = 0, sx = 0, sy = 0;
        for (const l of t.vis) { const A = area(l.rect), c = center(l.rect); a += A; sx += c[0] * A; sy += c[1] * A; }
        const w = a * h.textCoverage * ink * bold * sizeF * (1 + (h.accentFactor - 1) * accent);
        out.push({ id: t.id, role: t.role, w, c: a ? [sx / a, sy / a] : center(t.block) });
    }
    for (const im of P.images) {
        if (!im.motifArea) continue;
        const ink = typeof im.ink === 'number' ? im.ink : h.imageInk;
        out.push({ id: im.id, role: im.role, w: im.motifArea * ink, c: im.motifCenter });
    }
    return out;
}

function ranks(arr) {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
        i = j + 1;
    }
    return r;
}

/** Spearman-Rangkorrelation; null bei konstanter Reihe. */
export function spearman(x, y) {
    const rx = ranks(x), ry = ranks(y);
    const mx = mean(rx), my = mean(ry);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** S4 Hierarchie: optisches Gewicht soll der Rangfolge (rank 1 = wichtigstes) folgen. */
function scoreHierarchy(W, cfg, detail) {
    const ranked = W.filter(e => Number.isFinite(cfg.roles?.[e.role]?.rank));
    if (ranked.length < 2) return { v: null, note: 'fewer than 2 ranked elements' };
    const rho = spearman(ranked.map(e => -cfg.roles[e.role].rank), ranked.map(e => e.w));
    if (rho === null) return { v: null, note: 'ranks or weights constant' };
    const order = [...ranked].sort((a, b) => b.w - a.w).map(e => e.role);
    if (detail) detail.weights = Object.fromEntries(ranked.map(e => [`${e.role}#${e.id}`, rd(e.w, 1)]));
    return { v: (rho + 1) / 2, note: `ρ ${rd(rho, 2)}, by weight: ${order.join(' > ')}` };
}

/**
 * S5 Balance: Gewichtsverteilung links/rechts und oben/unten als gewichteter
 * Schwerpunkt (Momentengleichgewicht um center). Abweichung je Achse relativ
 * zu maxDistance [x, y], elliptisch kombiniert; vertikal toleranter.
 */
function scoreBalance(P, W, sc, detail) {
    const tot = W.reduce((s, e) => s + e.w, 0);
    if (!tot) return { v: null, note: 'no weighted elements' };
    const cx = W.reduce((s, e) => s + e.c[0] * e.w, 0) / tot, cy = W.reduce((s, e) => s + e.c[1] * e.w, 0) / tot;
    const pg = P.page, Wd = pg.right - pg.left, H = pg.bottom - pg.top;
    const tx = pg.left + sc.balance.center[0] * Wd, ty = pg.top + sc.balance.center[1] * H;
    const [mx, my] = sc.balance.maxDistance;
    const d = Math.hypot((cx - tx) / Wd / mx, (cy - ty) / H / my);
    if (detail) detail.centroid = { at: [rd(cx, 1), rd(cy, 1)], target: [rd(tx, 1), rd(ty, 1)] };
    return { v: clamp01(1 - d), note: `centroid ${rd((cx - pg.left) / Wd * 100, 0)} %/${rd((cy - pg.top) / H * 100, 0)} %` };
}

/** Größtes freies Rechteck auf einem Raster (Histogramm-Verfahren). */
function largestFree(free, rows, cols) {
    const hgt = new Array(cols).fill(0);
    let best = null;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) hgt[c] = free[r * cols + c] ? hgt[c] + 1 : 0;
        const st = [];
        for (let c = 0; c <= cols; c++) {
            const h = c < cols ? hgt[c] : 0;
            let start = c;
            while (st.length && st[st.length - 1].h >= h) {
                const top = st.pop();
                const a = top.h * (c - top.start);
                if (top.h && (!best || a > best.a)) best = { a, r0: r - top.h + 1, r1: r, c0: top.start, c1: c - 1 };
                start = top.start;
            }
            st.push({ h, start });
        }
    }
    return best;
}

/** S6 Weißraum: eingeklemmte Lücken (0 < g < Modul) und ein dominantes leeres Loch im Satzspiegel. */
function scoreWhitespace(P, sc, gaps, blocks, detail) {
    const ws = sc.whitespace;
    const mod = moduleMm(P, ws.module);
    let pinch = 1;
    const pinched = [];
    for (const g of gaps) {
        if (g.gap > 0.05 && g.gap < mod - 0.05) { pinch *= 1 - 0.5 * (mod - g.gap) / mod; pinched.push(rd(g.gap, 1)); }
    }
    const ta = P.typeArea, step = ws.gridMm;
    const cols = Math.max(1, Math.round((ta.right - ta.left) / step)), rows = Math.max(1, Math.round((ta.bottom - ta.top) / step));
    const cw = (ta.right - ta.left) / cols, ch = (ta.bottom - ta.top) / rows;
    const free = new Uint8Array(rows * cols).fill(1);
    const parts = blocks.flatMap(partsOf);
    for (const r of parts) {
        const c0 = Math.max(0, Math.floor((r.left - ta.left) / cw + 1e-6)), c1 = Math.min(cols - 1, Math.ceil((r.right - ta.left) / cw - 1e-6) - 1);
        const r0 = Math.max(0, Math.floor((r.top - ta.top) / ch + 1e-6)), r1 = Math.min(rows - 1, Math.ceil((r.bottom - ta.top) / ch - 1e-6) - 1);
        for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) free[y * cols + x] = 0;
    }
    const best = largestFree(free, rows, cols);
    const frac = best ? best.a / (rows * cols) : 0;
    const hole = 1 - clamp01((frac - ws.holeMax) / (ws.holeSoft || ws.holeMax));
    if (detail && best) detail.hole = { bounds: [ta.top + best.r0 * ch, ta.left + best.c0 * cw, ta.top + (best.r1 + 1) * ch, ta.left + (best.c1 + 1) * cw].map(v => rd(v, 1)), share: rd(frac, 2) };
    const v = (1 - ws.holeWeight) * pinch + ws.holeWeight * hole;
    return { v, note: `${pinched.length ? `pinched ${pinched.join('/')} mm` : 'no pinched gaps'}, largest hole ${rd(frac * 100, 0)} %` };
}

/** S7 Bildanteil: sichtbare Motivfläche / Satzspiegelfläche; 0 bei zero, linear steigend bis range[0], über range[1] weich fallend. */
function scoreImageShare(P, sc) {
    const imgs = P.images.filter(im => sc.imageShare.roles.includes(im.role));
    if (!imgs.length) return { v: null, note: 'no image' };
    if (imgs.every(im => !(im.motifRects || []).length)) return { v: null, note: 'no motif mask' };
    const share = imgs.reduce((s, im) => s + im.motifArea, 0) / area(P.typeArea);
    const { zero, soft } = sc.imageShare, [lo, hi] = sc.imageShare.range;
    const v = share < lo ? clamp01((share - zero) / (lo - zero)) : share > hi ? clamp01(1 - (share - hi) / soft) : 1;
    return { v, note: `motif ${rd(share * 100, 0)} % of type area` };
}

/** S8 Typografie: Flatter, Trennungen, kurze letzte Zeile, Headline-Balance, Zeichen pro Zeile. */
function scoreTypography(P, sc, cfg) {
    const ty = sc.typography;
    const parts = [], notes = [];
    for (const t of P.texts) {
        if (!t.vis.length) continue;
        const allow = cfg.roles?.[t.role]?.allow || {};
        const paras = [];
        let cur = [];
        t.lines.forEach((l, k) => {
            if (String(l.text ?? '').trim() !== '') cur.push(l);
            if (l.paragraphEnd || k === t.lines.length - 1) { if (cur.length) paras.push(cur); cur = []; }
        });
        if (t.role === 'headline' && t.vis.length > 1) {
            const ws = t.vis.map(l => l.width);
            const ratio = Math.min(...ws) / Math.max(...ws);
            const [lo, hi] = ty.headlineBalance;
            parts.push(clamp01((ratio - lo) / (hi - lo)));
            if (ratio < hi) notes.push(`headline lines ${rd(ratio, 2)}`);
            continue;
        }
        if (!allow.reflow) continue;
        for (const p of paras) {
            if (p.length < 2) continue;
            const last = p[p.length - 1];
            const maxW = Math.max(...p.map(l => l.width));
            const rel = last.width / maxW;
            const single = !/\s/.test(String(last.text).trim());
            const s = rel < ty.shortLastLine ? 0 : single ? 0.5 : 1;
            parts.push(s);
            if (s < 1) notes.push(`short last line ${rd(rel, 2)}${single ? ' (1 word)' : ''}`);
            const body = p.slice(0, -1).map(l => l.width);
            if (body.length >= 2) {
                const rag = std(body) / maxW;
                parts.push(1 - clamp01(rag / ty.ragMax));
                if (rag > ty.ragMax / 2) notes.push(`rag ${rd(rag, 2)}`);
            }
        }
        const nh = t.lines.filter(l => l.hyphenated).length;
        if (t.vis.length > 1) {
            let pen = nh * ty.hyphenPenalty;
            t.lines.forEach((l, k) => { if (l.hyphenated && t.lines[k + 1]?.hyphenated) pen += ty.hyphenPenalty; });
            parts.push(clamp01(1 - pen));
            if (nh) notes.push(`${nh} hyphen(s)`);
        }
        if (ty.bodyRoles.includes(t.role)) {
            const ls = t.vis.length > 1 ? t.vis.slice(0, -1) : t.vis;
            const cpl = mean(ls.map(l => String(l.text).trim().length));
            const [lo, hi] = ty.charsPerLine;
            parts.push(cpl < lo ? clamp01(1 - (lo - cpl) / ty.charsSoft) : cpl > hi ? clamp01(1 - (cpl - hi) / ty.charsSoft) : 1);
            notes.push(`${rd(cpl, 0)} chars/line`);
        }
    }
    if (!parts.length) return { v: null, note: 'no multi-line text' };
    return { v: mean(parts), note: notes.join(', ') };
}

/**
 * S9 Lesefluss: Z-Muster (Zeilen nach Überlappung, dann links→rechts) gegen
 * readingOrder. Paare, die laut readingOrderFlexible tauschen dürfen, zählen nicht.
 */
function scoreReadingFlow(P, sc, cfg) {
    const ro = P.texts.filter(t => t.vis.length && Number.isFinite(cfg.roles?.[t.role]?.readingOrder));
    if (ro.length < 2) return { v: null, note: 'fewer than 2 texts with readingOrder' };
    const before = (a, b) => zBefore(a.block, b.block, sc.readingFlow.rowOverlap);
    let pairs = 0, inv = 0;
    const bad = [];
    for (let i = 0; i < ro.length; i++) for (let j = 0; j < ro.length; j++) {
        if (i === j) continue;
        const a = ro[i], b = ro[j];
        if (orderFlexible(cfg.roles, a.role, b.role)) continue;
        if (!(cfg.roles[a.role].readingOrder < cfg.roles[b.role].readingOrder)) continue;
        pairs++;
        if (!before(a, b)) { inv++; bad.push(`${b.role} before ${a.role}`); }
    }
    if (!pairs) return { v: null, note: 'readingOrder not distinct' };
    return { v: 1 - inv / pairs, note: inv ? bad.join(', ') : 'Z order matches' };
}

/** S10 Blickrichtung: Motivrichtung zeigt zum Text-Schwerpunkt (1) oder davon weg (0). */
function scoreGaze(P, sc) {
    const im = mainImage(P);
    if (!im) return { v: null, note: 'no image motif' };
    const d = im.features?.direction;
    if (!d) return { v: null, note: 'no image features' };
    if (d.dir === 'none' || !(d.confidence >= sc.gaze.minConfidence) || typeof d.angle !== 'number') return { v: 0.5, note: `direction ${d.dir} ${d.confidence ?? 0} (low confidence, neutral)` };
    let a = 0, sx = 0, sy = 0;
    for (const t of P.texts) for (const l of t.vis) { const A = area(l.rect), c = center(l.rect); a += A; sx += c[0] * A; sy += c[1] * A; }
    if (!a) return { v: null, note: 'no text' };
    const origin = im.features?.centroid?.page || im.motifCenter;
    const tx = sx / a - origin[0], ty = sy / a - origin[1];
    const len = Math.hypot(tx, ty);
    if (len < 1e-6) return { v: 0.5, note: 'text centroid on motif centroid' };
    const rad = d.angle * Math.PI / 180;
    const cos = (Math.cos(rad) * tx - Math.sin(rad) * ty) / len;
    const k = clamp01(d.confidence / sc.gaze.fullConfidence);
    return { v: 0.5 + 0.5 * cos * k, note: `motif looks ${d.dir} (${d.confidence}), cos to text ${rd(cos, 2)}` };
}

// ------------------------------------------------------------------ Gesamt

/**
 * Nur die harten Regeln H1–H12 (für frühes Verwerfen im Solver).
 * @param {Scene} scene
 * @returns {{valid:boolean, violations:Array<{rule:string, ids:Array, detail:string}>, skipped:Array<{rule:string, ids:Array, reason:string}>}}
 */
export function checkHardRules(scene) {
    const sc = scoringConfig(scene.config || {});
    const { violations, skipped } = checkRules(prepare(scene, sc), scene, sc);
    return { valid: violations.length === 0, violations, skipped };
}

/**
 * Bewertet eine Szene: harte Regeln und gewichteter Score (Σ wᵢ·Sᵢ / Σ wᵢ über
 * alle Kriterien mit Wert). Reine Funktion ohne I/O.
 * @param {Scene} scene
 * @param {{detail?: boolean, skipScoreIfInvalid?: boolean}} [opts] detail: Fluchtlinien, Lücken,
 *   Schwerpunkt, Gewichte, größtes Loch; skipScoreIfInvalid: bei Verstoß kein Score (schneller)
 * @returns {{valid:boolean, violations:Array<{rule:string, ids:Array, detail:string}>, skipped:Array, score:number|null,
 *   breakdown:Object<string,{v:number|null, w:number, note?:string}>, detail?:object}}
 */
export function scoreLayout(scene, { detail = false, skipScoreIfInvalid = false } = {}) {
    const cfg = scene.config || {};
    const sc = scoringConfig(cfg);
    const P = prepare(scene, sc);
    const { violations, skipped } = checkRules(P, scene, sc);
    if (skipScoreIfInvalid && violations.length) return { valid: false, violations, skipped, score: null, breakdown: null };
    const det = detail ? {} : null;
    const blocks = blocksOf(P);
    const gaps = adjacentGaps(blocks);
    const W = weights(P, sc);
    const res = {
        S1: scoreAlignment(P, sc, det),
        S2: scoreSpacing(P, sc, gaps, det),
        S3: scoreGrouping(P, sc, cfg),
        S4: scoreHierarchy(W, cfg, det),
        S5: scoreBalance(P, W, sc, det),
        S6: scoreWhitespace(P, sc, gaps, blocks, det),
        S7: scoreImageShare(P, sc),
        S8: scoreTypography(P, sc, cfg),
        S9: scoreReadingFlow(P, sc, cfg),
        S10: scoreGaze(P, sc),
    };
    const breakdown = {};
    let ws = 0, acc = 0;
    for (const k of CRITERIA) {
        const w = sc.weights[k] ?? 0;
        const v = res[k].v === null || res[k].v === undefined ? null : rd(clamp01(res[k].v));
        breakdown[k] = { v, w, ...(res[k].note ? { note: res[k].note } : {}) };
        if (v !== null && w > 0) { ws += w; acc += w * v; }
    }
    const out = { valid: violations.length === 0, violations, skipped, score: ws ? rd(acc / ws) : null, breakdown };
    if (det) out.detail = det;
    return out;
}

/**
 * Bilddaten einer Szene aus Maske (getMotifMask) und Merkmalen (getImageFeatures)
 * für eine Platzierung – rein, ohne I/O; für Solver-Kandidaten mit neuer Bildgeometrie.
 * @param {object|null} mask normierte Maske
 * @param {object|null} feat normierte Merkmale
 * @param {{imageBounds:number[], frameBounds:number[], pageBounds?:number[], flip?:string}} geometry
 * @returns {{motifRects: Array|null, motifFullArea: number|null, features: object|null}}
 */
export function placeImageData(mask, feat, geometry) {
    const placement = placementFromGeometry(geometry);
    const placed = mask ? placeMask(mask, placement) : null;
    return {
        motifRects: placed ? motifRects(placed) : null,
        motifFullArea: placed ? placed.cells.reduce((s, c) => s + area(c.rect), 0) : null,
        features: feat?.motif ? placeFeatures(feat, placement, { maxEdges: 12 }) : null,
    };
}

/** Hauptfunktion für den Solver (gleich scoreLayout). */
export const scoreScene = scoreLayout;

/** Hilfsfunktion für Solver/Tests: Rechteck-Array → Motivrechteck. */
export const rect = (t, l, b, r) => ({ top: t, left: l, bottom: b, right: r });
export { rectToArray };
