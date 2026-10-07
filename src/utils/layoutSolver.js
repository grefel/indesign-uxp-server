/**
 * Layout-Solver für kleine Artikel-Anzeigen – reine Logik ohne InDesign.
 *
 * Eingaben: Layout-Modell (get_layout_model), Breiten-Tabellen der Textrahmen
 * (Zeilen relativ zur Rahmenoberkante), Bildmaske und -merkmale. Daraus werden
 * Kandidaten erzeugt (Bildzone × Textspalte × Textvarianten × Anker), per
 * harter Regeln vorgefiltert, als Szene mit scoreLayout() bewertet und divers
 * ausgewählt. Kandidaten sind serialisierbar (toSpec) und werden vom Handler
 * in InDesign angewandt.
 *
 * Längen in mm (Seitenkoordinaten), Schriftgrade/Zeilenabstände in pt.
 * Bounds [top, left, bottom, right], Rechtecke intern { top, left, bottom, right }.
 */
import { boundsToRect, intersectRect, rectDistance, unionRect, rectToArray } from './imageMask.js';
import { makeMappers } from './imageFeatures.js';
import { deepMerge } from './layoutModel.js';
import { scoreLayout, scoringConfig, colorInk, placeImageData, PT_MM } from './layoutScore.js';

export const SOLVER_DEFAULTS = {
    measure: {
        // Breiten-Tabelle: minWidth .. Satzspiegelbreite in step-Schritten (mm)
        minWidth: 20,
        step: 2.5,
        // Schriftgrad-Stufen je Richtung innerhalb allow.pointSize (2 → −15 %, −7,5 %, 0, +7,5 %, +15 %)
        sizeSteps: 2,
        // Trennvarianten je Rolle (Namen aus config.hyphenation.variants oder 'asIs'); default = übrige Rollen
        hyphenation: { headline: ['off'], default: ['off', 'on'] },
        // Eine Probe (Breite setzen + Zeilen lesen) kostet ~50 ms; größere Skripte riskieren Bridge-Timeout (30 s) und InDesign-Hänger
        maxProbesPerScript: 60,
    },
    // Faktoren auf den mitskalierten Zeilenabstand der Headline (geklemmt auf allow.leading)
    headlineLeading: [0.9, 1],
    topologies: ['imageLeft', 'imageRight', 'imageTop', 'imageBottom', 'overlay'],
    // Anteil der Bildzone am Satzspiegel (Breite bzw. Höhe)
    splits: [0.4, 0.5, 0.6],
    // Bild randabfallend an der Außenseite (und unten) erzeugen
    bleed: true,
    // Motivgröße relativ zu „passt in Zone“: contain ≤ 1, bleed > 1 (bis minPpi)
    imageScales: { contain: [1, 0.85], bleed: [1.2, 1.4], overlay: [0.7, 0.6, 0.5] },
    // Abstand Text ↔ Bildzone und zwischen Textblöcken: Modulname (format.modules) oder mm
    textImageGap: 'margin',
    blockGap: 'gap',
    // vorausgewählte Textvarianten je Spaltenbreite
    variantsPerText: { headline: 3, default: 2 },
    stackAnchors: ['top', 'motifTop', 'center', 'bottom'],
    priceAnchors: ['below', 'belowRight', 'cornerBR', 'cornerBL', 'groundR', 'groundL', 'motifSide', 'besideDesc'],
    // Höchstzahl bewerteter Kandidaten (Rest geschichtet per seed gezogen)
    budget: 4000,
    polygon: { enabled: true, maxShapes: 24, gap: 1.5, minWidth: 12, slice: 0.5 },
    diversity: { minDistance: 0.5 },
    seed: 1,
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const rd = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);
const clamp01 = v => Math.max(0, Math.min(1, v));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = a => { const m = mean(a); return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : 0; };
const area = r => (r ? Math.max(0, r.bottom - r.top) * Math.max(0, r.right - r.left) : 0);

/** Solver-Parameter: Defaults mit config.solver mischen und prüfen. */
export function solverConfig(config = {}, overrides = {}) {
    const s = deepMerge(deepMerge(SOLVER_DEFAULTS, isObj(config.solver) ? config.solver : {}), overrides);
    const pos = (v, l) => { if (!(typeof v === 'number' && v > 0)) throw new Error(`config.solver.${l} must be a number > 0`); };
    pos(s.measure.minWidth, 'measure.minWidth');
    pos(s.measure.step, 'measure.step');
    pos(s.budget, 'budget');
    if (!Array.isArray(s.topologies) || !s.topologies.length) throw new Error('config.solver.topologies must be a non-empty array');
    const known = ['imageLeft', 'imageRight', 'imageTop', 'imageBottom', 'overlay'];
    for (const t of s.topologies) if (!known.includes(t)) throw new Error(`config.solver.topologies: unknown '${t}' (allowed ${known.join(', ')})`);
    for (const f of s.splits) if (!(f > 0.15 && f < 0.85)) throw new Error('config.solver.splits must be fractions between 0.15 and 0.85');
    return s;
}

/** Deterministischer Zufall (mulberry32). */
export function rng(seed = 1) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function moduleMm(fmt, key) {
    if (typeof key === 'number') return key;
    return fmt.modules?.[key] ?? Math.min(...fmt.margins) / 2;
}

// ------------------------------------------------------------------ Messplan

/**
 * Parameter für das UXP-Messskript (wird als JSON eingebettet).
 * @param {object} config aufgelöste Projekt-Konfiguration
 * @param {object} sc solverConfig()
 * @param {{layer?:string|null}} opts
 */
export function measurePlan(config, sc, { layer = null } = {}) {
    const hy = config.hyphenation;
    const resolve = names => names.map(n => {
        if (n === 'asIs') return { name: n, props: {} };
        if (!hy.variants[n]) throw new Error(`config.solver.measure.hyphenation: unknown variant '${n}'`);
        return { name: n, props: hy.variants[n] };
    });
    const byRole = {};
    for (const [role, names] of Object.entries(sc.measure.hyphenation || {})) byRole[role] = resolve(names);
    if (!byRole.default) byRole.default = resolve(hy.default?.length ? hy.default : ['asIs']);
    return {
        layer,
        exclude: layer ? null : config.sourceLayers?.exclude || null,
        rules: config.match,
        roles: config.roles,
        hyph: byRole,
        minW: sc.measure.minWidth,
        step: sc.measure.step,
        sizeSteps: sc.measure.sizeSteps,
        maxProbes: sc.measure.maxProbesPerScript,
    };
}

/** Erlaubte Schriftgrade (pt, auf 0,25 pt gerundet) gegenüber ref innerhalb allow.pointSize. */
export function plannedSizes(ref, allow, steps) {
    const f = typeof allow?.pointSize === 'number' ? allow.pointSize : 0;
    if (!f || !steps) return [ref];
    const out = [];
    for (let k = -steps; k <= steps; k++) {
        let v = Math.round(ref * (1 + f * k / steps) * 4) / 4;
        v = Math.min(ref * (1 + f), Math.max(ref * (1 - f), v));
        v = Math.round(v * 100) / 100;
        if (!out.includes(v)) out.push(v);
    }
    // Referenzgrad zuerst
    return out.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b);
}

/**
 * Mess-Aufträge aus dem Modell: je Textrahmen × Grad × Trennvariante eine
 * Breitenliste (keepTogether: nur Satzspiegelbreite, Trennung aus).
 * @returns {Array<{id:number, role:string, pt:number, ref:number, hyph:{name:string, props:object}, keep:boolean, widths:number[]}>}
 */
export function planMeasureJobs(model, plan) {
    const ta = model.format.typeArea;
    const maxW = Math.round((ta[3] - ta[1]) * 100) / 100;
    const widths = [];
    for (let w = plan.minW; w < maxW - 1e-6; w += plan.step) widths.push(Math.round(w * 100) / 100);
    widths.push(maxW);
    const jobs = [];
    for (const it of model.items) {
        if (it.kind !== 'text' || !it.style) continue;
        const allow = plan.roles[it.role]?.allow || {};
        const keep = !!allow.keepTogether;
        const sizes = keep ? [it.style.size] : plannedSizes(it.style.size, allow, plan.sizeSteps);
        const vars = keep ? [{ name: 'off', props: { hyphenation: false } }]
            : allow.hyphenation ? (plan.hyph[it.role] || plan.hyph.default) : [{ name: 'asIs', props: {} }];
        for (const pt of sizes) for (const hyph of vars) {
            jobs.push({ id: it.id, role: it.role, pt, ref: it.style.size, hyph, keep, widths: keep ? [maxW] : widths });
        }
    }
    return jobs;
}

/** Aufträge in Skript-Pakete mit höchstens max Proben teilen (lange Breitenlisten werden aufgeteilt). */
export function batchJobs(jobs, max = 60) {
    const batches = [];
    let cur = [], n = 0;
    for (const job of jobs) {
        let rest = job.widths;
        while (rest.length) {
            const room = max - n;
            if (room <= 0) { batches.push(cur); cur = []; n = 0; continue; }
            const part = rest.slice(0, room);
            rest = rest.slice(room);
            cur.push({ ...job, widths: part });
            n += part.length;
        }
    }
    if (cur.length) batches.push(cur);
    return batches;
}

/**
 * Messergebnisse aller Pakete zu Rahmen-Tabellen zusammenführen; gleiche
 * Umbrüche benachbarter Breiten werden zu Bereichen w:[min, max] vereinigt.
 * @param {Array<object>} results je Paket { frames:[{id, role, ref, refLd, align, paras, rows:[{w, pt, ld, hyph, ov, lines}]}] }
 */
export function mergeMeasurements(results) {
    const frames = new Map();
    for (const r of results) for (const f of r.frames || []) {
        if (!frames.has(f.id)) frames.set(f.id, { ...f, rows: [] });
        const F = frames.get(f.id);
        if (f.error) { F.error = f.error; continue; }
        F.rows.push(...(f.rows || []));
    }
    for (const F of frames.values()) {
        const groups = new Map();
        for (const row of F.rows) {
            const k = `${row.pt}|${row.hyph}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(row);
        }
        const merged = [];
        for (const rows of groups.values()) {
            rows.sort((a, b) => a.w[0] - b.w[0]);
            for (const row of rows) {
                const last = merged[merged.length - 1];
                const sig = row.ov ? '#ov' : (row.lines || []).map(l => l[0]).join('|');
                if (last && last.pt === row.pt && last.hyph === row.hyph && last._sig === sig) { last.w[1] = Math.max(last.w[1], row.w[1]); continue; }
                merged.push({ ...row, w: [...row.w], _sig: sig });
            }
        }
        F.rows = merged.map(({ _sig, ...r }) => r);
    }
    return { frames: [...frames.values()] };
}

// ------------------------------------------------------------------ Textvarianten

/**
 * Textvarianten eines gemessenen Rahmens. Zeilen bleiben relativ zur
 * Rahmenoberkante/-linken. Headline-Zeilenabstand wird synthetisch variiert
 * (Grundlinien-Abstände skaliert; gilt für einen Absatz mit einheitlichem Durchschuss).
 * @param {object} m Messung { id, role, ref, refLd, align, paras, inset, rows:[{w:[min,max], pt, ld, hyph, ov, lines}] }
 * @param {object} allow config.roles[role].allow
 * @param {{origLeading:number, leadingFactors:number[]}} o
 */
export function textVariants(m, allow = {}, { origLeading = m.refLd, leadingFactors = [1] } = {}) {
    const out = [];
    const lf = typeof allow.leading === 'number' ? allow.leading : 0;
    const ldLo = origLeading * (1 - lf), ldHi = origLeading * (1 + lf);
    for (const row of m.rows || []) {
        if (row.ov || !row.lines?.length) continue;
        const base = row.lines.map(l => ({ text: l[0], base: l[1], asc: l[2], desc: l[3], x: l[4], width: l[5], pe: !!l[6], hy: !!l[7] }));
        const lds = new Set();
        const canLead = lf > 0 && m.paras === 1 && base.length > 1;
        for (const f of canLead ? leadingFactors : [1]) lds.add(rd(Math.min(ldHi, Math.max(ldLo, row.ld * f)), 2));
        if (!canLead) { lds.clear(); lds.add(rd(row.ld, 2)); }
        for (const ld of lds) {
            const k = row.ld ? ld / row.ld : 1;
            const fb = base[0].base;
            const lines = base.map(l => ({ ...l, base: fb + (l.base - fb) * k }));
            const vis = lines.filter(l => String(l.text).trim() !== '');
            if (!vis.length) continue;
            const last = vis[vis.length - 1];
            out.push({
                key: `${m.id}|${row.pt}|${ld}|${row.hyph}|${row.w[0]}`,
                elId: m.id, role: m.role, pt: row.pt, ld, ldAuto: Math.abs(ld - row.ld) < 0.01, hyph: row.hyph,
                wMin: row.w[0], wMax: row.w[1], align: m.align,
                lines,
                n: vis.length,
                top: Math.min(...vis.map(l => l.base - l.asc)),
                bottom: Math.max(...vis.map(l => l.base + l.desc)),
                fb, lb: last.base,
                maxW: Math.max(...vis.map(l => l.x + l.width)),
                hyphens: lines.filter(l => l.hy).length,
            });
        }
    }
    return out;
}

/** Lokale typografische Güte einer Variante 0..1 (Vorauswahl, angelehnt an S8). */
export function variantQuality(tv, role, ty = {}) {
    const vis = tv.lines.filter(l => String(l.text).trim() !== '');
    const ws = vis.map(l => l.width);
    const parts = [];
    if (role === 'headline') {
        const [lo, hi] = ty.headlineBalance || [0.3, 0.75];
        parts.push(vis.length > 1 ? clamp01((Math.min(...ws) / Math.max(...ws) - lo) / (hi - lo)) : 1);
        parts.push(tv.hyphens ? 0.3 : 1);
        parts.push(vis.length <= 3 ? 1 : 0.5);
    } else {
        if (vis.length > 1) {
            const maxW = Math.max(...ws), rel = ws[ws.length - 1] / maxW;
            parts.push(rel < (ty.shortLastLine ?? 0.2) ? 0 : /\s/.test(String(vis[vis.length - 1].text).trim()) ? 1 : 0.5);
            const body = ws.slice(0, -1);
            if (body.length > 1) parts.push(1 - clamp01(std(body) / maxW / (ty.ragMax ?? 0.15)));
            parts.push(clamp01(1 - tv.hyphens * (ty.hyphenPenalty ?? 0.15)));
            const cpl = mean(vis.slice(0, -1).map(l => String(l.text).length));
            const [lo, hi] = ty.charsPerLine || [30, 60];
            parts.push(cpl < lo ? clamp01(1 - (lo - cpl) / 15) : cpl > hi ? clamp01(1 - (cpl - hi) / 15) : 1);
        } else parts.push(1);
    }
    return mean(parts);
}

/**
 * Varianten, die in eine Spalte der Breite W passen: Rahmenbreite = min(W, wMax).
 * Top-k nach Güte, verschieden nach (Zeilenzahl, Grad).
 */
export function pickVariants(tvs, W, k, role, ty) {
    const fit = tvs.filter(tv => tv.wMin <= W + 1e-6);
    const scored = fit.map(tv => ({ tv, q: variantQuality(tv, role, ty) + (role === 'headline' ? 0.05 * (tv.pt / (tvs[0]?.pt || tv.pt)) : 0) }))
        .sort((a, b) => b.q - a.q || b.tv.wMin - a.tv.wMin);
    const out = [], seen = new Set();
    for (const s of scored) {
        const key = `${s.tv.n}|${s.tv.pt}|${s.tv.ld}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...s.tv, W: rd(Math.min(W, s.tv.wMax), 2), q: s.q });
        if (out.length >= k) break;
    }
    return out;
}

/** Zeilen einer Variante an Rahmenposition (x, y) und Rahmenbreite W; Ausrichtung center/right verschiebt. */
export function placeLines(tv, x, y, W = tv.wMin) {
    const a = String(tv.align || '').toUpperCase();
    const dx = /CENTER/.test(a) ? (W - tv.wMin) / 2 : /RIGHT/.test(a) && !/JUSTIFIED/.test(a) ? W - tv.wMin : 0;
    return tv.lines.map(l => ({
        text: l.text, baseline: y + l.base, top: y + l.base - l.asc, bottom: y + l.base + l.desc,
        x: x + l.x + dx, width: l.width, hyphenated: l.hy, paragraphEnd: l.pe,
    }));
}

// ------------------------------------------------------------------ Bild

/**
 * Platzierungsunabhängige Bilddaten in normierten Koordinaten (Seitenorientierung):
 * Motiv-BBox, Mindestausschnitt (safeCrop), Standlinie.
 */
export function imageNorm(mask, feat, { flipH = false, flipV = false } = {}) {
    const m = makeMappers({ imageBounds: [0, 0, 1, 1], flipH, flipV });
    let motif = null, safe = null, ground = null;
    if (feat?.motif) {
        motif = m.nRect(feat.motif);
        if (feat.focus) {
            const bx = (feat.motif[2] - feat.motif[0]) * 0.1, by = (feat.motif[3] - feat.motif[1]) * 0.1;
            const r = feat.focus.region;
            safe = m.nRect([Math.max(feat.motif[0], r[0] - bx), Math.max(feat.motif[1], r[1] - by), Math.min(feat.motif[2], r[2] + bx), Math.min(feat.motif[3], r[3] + by)]);
        }
        if (feat.ground) {
            const y = (feat.ground.p0[1] + feat.ground.p1[1]) / 2;
            ground = flipV ? 1 - y : y;
        }
    } else if (mask?.cells?.length) {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const c of mask.cells) { x0 = Math.min(x0, c[2]); y0 = Math.min(y0, c[3]); x1 = Math.max(x1, c[4]); y1 = Math.max(y1, c[5]); }
        motif = m.nRect([x0, y0, x1, y1]);
    }
    if (!motif) motif = [0, 0, 1, 1];
    return { motif, safe: safe || motif, ground };
}

const snap = (v, step, base = 0) => base + Math.round((v - base) / step) * step;

/**
 * Bild-Setups: Topologie, Bildzone, Textspalte, Platzierung (Bild-/Rahmenbounds),
 * sichtbare Motivrechtecke und Merkmale in Seiten-mm.
 */
export function imageSetups(P, sc) {
    const { fmt, img } = P;
    const TA = boundsToRect(fmt.typeArea), PB = boundsToRect(fmt.page.bounds), BB = boundsToRect(fmt.imageBleedBox);
    const g = moduleMm(fmt, sc.blockGap), gTI = moduleMm(fmt, sc.textImageGap);
    if (!img) return [{ key: 'text', topo: 'textOnly', C: TA, image: null }];
    const out = [];
    const taW = TA.right - TA.left, taH = TA.bottom - TA.top;
    const [mt, ml, mb, mr] = img.norm.motif;
    const mbw = mr - ml, mbh = mb - mt;
    const maxImgW = img.px ? img.px[0] / img.minPpi * 25.4 : Infinity;

    const push = (topo, split, Z, C, bleedSides, kind, scales, anchors) => {
        const Zw = Z.right - Z.left, Zh = Z.bottom - Z.top;
        const fitW = Math.min(Zw / mbw, Zh * img.aspect / mbh);
        for (const f of scales) {
            const imgW = fitW * f;
            if (imgW > maxImgW + 1e-6) continue;
            const imgH = imgW / img.aspect;
            const mW = mbw * imgW, mH = mbh * imgH;
            for (const [ha, va] of anchors) {
                const mx = ha === 'left' ? Z.left : ha === 'right' ? Z.right - mW : Z.left + (Zw - mW) / 2;
                const my = va === 'top' ? Z.top : va === 'bottom' ? Z.bottom - mH : Z.top + (Zh - mH) / 2;
                const ib = { left: mx - ml * imgW, top: my - mt * imgH };
                ib.right = ib.left + imgW; ib.bottom = ib.top + imgH;
                const fz = { ...Z };
                for (const s of bleedSides) fz[s] = BB[s];
                const frame = intersectRect(fz, ib);
                if (!frame) continue;
                // Rahmenkante an Anschnitt-Seite muss den Bildanschnitt erreichen
                if (bleedSides.some(s => (s === 'top' || s === 'left' ? frame[s] > BB[s] + 0.01 : frame[s] < BB[s] - 0.01))) continue;
                const motifR = { left: mx, top: my, right: mx + mW, bottom: my + mH };
                const visible = intersectRect(frame, PB);
                // Motiv nur an Anschnitt-Seiten beschneiden
                const cutSides = ['top', 'left', 'bottom', 'right'].filter(s => (s === 'top' || s === 'left' ? motifR[s] < visible[s] - 0.05 : motifR[s] > visible[s] + 0.05));
                if (cutSides.some(s => !bleedSides.includes(s))) continue;
                const [st, sl, sb, sr] = img.norm.safe;
                const safeR = { left: ib.left + sl * imgW, top: ib.top + st * imgH, right: ib.left + sr * imgW, bottom: ib.top + sb * imgH };
                if (safeR.left < visible.left - 0.05 || safeR.top < visible.top - 0.05 || safeR.right > visible.right + 0.05 || safeR.bottom > visible.bottom + 0.05) continue;
                const ppi = img.px ? img.px[0] / (imgW / 25.4) : null;
                out.push({
                    key: `${topo}|${split ?? ''}|${bleedSides.join('')}|${kind}${f}|${ha}${va}`,
                    topo, split, bleed: bleedSides, kind, scale: f, anchor: `${ha}-${va}`,
                    Z, C,
                    image: {
                        frame: [frame.top, frame.left, frame.bottom, frame.right].map(v => rd(v, 3)),
                        imageBounds: [ib.top, ib.left, ib.bottom, ib.right].map(v => rd(v, 3)),
                        effPpi: ppi ? [rd(ppi, 0), rd(ppi, 0)] : null,
                        widthMm: rd(imgW, 2),
                    },
                });
            }
        }
    };

    const contain = sc.imageScales.contain, bleedS = sc.imageScales.bleed;
    for (const topo of sc.topologies) {
        if (topo === 'overlay') {
            const anchors = [['right', 'bottom'], ['left', 'bottom'], ['center', 'bottom']];
            push(topo, null, TA, TA, [], 'overlay', sc.imageScales.overlay, anchors);
            continue;
        }
        for (const f of sc.splits) {
            if (topo === 'imageLeft' || topo === 'imageRight') {
                const left = topo === 'imageLeft';
                const xs = snap(left ? TA.left + f * taW : TA.right - f * taW, g, TA.left);
                const Z = left ? { ...TA, right: xs } : { ...TA, left: xs };
                const C = left ? { ...TA, left: xs + gTI } : { ...TA, right: xs - gTI };
                if (C.right - C.left < sc.measure.minWidth) continue;
                const outer = left ? 'left' : 'right', inner = left ? 'right' : 'left';
                push(topo, f, Z, C, [], 'contain', contain, [[outer, 'center'], [outer, 'bottom'], ['center', 'center']]);
                if (sc.bleed) {
                    push(topo, f, { ...Z, [outer]: PB[outer] }, C, [outer], 'bleed', bleedS, [[inner, 'center'], [inner, 'bottom']]);
                    push(topo, f, { ...Z, [outer]: PB[outer], bottom: PB.bottom }, C, [outer, 'bottom'], 'bleed', bleedS, [[inner, 'top']]);
                }
            } else {
                const top = topo === 'imageTop';
                const ys = snap(top ? TA.top + f * taH : TA.bottom - f * taH, g, TA.top);
                const Z = top ? { ...TA, bottom: ys } : { ...TA, top: ys };
                const C = top ? { ...TA, top: ys + gTI } : { ...TA, bottom: ys - gTI };
                if (C.bottom - C.top < 8) continue;
                const outer = top ? 'top' : 'bottom', inner = top ? 'bottom' : 'top';
                push(topo, f, Z, C, [], 'contain', contain, [['center', outer], ['left', outer], ['right', outer]]);
                if (sc.bleed) push(topo, f, { ...Z, [outer]: PB[outer] }, C, [outer], 'bleed', bleedS, [['center', inner], ['right', inner]]);
            }
        }
    }
    return out;
}

/** Motivrechtecke, -BBox, Standlinie und Merkmale eines Setups in Seiten-mm (gecacht am Setup). */
export function placeSetupImage(setup, P) {
    if (!setup.image || setup.placed) return setup.placed;
    const { img, fmt } = P;
    const d = placeImageData(img.mask, img.feat, {
        imageBounds: setup.image.imageBounds, frameBounds: setup.image.frame, pageBounds: fmt.page.bounds, flip: img.flip,
    });
    const motif = d.motifRects || [];
    const box = unionRect(motif);
    const gl = d.features?.groundLine;
    setup.placed = {
        motifRects: motif, motifBox: box, features: d.features,
        ground: gl && Math.abs(gl.angle) <= 2 ? (gl.yLeft + gl.yRight) / 2 : box?.bottom ?? null,
    };
    return setup.placed;
}

// ------------------------------------------------------------------ Kandidaten

/** Rechteck einer Zeile. */
const lineRect = l => ({ top: l.top, bottom: l.bottom, left: l.x, right: l.x + l.width });

function blockBox(lines) {
    return unionRect(lines.filter(l => String(l.text).trim() !== '').map(lineRect));
}

/** Harte Vorprüfung ohne Scorer: Satzspiegel, Textabstände, Motivabstand. Liefert Verstöße je Element-id. */
export function prefilter(cand, P, { minGap = 1, textGap = 1 } = {}) {
    const TA = boundsToRect(P.fmt.typeArea);
    const bad = {};
    const tol = 0.05;
    for (const t of cand.texts) {
        const b = t.box;
        if (!b || b.top < TA.top - tol || b.left < TA.left - tol || b.bottom > TA.bottom + tol || b.right > TA.right + tol) (bad[t.id] ||= []).push('typeArea');
    }
    for (let i = 0; i < cand.texts.length; i++) for (let j = i + 1; j < cand.texts.length; j++) {
        const a = cand.texts[i], b = cand.texts[j];
        if (rectDistance(a.box, b.box) >= textGap) continue;
        const close = a.lines.some(la => b.lines.some(lb => String(la.text).trim() && String(lb.text).trim() && rectDistance(lineRect(la), lineRect(lb)) < textGap));
        if (close) { (bad[a.id] ||= []).push(`text:${b.id}`); (bad[b.id] ||= []).push(`text:${a.id}`); }
    }
    const pl = cand.placed;
    if (pl?.motifBox) {
        for (const t of cand.texts) {
            if (rectDistance(t.box, pl.motifBox) >= minGap) continue;
            const hit = t.lines.some(l => {
                if (!String(l.text).trim()) return false;
                const r = lineRect(l);
                if (rectDistance(r, pl.motifBox) >= minGap) return false;
                return pl.motifRects.some(m => rectDistance(r, m) < minGap);
            });
            if (hit) (bad[t.id] ||= []).push('motif');
        }
    }
    return bad;
}

/** Element-Eintrag eines Kandidaten aus Variante und Rahmenposition. */
function placeText(T, tv, x, y, W) {
    const lines = placeLines(tv, x, y, W);
    const box = blockBox(lines);
    return {
        id: T.id, role: T.role, tv, x, y, W,
        frame: [y, x, y + tv.bottom + 0.3, x + W].map(v => rd(v, 3)),
        lines, box,
    };
}

/**
 * Alle Kandidaten eines Setups. Texte mit readingOrder (ohne keepTogether)
 * werden gestapelt, keepTogether-Texte (Preis) frei an Ankern platziert.
 */
export function candidatesForSetup(setup, P, sc, out, stats) {
    const { fmt } = P;
    const TA = boundsToRect(fmt.typeArea);
    const g = moduleMm(fmt, sc.blockGap);
    const C = setup.C;
    const pl = placeSetupImage(setup, P);
    const stackEls = P.texts.filter(t => !t.keep && Number.isFinite(t.ro)).sort((a, b) => a.ro - b.ro);
    const freeEls = P.texts.filter(t => t.keep);
    const fixedEls = P.texts.filter(t => !t.keep && !Number.isFinite(t.ro));
    const ty = scoringConfig(P.config).typography;
    const Wc = C.right - C.left;
    const colWidths = setup.topo === 'overlay' ? [Wc, Wc * 0.75, Wc * 0.6, Wc * 0.5].map(w => snap(w, 0.5)) : [Wc];
    const price = freeEls[0] || null;
    const ptv = price ? price.tvs[0] : null;
    const pw = ptv ? ptv.maxW + 0.2 : 0;
    const capOf = (T, tv) => (T.metrics?.cap ? T.metrics.cap * tv.pt / T.ref : tv.pt * PT_MM * 0.7);

    for (const W of colWidths) {
        for (const side of setup.topo === 'overlay' ? ['left', 'right'] : ['left']) {
            const cl = side === 'left' ? C.left : C.right - W;
            const cr = cl + W;
            // Varianten je Stack-Element, letzte Stack-Zeile ggf. schmaler (Preis daneben)
            const lastIdx = stackEls.length - 1;
            const choices = stackEls.map((T, i) => {
                const k = sc.variantsPerText[T.role] ?? sc.variantsPerText.default;
                const res = pickVariants(T.tvs, W, k, T.role, ty).map(tv => ({ tv, narrow: false }));
                if (i === lastIdx && price && W - pw - g >= sc.measure.minWidth) {
                    for (const tv of pickVariants(T.tvs, W - pw - g, Math.max(1, k - 1), T.role, ty)) res.push({ tv, narrow: true });
                }
                return res;
            });
            if (choices.some(c => !c.length)) { stats.noVariant++; continue; }
            // kartesisches Produkt der Stack-Varianten
            let combos = [[]];
            for (const c of choices) combos = combos.flatMap(prev => c.map(x => [...prev, x]));

            for (const combo of combos) {
                const narrow = combo.length && combo[combo.length - 1].narrow;
                // Stack-Höhe (Zeilenboxen, Abstand g)
                const rel = []; let h = 0;
                combo.forEach(({ tv }, i) => {
                    if (i) h += g;
                    rel.push(h - tv.top);
                    h += tv.bottom - tv.top;
                });
                const priceModes = price ? sc.priceAnchors.filter(a => (a === 'besideDesc') === !!narrow) : [null];
                for (const pm of priceModes) {
                    const inStack = pm === 'below' || pm === 'belowRight';
                    const H = inStack ? h + g + (ptv.bottom - ptv.top) : h;
                    for (const anchor of sc.stackAnchors) {
                        let top;
                        if (anchor === 'top') top = C.top;
                        else if (anchor === 'bottom') top = C.bottom - H;
                        else if (anchor === 'center') top = snap(C.top + (C.bottom - C.top - H) / 2, 0.5);
                        else if (anchor === 'motifTop') {
                            if (!pl?.motifBox) continue;
                            const first = combo[0].tv, T0 = stackEls[0];
                            // Versalhöhe der ersten Zeile = Motiv-Oberkante
                            top = pl.motifBox.top - (first.fb - capOf(T0, first)) + first.top;
                            if (Math.abs(top - C.top) < 0.3) continue;
                        }
                        stats.generated++;
                        const texts = combo.map(({ tv }, i) => placeText(stackEls[i], tv, cl, rd(top + rel[i], 3), tv.W));
                        if (price) {
                            const last = texts[texts.length - 1];
                            let px, py;
                            const pBox = ptv.bottom - ptv.top;
                            if (pm === 'below') { px = cl; py = top + h + g - ptv.top; }
                            else if (pm === 'belowRight') { px = cr - pw; py = top + h + g - ptv.top; }
                            else if (pm === 'cornerBR') { px = TA.right - pw; py = TA.bottom - ptv.bottom; }
                            else if (pm === 'cornerBL') { px = TA.left; py = TA.bottom - ptv.bottom; }
                            else if (pm === 'groundR' || pm === 'groundL') {
                                if (pl?.ground == null) continue;
                                px = pm === 'groundR' ? cr - pw : cl;
                                py = pl.ground - ptv.lb;
                            } else if (pm === 'motifSide') {
                                // auf der Standlinie direkt neben dem Motiv (Seite mit mehr Platz)
                                if (pl?.ground == null || !pl.motifBox) continue;
                                const gI = moduleMm(fmt, sc.textImageGap);
                                const leftRoom = pl.motifBox.left - TA.left, rightRoom = TA.right - pl.motifBox.right;
                                px = leftRoom >= rightRoom ? pl.motifBox.left - gI - pw : pl.motifBox.right + gI;
                                py = pl.ground - ptv.lb;
                            } else if (pm === 'besideDesc') { px = cr - pw; py = last.lines.filter(l => String(l.text).trim()).slice(-1)[0].baseline - ptv.lb; }
                            if (pBox <= 0) continue;
                            texts.push(placeText(price, ptv, rd(px, 3), rd(py, 3), rd(pw, 3)));
                        }
                        for (const T of fixedEls) texts.push(T.fixed);
                        const cand = { setup, placed: pl, texts, params: { colW: rd(W, 2), side, anchor, price: pm, narrow: !!narrow } };
                        out.push(cand);
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ Szene / Bewertung

/** Szene für den Scorer (Vertrag mit layoutScore.js). */
export function buildScene(cand, P) {
    const elements = cand.texts.map(t => {
        const T = P.byId.get(t.id);
        const tv = t.tv;
        const style = { ...T.style };
        if (tv) {
            style.size = tv.pt;
            style.leading = tv.ld;
            if (T.metrics?.cap) style.capHeight = T.metrics.cap * tv.pt / T.ref;
        }
        return { id: t.id, role: t.role, frame: t.frame, overset: t.overset || 0, lines: t.lines, style, original: T.original };
    });
    const images = [];
    if (cand.setup.image && P.img) {
        const pl = cand.placed;
        images.push({
            id: P.img.id, role: 'image', frame: cand.setup.image.frame, imageBounds: cand.setup.image.imageBounds,
            effPpi: cand.setup.image.effPpi, motifRects: pl.motifRects, features: pl.features,
            ...(typeof P.img.ink === 'number' ? { ink: P.img.ink } : {}),
        });
    }
    for (const fx of P.fixedImages || []) images.push(fx);
    return { format: P.fmt, config: P.config, elements, images };
}

/** Bewertung (Scorer aus layoutScore.js). */
export function evaluate(cand, P) {
    const r = scoreLayout(buildScene(cand, P), { skipScoreIfInvalid: true });
    cand.valid = r.valid;
    cand.score = r.score;
    cand.violations = r.violations;
    cand.breakdown = r.breakdown;
    return cand;
}

/** Ähnlichkeit zweier Kandidaten: mittlere IoU der Elementboxen (Text: Zeilenbox, Bild: sichtbares Motiv). */
export function layoutDistance(a, b) {
    const boxes = c => {
        const m = new Map(c.texts.map(t => [t.id, t.box]));
        if (c.placed?.motifBox) m.set('image', c.placed.motifBox);
        return m;
    };
    const A = boxes(a), B = boxes(b);
    const ious = [];
    for (const [k, ra] of A) {
        const rb = B.get(k);
        if (!ra || !rb) { ious.push(0); continue; }
        const x = intersectRect(ra, rb);
        const ia = area(x);
        ious.push(ia / (area(ra) + area(rb) - ia || 1));
    }
    return 1 - mean(ious);
}

/** Top-N divers: zuerst je Topologie, dann Mindestabstand, zuletzt nach Score. */
export function selectDiverse(cands, n, minDistance = 0.35) {
    const sorted = [...cands].sort((a, b) => b.score - a.score);
    const sel = [];
    const ok = (c, d, distinctTopo) => sel.every(s => layoutDistance(c, s) >= d && (!distinctTopo || s.setup.topo !== c.setup.topo));
    for (const [d, topo] of [[minDistance, true], [minDistance, false], [minDistance / 2, false], [0.02, false]]) {
        for (const c of sorted) {
            if (sel.length >= n) break;
            if (!sel.includes(c) && ok(c, d, topo)) sel.push(c);
        }
    }
    return sel;
}

// ------------------------------------------------------------------ Polygone

/**
 * Textfläche entlang des Motivumrisses: Rechteck R, an der Motivseite je
 * Streifen (slice mm) bis Motiv − gap beschnitten; endet, wenn die Breite
 * minWidth unterschreitet. Liefert Punkte [x, y] im Uhrzeigersinn oder null.
 */
export function motifPolygon(R, motifRects, { gap = 1.5, minWidth = 12, slice = 0.5, side = null } = {}) {
    const mb = unionRect(motifRects);
    if (!mb) return null;
    const cutRight = side ? side === 'right' : (mb.left + mb.right) / 2 > (R.left + R.right) / 2;
    const rows = [];
    for (let y = R.top; y < R.bottom - 1e-6; y += slice) {
        const y1 = Math.min(R.bottom, y + slice);
        let lim = cutRight ? R.right : R.left;
        for (const m of motifRects) {
            if (m.top >= y1 + gap || m.bottom <= y - gap) continue;
            if (cutRight && m.right > R.left) lim = Math.min(lim, m.left - gap);
            if (!cutRight && m.left < R.right) lim = Math.max(lim, m.right + gap);
        }
        lim = cutRight ? Math.floor(lim * 2) / 2 : Math.ceil(lim * 2) / 2;
        const w = cutRight ? lim - R.left : R.right - lim;
        if (w < minWidth) break;
        rows.push([y, y1, lim]);
    }
    if (!rows.length) return null;
    // gleiche Grenzen zusammenfassen
    const runs = [];
    for (const r of rows) {
        const last = runs[runs.length - 1];
        if (last && Math.abs(last[2] - r[2]) < 1e-6) last[1] = r[1]; else runs.push([...r]);
    }
    if (runs.length === 1 && Math.abs(runs[0][2] - (cutRight ? R.right : R.left)) < 1e-6) return null;
    const top = runs[0][0], bottom = runs[runs.length - 1][1];
    const pts = [];
    if (cutRight) {
        pts.push([R.left, top]);
        for (const [y0, y1, x] of runs) { pts.push([x, y0]); pts.push([x, y1]); }
        pts.push([R.left, bottom]);
    } else {
        for (const [y0, y1, x] of runs) { pts.push([x, y0]); pts.push([x, y1]); }
        pts.push([R.right, bottom]);
        pts.push([R.right, top]);
    }
    return dedupePts(pts).map(p => p.map(v => rd(v, 2)));
}

function dedupePts(pts) {
    const out = [];
    for (const p of pts) {
        const l = out[out.length - 1];
        if (!l || Math.abs(l[0] - p[0]) > 1e-6 || Math.abs(l[1] - p[1]) > 1e-6) out.push(p);
    }
    // kollineare Mittelpunkte entfernen
    return out.filter((p, i) => {
        const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
        return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-6;
    });
}

/**
 * Polygon-Aufträge aus Fast-Kandidaten, bei denen genau ein umbrechbarer Text
 * (nicht keepTogether) ins Motiv ragt: Fläche von seiner Oberkante bis zum
 * nächsten Block darunter (− Abstand) bzw. Satzspiegelunterkante.
 */
export function polygonJob(cand, elId, P, sc) {
    const TA = boundsToRect(P.fmt.typeArea);
    const g = moduleMm(P.fmt, sc.blockGap);
    const t = cand.texts.find(x => x.id === elId);
    const below = cand.texts.filter(x => x.id !== elId && x.box.top >= t.box.top && x.box.left < t.x + t.W && x.box.right > t.x);
    const bottom = Math.min(TA.bottom, ...below.map(x => x.box.top - g));
    const R = { top: t.y, left: t.x, right: t.x + t.W, bottom };
    // Schmalere Polygonzeilen brauchen mehr Höhe als das Rechteck
    if (R.bottom - R.top < (t.tv.bottom - t.tv.top) * 1.5) return null;
    const pts = motifPolygon(R, cand.placed.motifRects, sc.polygon);
    if (!pts) return null;
    return { elId, pt: t.tv.pt, ld: t.tv.ldAuto ? null : t.tv.ld, hyph: t.tv.hyph, points: pts };
}

/** Polygon-Messung in einen Kandidaten übernehmen (Zeilen absolut). */
export function applyPolygonResult(cand, elId, job, res) {
    const i = cand.texts.findIndex(x => x.id === elId);
    const t = cand.texts[i];
    const lines = res.lines.map(l => ({ text: l[0], baseline: l[1], top: l[1] - l[2], bottom: l[1] + l[3], x: l[4], width: l[5], paragraphEnd: !!l[6], hyphenated: !!l[7] }));
    const xs = job.points.map(p => p[0]), ys = job.points.map(p => p[1]);
    const nt = {
        ...t, lines, box: blockBox(lines), overset: res.overset,
        frame: [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)].map(v => rd(v, 3)),
        shape: job.points,
    };
    const texts = [...cand.texts];
    texts[i] = nt;
    return { ...cand, texts, params: { ...cand.params, polygon: elId } };
}

// ------------------------------------------------------------------ Problem

/** Stil eines Modell-Elements im Scorer-Format. */
export function sceneStyle(style, colors) {
    if (!style) return {};
    const c = colors?.[style.color];
    let col = null;
    if (Array.isArray(c) && c.length > 1 && typeof c[1] === 'number') {
        const ti = c.indexOf('tint');
        col = { space: c[0], values: c.slice(1, ti > 0 ? ti : undefined).filter(v => typeof v === 'number'), tint: ti > 0 ? c[ti + 1] : undefined };
    }
    const { ink, accent } = colorInk(col);
    return { size: style.size, leading: style.leading, font: style.font, fontStyle: style.fontStyle, color: style.color ?? null, ink, accent };
}

/**
 * Problem aus Modell, Messung und Bilddaten.
 * @param {object} model buildModel()-Ergebnis
 * @param {object} meas Messung { frames:[…] }
 * @param {object|null} imageData { mask, feat, ink } des Hauptbildes
 * @param {object} config aufgelöste Projekt-Konfiguration
 * @param {object} sc solverConfig()
 */
export function buildProblem(model, meas, imageData, config, sc) {
    const fmt = model.format;
    const texts = [];
    const byId = new Map();
    for (const m of meas.frames || []) {
        if (m.error) continue;
        const it = model.items.find(i => i.id === m.id);
        if (!it) continue;
        const role = config.roles[m.role] ? m.role : it.role;
        const def = config.roles[role] || {};
        const allow = def.allow || {};
        const tvs = textVariants(m, allow, { origLeading: m.refLd, leadingFactors: role === 'headline' ? sc.headlineLeading : [1] });
        const T = {
            id: m.id, role, ro: def.readingOrder, keep: !!allow.keepTogether, allow, ref: m.ref, refLd: m.refLd,
            style: sceneStyle(it.style, model.colors), metrics: it.style?.metrics, tvs,
        };
        T.original = { ...T.style };
        texts.push(T);
        byId.set(T.id, T);
    }
    // Texte ohne Lesereihenfolge bleiben an ihrer Stelle
    for (const T of texts) {
        if (T.keep || Number.isFinite(T.ro)) continue;
        const it = model.items.find(i => i.id === T.id);
        const lines = (it.lines?.rows || []).map(r => ({ text: 'x', baseline: r[0], top: r[0] - 3, bottom: r[0] + 1, x: r[1], width: r[2], hyphenated: !!r[3] }));
        T.fixed = { id: T.id, role: T.role, frame: it.bounds, lines, box: blockBox(lines) || boundsToRect(it.bounds), fixed: true };
    }
    let img = null;
    const graphics = model.items.filter(i => i.image && (i.role === 'image' || i.role === 'unknown'));
    const main = graphics.sort((a, b) => area(boundsToRect(b.bounds)) - area(boundsToRect(a.bounds)))[0];
    if (main && imageData) {
        const ib = main.image.bounds;
        const flip = String(main.image.flip || '').toUpperCase();
        const flipH = /HORIZONTAL/.test(flip) || /BOTH/.test(flip), flipV = /VERTICAL/.test(flip) || /BOTH/.test(flip);
        img = {
            id: main.id, graphicId: main.image.id, path: main.image.path,
            aspect: (ib[3] - ib[1]) / (ib[2] - ib[0]),
            px: main.image.px, minPpi: main.image.minPpi ?? config.minPpi,
            mask: imageData.mask, feat: imageData.feat, ink: imageData.ink, flip: main.image.flip || '',
            norm: imageNorm(imageData.mask, imageData.feat, { flipH, flipV }),
        };
    }
    return { fmt, config, texts, byId, img, imageItemIds: graphics.map(g => g.id) };
}

/**
 * Kompletter Offline-Lauf: Setups → Kandidaten → Vorfilter → Bewertung.
 * @returns {{ valid:object[], near:object[], stats:object, setups:object[] }}
 */
export function solve(P, sc) {
    const t0 = Date.now();
    const stats = { setups: 0, generated: 0, prefiltered: 0, scored: 0, valid: 0, noVariant: 0 };
    const setups = imageSetups(P, sc);
    stats.setups = setups.length;
    const H8 = scoringConfig(P.config).rules.H8;
    const minGap = H8?.enabled === false ? 0 : (H8?.minGap ?? 1);
    const pass = [], near = [];
    for (const s of setups) {
        const raw = [];
        candidatesForSetup(s, P, sc, raw, stats);
        for (const c of raw) {
            const bad = prefilter(c, P, { minGap });
            const ids = Object.keys(bad);
            if (!ids.length) { pass.push(c); continue; }
            // Fast-Kandidat: nur ein umbrechbarer Text kollidiert mit dem Motiv
            if (sc.polygon.enabled && ids.length === 1 && bad[ids[0]].every(x => x === 'motif')) {
                const T = P.byId.get(Number(ids[0]));
                if (T && !T.keep && T.allow.reflow) near.push({ cand: c, elId: T.id });
            }
        }
    }
    stats.prefiltered = pass.length;
    // Budget: geschichtet nach Setup ziehen
    let pool = pass;
    if (pass.length > sc.budget) {
        const rand = rng(sc.seed);
        const bySetup = new Map();
        for (const c of pass) { if (!bySetup.has(c.setup.key)) bySetup.set(c.setup.key, []); bySetup.get(c.setup.key).push(c); }
        const per = Math.max(1, Math.floor(sc.budget / bySetup.size));
        pool = [];
        for (const list of bySetup.values()) {
            if (list.length <= per) { pool.push(...list); continue; }
            const idx = list.map((c, i) => [rand(), i]).sort((a, b) => a[0] - b[0]).slice(0, per).map(x => x[1]);
            pool.push(...idx.map(i => list[i]));
        }
    }
    for (const c of pool) evaluate(c, P);
    stats.scored = pool.length;
    const valid = pool.filter(c => c.valid && typeof c.score === 'number');
    stats.valid = valid.length;
    stats.ms = Date.now() - t0;
    return { valid, near, stats, setups };
}

/** Fast-Kandidaten für die Polygon-Messung: geschätzt bewertet, beste je Setup/Element, höchstens maxShapes. */
export function polygonJobs(near, P, sc) {
    const jobs = [];
    const seen = new Set();
    const est = near.map(n => {
        const r = scoreLayout(buildScene(n.cand, P));
        // Schätzung: Score ohne den erwarteten Motiv-Verstoß
        return { ...n, est: r.score ?? 0, otherViolations: r.violations.filter(v => v.rule !== 'H8').length };
    }).filter(n => !n.otherViolations).sort((a, b) => b.est - a.est);
    for (const n of est) {
        if (jobs.length >= sc.polygon.maxShapes) break;
        const key = `${n.cand.setup.key}|${n.elId}`;
        if (seen.has(key)) continue;
        const job = polygonJob(n.cand, n.elId, P, sc);
        if (!job) continue;
        seen.add(key);
        jobs.push({ ...job, id: `p${jobs.length}`, cand: n.cand, est: n.est });
    }
    return jobs;
}

// ------------------------------------------------------------------ Serialisierung

/**
 * Serialisierbarer Kandidat (Eingabe für artwork_apply):
 * { id, topology, score, breakdown, params,
 *   texts: [{ id, role, frame:[t,l,b,r], shape?:[[x,y]…], pointSize, leading, leadingAuto, hyphenation, noBreak?,
 *             predicted:{ lines:[text…], firstBaseline, lastBaseline } }],
 *   images: [{ id, frame:[t,l,b,r], imageBounds:[t,l,b,r], effPpi }] }
 */
export function toSpec(cand, P, id) {
    const texts = cand.texts.filter(t => !t.fixed).map(t => {
        const T = P.byId.get(t.id);
        const vis = t.lines.filter(l => String(l.text).trim() !== '');
        const o = {
            id: t.id, role: t.role, frame: t.frame,
            pointSize: t.tv.pt, leading: t.tv.ld, leadingAuto: !!t.tv.ldAuto, hyphenation: t.tv.hyph,
            predicted: { lines: t.lines.map(l => l.text), firstBaseline: rd(vis[0]?.baseline, 2), lastBaseline: rd(vis[vis.length - 1]?.baseline, 2) },
        };
        if (t.shape) o.shape = t.shape;
        if (T?.keep) o.noBreak = true;
        return o;
    });
    const images = cand.setup.image && P.img ? [{ id: P.img.id, ...cand.setup.image }] : [];
    const bd = cand.breakdown ? Object.fromEntries(Object.entries(cand.breakdown).map(([k, b]) => [k, b.v])) : null;
    return {
        id, topology: cand.setup.topo, score: rd(cand.score, 3), breakdown: bd,
        params: {
            split: cand.setup.split, bleed: cand.setup.bleed, imageKind: cand.setup.kind, imageScale: cand.setup.scale, imageAnchor: cand.setup.anchor,
            ...cand.params,
        },
        texts, images,
    };
}

/** Prüft ein Kandidaten-Spec (artwork_apply). */
export function validateSpec(c, i = 0) {
    const L = `candidates[${i}]`;
    const box = (b, l) => { if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) throw new Error(`${l} must be [top, left, bottom, right] in mm`); };
    if (!isObj(c)) throw new Error(`${L} must be an object`);
    for (const [k, t] of (c.texts || []).entries()) {
        if (!Number.isInteger(t.id)) throw new Error(`${L}.texts[${k}].id must be an item id`);
        box(t.frame, `${L}.texts[${k}].frame`);
        if (t.shape && (!Array.isArray(t.shape) || t.shape.length < 3 || !t.shape.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) throw new Error(`${L}.texts[${k}].shape must be [[x, y], …] (mm)`);
        for (const k2 of ['pointSize', 'leading']) if (t[k2] != null && !(t[k2] > 0)) throw new Error(`${L}.texts[${k}].${k2} must be > 0 (pt)`);
    }
    for (const [k, im] of (c.images || []).entries()) {
        if (!Number.isInteger(im.id)) throw new Error(`${L}.images[${k}].id must be an item id (graphic frame)`);
        box(im.frame, `${L}.images[${k}].frame`);
        box(im.imageBounds, `${L}.images[${k}].imageBounds`);
    }
    return c;
}

/**
 * Vergleich Vorhersage ↔ InDesign nach dem Anwenden.
 * @param {object} spec Kandidat
 * @param {object} actual { texts:[{id, overset, lines:[[text, baseline]]}], images:[{id, effPpi}] }
 */
export function compareApplied(spec, actual, { tol = 0.15 } = {}) {
    const dev = [];
    for (const t of spec.texts) {
        const a = actual.texts?.find(x => x.id === t.id || x.sourceId === t.id);
        if (!a) { dev.push(`${t.role} ${t.id}: not applied`); continue; }
        if (a.error) { dev.push(`${t.role} ${t.id}: ${a.error}`); continue; }
        if (a.overset) dev.push(`${t.role} ${t.id}: ${a.overset} overset characters`);
        if (!t.predicted?.lines?.length) continue;
        const pl = t.predicted.lines.filter(x => String(x).trim()), al = a.lines.map(l => l[0]).filter(x => String(x).trim());
        if (pl.length !== al.length) dev.push(`${t.role} ${t.id}: ${al.length} lines, predicted ${pl.length}`);
        else if (pl.some((x, i) => x.trim() !== String(al[i]).trim())) dev.push(`${t.role} ${t.id}: line breaks differ`);
        const vis = a.lines.filter(l => String(l[0]).trim());
        if (vis.length && t.predicted.firstBaseline != null && Math.abs(vis[0][1] - t.predicted.firstBaseline) > tol) dev.push(`${t.role} ${t.id}: first baseline ${rd(vis[0][1])} mm, predicted ${t.predicted.firstBaseline}`);
        if (vis.length && t.predicted.lastBaseline != null && Math.abs(vis[vis.length - 1][1] - t.predicted.lastBaseline) > tol) dev.push(`${t.role} ${t.id}: last baseline ${rd(vis[vis.length - 1][1])} mm, predicted ${t.predicted.lastBaseline}`);
    }
    for (const im of spec.images) {
        const a = actual.images?.find(x => x.id === im.id || x.sourceId === im.id);
        if (!a) { dev.push(`image ${im.id}: not applied`); continue; }
        if (a.error) { dev.push(`image ${im.id}: ${a.error}`); continue; }
        if (Array.isArray(a.effPpi) && Array.isArray(im.effPpi) && Math.abs(Math.min(...a.effPpi) - Math.min(...im.effPpi)) > 3) dev.push(`image ${im.id}: effective ${Math.round(Math.min(...a.effPpi))} ppi, predicted ${Math.min(...im.effPpi)}`);
    }
    return dev;
}

export { rectToArray };
