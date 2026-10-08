#!/usr/bin/env node
/**
 * Tests für src/utils/layoutSolver.js (ohne InDesign): synthetisches Modell,
 * simulierte Breiten-Tabellen (gieriger Umbruch), synthetische Bildmaske.
 *   node tests/test-layout-solver.js
 */
import assert from 'assert/strict';
import { loadConfig, deepMerge } from '../src/utils/layoutModel.js';
import {
    solverConfig, measurePlan, planMeasureJobs, batchJobs, mergeMeasurements, plannedSizes, textVariants, pickVariants, placeLines, imageNorm, imageSetups,
    buildProblem, buildScene, solve, selectDiverse, layoutDistance, motifPolygon, polygonJobs, applyPolygonResult,
    toSpec, validateSpec, compareApplied, evaluate, rng,
} from '../src/utils/layoutSolver.js';
import { PT_MM, zBefore, scoreLayout } from '../src/utils/layoutScore.js';

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

const config = loadConfig({ env: {} }).config;
const sc = solverConfig(config, { budget: 1500 });

// ------------------------------------------------------------------ Synthetik

const TEXTS = {
    298: { role: 'headline', ps: 'h1', text: 'Manualhi Pltfrm J Shoe Bkw - Schwarz/Weiss', size: 12, bold: true },
    322: { role: 'description', ps: 'desc', text: 'Coole Boots von DC. Die Sohle ist eine Plateausohle Höhe der Plateausohle: ca. 3,5 cm Material: Stoff, Polyester, Gummisohle. Farbe: schwarz, weiß.', size: 8 },
    330: { role: 'price', ps: 'price', text: '67,99 €', size: 24, bold: true },
};

/** Gieriger Umbruch mit fester Zeichenbreite: Zeilen [text, base, asc, desc, x, width, pe, hy]. */
function fakeSet(text, pt, ld, w, bold = false) {
    const cw = pt * PT_MM * (bold ? 0.6 : 0.52);
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const word of words) {
        const next = cur ? `${cur} ${word}` : word;
        if (next.length * cw <= w) cur = next;
        else { if (!cur) return null; lines.push(cur); cur = word; if (word.length * cw > w) return null; }
    }
    if (cur) lines.push(cur);
    const asc = pt * PT_MM * 0.75, desc = pt * PT_MM * 0.21, lead = ld * PT_MM;
    return lines.map((t, i) => [t, asc + i * lead, asc, desc, 0, t.length * cw, i === lines.length - 1 ? 1 : 0, 0]);
}

/** Messung wie das UXP-Skript: Pakete, je Probe eine Zeile, Zusammenführung per mergeMeasurements. */
function fakeMeasure(plan) {
    const results = batchJobs(planMeasureJobs(MODEL, plan), plan.maxProbes).map(batch => {
        const frames = [];
        for (const job of batch) {
            const T = TEXTS[job.id];
            let f = frames.find(x => x.id === job.id);
            if (!f) { f = { id: job.id, role: T.role, ref: T.size, refLd: T.size * 1.2, align: 'LEFT_ALIGN', paras: 1, rows: [] }; frames.push(f); }
            for (const w of job.widths) {
                const lines = fakeSet(T.text, job.pt, job.pt * 1.2, w, T.bold);
                f.rows.push({ w: [w, w], pt: job.pt, ld: job.pt * 1.2, hyph: job.hyph.name, ov: lines ? 0 : 1, lines });
            }
        }
        return { frames };
    });
    return mergeMeasurements(results);
}

const MODEL = {
    format: {
        page: { index: 0, size: [75, 60], bounds: [0, 0, 60, 75] },
        margins: [5, 5, 5, 5], typeArea: [5, 5, 55, 70], columns: [1, 4.23], docBleed: 0,
        imageBleed: 3, imageBleedBox: [-3, -3, 63, 78], modules: { margin: 5, gap: 2.5 }, grid: null,
    },
    colors: { Black: ['CMYK', 0, 0, 0, 100], Red: ['CMYK', 15, 100, 100, 0] },
    items: [
        ...Object.entries(TEXTS).map(([id, t]) => ({
            id: Number(id), role: t.role, kind: 'text', bounds: [2, 2, 18, 57],
            style: { size: t.size, leading: t.size * 1.2, font: 'Noto Sans', fontStyle: t.bold ? 'Bold' : 'Regular', color: t.role === 'price' ? 'Red' : 'Black', metrics: { cap: t.size * 0.252 } },
        })),
        { id: 361, role: 'image', kind: 'graphic', bounds: [8, 2, 58, 50.7], image: { id: 357, bounds: [8, 2, 58, 50.7], px: [1168, 1200], minPpi: 200, path: 'x.jpg' } },
    ],
};

/** Schuh-ähnliche Maske: Dreieck unten links bis oben rechts (normiert, 32er-Raster). */
function fakeMask() {
    const cols = 31, rows = 32, cells = [];
    for (let r = 6; r < 27; r++) {
        const c0 = Math.max(1, Math.round(19 - (r - 6) * 0.9)), c1 = 29;
        for (let c = c0; c <= c1; c++) cells.push([r, c, c / cols, r / rows, (c + 1) / cols, (r + 1) / rows]);
    }
    return { cols, rows, cells, pixelWidth: 1168, pixelHeight: 1200 };
}
const FEAT = {
    motif: [0.036, 0.193, 0.964, 0.832], centroid: [0.62, 0.51],
    focus: { pt: [0.52, 0.48], region: [0.38, 0.34, 0.66, 0.58], conf: 0.3 },
    ground: { p0: [0.036, 0.829], p1: [0.964, 0.829], x: [0.16, 0.49], quality: 0.4 },
    extremes: null, edges: [], direction: { v: [-0.93, 0.43], conf: 0.46 },
};

const plan = measurePlan(config, sc);
const MEAS = fakeMeasure(plan);
const P = buildProblem(MODEL, MEAS, { mask: fakeMask(), feat: FEAT, ink: 0.6 }, config, sc);

// ------------------------------------------------------------------ Tests

test('solverConfig: Defaults, Overrides, Prüfung', () => {
    assert.equal(sc.budget, 1500);
    assert.equal(solverConfig({ solver: { splits: [0.5] } }).splits.length, 1);
    assert.throws(() => solverConfig({ solver: { topologies: ['diagonal'] } }), /unknown 'diagonal'/);
    assert.throws(() => solverConfig({ solver: { measure: { step: 0 } } }), /step/);
});

test('planMeasureJobs: Headline mit Graden ±15 %, Preis eine Breite, Batches ≤ maxProbesPerScript', () => {
    const jobs = planMeasureJobs(MODEL, plan);
    const h = jobs.filter(j => j.id === 298);
    const sizes = [...new Set(h.map(j => j.pt))].sort((a, b) => a - b);
    assert.equal(sizes.length, 2 * sc.measure.sizeSteps + 1);
    assert.ok(sizes[0] >= 12 * 0.85 - 0.01 && sizes[sizes.length - 1] <= 12 * 1.15 + 0.01);
    const p = jobs.filter(j => j.id === 330);
    assert.equal(p.length, 1);
    assert.equal(p[0].widths.length, 1);
    assert.ok(jobs.every(j => j.widths.length <= sc.measure.maxProbesPerScript));
});

test('batchJobs/mergeMeasurements: Pakete begrenzt, gleiche Umbrüche zu Bereichen vereinigt', () => {
    const jobs = planMeasureJobs(MODEL, plan);
    const batches = batchJobs(jobs, 25);
    assert.ok(batches.every(b => b.reduce((n, j) => n + j.widths.length, 0) <= 25));
    assert.equal(batches.flat().reduce((n, j) => n + j.widths.length, 0), jobs.reduce((n, j) => n + j.widths.length, 0));
    const L = t => [[t, 4, 4, 1, 0, 10, 1, 0]];
    const m = mergeMeasurements([
        { frames: [{ id: 1, rows: [{ w: [20, 20], pt: 8, hyph: 'off', ov: 0, lines: L('a') }, { w: [22.5, 22.5], pt: 8, hyph: 'off', ov: 0, lines: L('a') }] }] },
        { frames: [{ id: 1, rows: [{ w: [25, 25], pt: 8, hyph: 'off', ov: 0, lines: L('a') }, { w: [27.5, 27.5], pt: 8, hyph: 'off', ov: 0, lines: L('b') }] }] },
    ]);
    assert.deepEqual(m.frames[0].rows.map(r => r.w), [[20, 25], [27.5, 27.5]]);
    assert.deepEqual(plannedSizes(12, { pointSize: 0.15 }, 2), [12, 11, 13, 10.25, 13.75]);
});

test('textVariants: Breitenbereiche, Headline-Zeilenabstand innerhalb ±15 %', () => {
    const T = P.byId.get(298);
    assert.ok(T.tvs.length > 5);
    for (const tv of T.tvs) {
        assert.ok(tv.wMin <= tv.wMax);
        assert.ok(tv.ld >= 14.4 * 0.85 - 0.01 && tv.ld <= 14.4 * 1.15 + 0.01, `leading ${tv.ld}`);
        assert.ok(tv.pt >= 10.2 - 0.01 && tv.pt <= 13.8 + 0.01);
    }
    // synthetischer Zeilenabstand skaliert Grundlinien-Abstände
    const m = { id: 1, role: 'headline', ref: 12, refLd: 14.4, paras: 1, rows: [{ w: [30, 32], pt: 12, ld: 14.4, hyph: 'off', ov: 0, lines: [['a b', 4, 4, 1, 0, 10, 0, 0], ['c', 4 + 14.4 * PT_MM, 4, 1, 0, 5, 1, 0]] }] };
    const v = textVariants(m, { leading: 0.15 }, { origLeading: 14.4, leadingFactors: [0.9, 1] });
    assert.equal(v.length, 2);
    const tight = v.find(x => x.ld < 14);
    assert.ok(Math.abs((tight.lines[1].base - tight.lines[0].base) - 14.4 * 0.9 * PT_MM) < 1e-6);
});

test('pickVariants/placeLines: Rahmenbreite ≤ Spalte, Zeilen absolut', () => {
    const T = P.byId.get(322);
    const pv = pickVariants(T.tvs, 35, 2, 'description', {});
    assert.ok(pv.length >= 1 && pv.every(tv => tv.W <= 35 && tv.wMin <= 35));
    const L = placeLines(pv[0], 10, 20, pv[0].W);
    assert.equal(L[0].x, 10);
    assert.ok(Math.abs(L[0].baseline - (20 + pv[0].lines[0].base)) < 1e-9);
});

test('imageNorm/imageSetups: Motiv in Zone, Anschnitt erreicht Bildanschnitt, ppi ≥ 200', () => {
    assert.deepEqual(imageNorm(null, FEAT).motif.map(v => Math.round(v * 1000) / 1000), [0.193, 0.036, 0.832, 0.964]);
    const setups = imageSetups(P, sc);
    assert.ok(setups.length > 20);
    const topos = new Set(setups.map(s => s.topo));
    for (const t of sc.topologies) assert.ok(topos.has(t), `topology ${t}`);
    for (const s of setups) {
        assert.ok(Math.min(...s.image.effPpi) >= 200);
        if (s.bleed.includes('left')) assert.ok(s.image.frame[1] <= -3 + 0.02);
    }
});

let RESULT;
test('solve: Kandidaten erzeugt, gültige vorhanden, deterministisch', () => {
    RESULT = solve(P, sc);
    const s = RESULT.stats;
    assert.ok(s.generated > 100, `generated ${s.generated}`);
    assert.ok(s.scored <= sc.budget + 50);
    assert.ok(s.valid > 0, `valid ${s.valid}`);
    for (const c of RESULT.valid.slice(0, 20)) assert.equal(c.valid, true);
    const again = solve(P, sc);
    assert.equal(again.stats.valid, s.valid);
    const best = arr => [...arr].sort((a, b) => b.score - a.score)[0].score;
    assert.equal(best(again.valid), best(RESULT.valid));
});

test('Kandidaten: Preis einzeilig, Text im Satzspiegel, nicht im Motiv', () => {
    for (const c of RESULT.valid.slice(0, 200)) {
        const price = c.texts.find(t => t.role === 'price');
        assert.equal(price.lines.filter(l => l.text.trim()).length, 1);
        for (const t of c.texts) for (const l of t.lines) {
            assert.ok(l.top >= 5 - 0.06 && l.bottom <= 55 + 0.06 && l.x >= 5 - 0.06 && l.x + l.width <= 70 + 0.06);
        }
    }
});

test('Generator: Anker motifBottom setzt die letzte Grundlinie auf die Standlinie', () => {
    const mb = RESULT.valid.filter(c => c.params.anchor === 'motifBottom');
    assert.ok(mb.length > 0, 'keine gültigen motifBottom-Kandidaten');
    for (const c of mb.slice(0, 50)) {
        const stack = c.params.price === 'below' || c.params.price === 'belowRight' ? c.texts.find(t => t.role === 'price') : c.texts.find(t => t.role === 'description');
        const lb = stack.lines.filter(l => l.text.trim()).at(-1).baseline;
        assert.ok(Math.abs(lb - c.placed.ground) < 0.01, `${lb} vs ${c.placed.ground}`);
    }
});

test('H11: Headline in allen Kandidaten zuerst, Preis-Anker davor gar nicht erzeugt', () => {
    assert.ok(RESULT.stats.leadOrder > 0, 'Preis-Anker vor der Headline verworfen');
    for (const c of RESULT.valid) {
        const h = c.texts.find(t => t.role === 'headline');
        for (const t of c.texts) if (t !== h) assert.ok(zBefore(h.box, t.box), `${t.role} vor Headline (${c.setup.key})`);
    }
});

test('readingOrderFlexible ["description"]: Preis zwischen Headline und Beschreibung ohne S9-Abzug', () => {
    const cfg = deepMerge(config, { roles: { price: { readingOrderFlexible: ['description'] } } });
    const P2 = buildProblem(MODEL, MEAS, { mask: fakeMask(), feat: FEAT, ink: 0.6 }, cfg, sc);
    const r = solve(P2, sc);
    assert.ok(r.stats.valid > 0);
    for (const c of r.valid) assert.ok(c.breakdown.S9.v === 1 || c.breakdown.S9.v === null);
    // Preis im Stapel vor die Beschreibung tauschen: gültig, ohne S9-Abzug; mit fester Lesefolge Abzug
    const shift = (t, dx, dy) => ({
        ...t, lines: t.lines.map(l => ({ ...l, x: l.x + dx, top: l.top + dy, bottom: l.bottom + dy, baseline: l.baseline + dy })),
        box: { top: t.box.top + dy, bottom: t.box.bottom + dy, left: t.box.left + dx, right: t.box.right + dx },
        frame: [t.frame[0] + dy, t.frame[1] + dx, t.frame[2] + dy, t.frame[3] + dx],
    });
    let swapped = 0;
    for (const c of r.valid.filter(x => x.params.price === 'below').slice(0, 50)) {
        const d = c.texts.find(t => t.role === 'description'), p = c.texts.find(t => t.role === 'price');
        const dy = p.box.bottom - d.box.bottom;
        const texts = c.texts.map(t => (t === d ? shift(d, 0, dy) : t === p ? shift(p, d.box.left - p.box.left, d.box.top - p.box.top) : t));
        const r2 = scoreLayout(buildScene({ ...c, texts }, P2));
        if (!r2.valid) continue;
        swapped++;
        assert.equal(r2.breakdown.S9.v, 1);
        assert.ok(scoreLayout(buildScene({ ...c, texts }, P)).breakdown.S9.v < 1);
    }
    assert.ok(swapped > 0, 'kein gültiger Tausch gefunden');
});

test('H12: Bild-Setups mit zu wenig sichtbarem Motiv werden verworfen', () => {
    const setups = imageSetups(P, sc);
    assert.ok(setups.every(s => s.image.motifVisible >= config.minMotifVisible - 1e-3));
    assert.ok(setups.some(s => s.image.motifVisible < 1), 'Anschnitt kommt vor');
    const strict = imageSetups({ ...P, config: deepMerge(config, { minMotifVisible: 0.95 }) }, sc);
    const loose = imageSetups({ ...P, config: deepMerge(config, { minMotifVisible: 0.3 }) }, sc);
    assert.ok(strict.length < setups.length && setups.length < loose.length, `${strict.length} < ${setups.length} < ${loose.length}`);
    assert.ok(strict.every(s => s.image.motifVisible >= 0.95 - 1e-3));
    // Vorhersage stimmt mit dem Scorer (Maske, H12) überein
    const c = RESULT.valid.find(x => x.setup.image.motifVisible < 1);
    if (c) {
        const im = buildScene(c, P).images[0];
        const vis = im.motifRects.reduce((a, r) => a + (r.bottom - r.top) * (r.right - r.left), 0) / im.motifFullArea;
        assert.ok(Math.abs(vis - c.setup.image.motifVisible) < 0.02, `${vis} vs ${c.setup.image.motifVisible}`);
    }
});

test('selectDiverse: 3 verschiedene, Bester zuerst, Abstand > 0', () => {
    const page = { top: 0, left: 0, bottom: 60, right: 75 };
    const sel = selectDiverse(RESULT.valid, 3, { ...sc.diversity, page });
    assert.equal(sel.length, 3);
    assert.equal(sel[0].score, Math.max(...RESULT.valid.map(c => c.score)));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(layoutDistance(sel[i], sel[j], { page }) > 0.05);
    assert.equal(layoutDistance(sel[0], sel[0], { page }), 0);
});

test('selectDiverse: ähnliche Spitzenkandidaten verlieren gegen anderen mit leicht niedrigerem Score', () => {
    const page = { top: 0, left: 0, bottom: 60, right: 75 };
    const R = (t, l, b, r) => ({ top: t, left: l, bottom: b, right: r });
    // Headline oben, Text, Preis links, Bild rechts unten – nur leicht verschoben
    const similar = (score, dx, topo = 'imageBottom') => ({
        score, setup: { topo, bleed: [] }, params: {}, placed: { motifBox: R(32 + dx, 40 + dx, 55, 70) },
        texts: [{ role: 'headline', box: R(5, 5, 15, 65) }, { role: 'description', box: R(17, 5, 28 + dx, 60) }, { role: 'price', box: R(32, 5, 40, 30) }],
    });
    const other = {
        score: 0.8, setup: { topo: 'imageLeft', bleed: ['left'] }, params: {}, placed: { motifBox: R(5, -3, 55, 30) },
        texts: [{ role: 'headline', box: R(5, 35, 20, 70) }, { role: 'description', box: R(22, 35, 40, 70) }, { role: 'price', box: R(44, 50, 52, 70) }],
    };
    const cands = [similar(0.86, 0), similar(0.85, 1), similar(0.845, 2, 'overlay'), other];
    const sel = selectDiverse(cands, 2, { page });
    assert.equal(sel[0], cands[0]);
    assert.equal(sel[1], other);
    assert.ok(layoutDistance(cands[0], cands[2], { page }) < 0.2, 'Overlay mit gleicher Anordnung gilt als ähnlich');
    // unter minScore (90 % des Besten) und fallbackScore nur, wenn nichts anderes verschieden genug ist
    const low = { ...other, score: 0.5, _feat: null };
    const sel2 = selectDiverse([...cands.slice(0, 3), low], 2, { page, fallbackScore: 0.8 });
    assert.notEqual(sel2[1], low);
    assert.throws(() => solverConfig({ solver: { diversity: { minScore: 1.5 } } }), /minScore/);
});

test('toSpec/validateSpec/compareApplied: serialisierbar, Abweichungen erkannt', () => {
    const [c] = selectDiverse(RESULT.valid, 1, {});
    const spec = toSpec(c, P, 'c1');
    const json = JSON.parse(JSON.stringify(spec));
    validateSpec(json);
    assert.equal(json.images[0].id, 361);
    const price = json.texts.find(t => t.role === 'price');
    assert.equal(price.noBreak, true);
    const actual = {
        texts: json.texts.map(t => ({ id: t.id, overset: 0, lines: t.predicted.lines.map((x, i, a) => [x, i === 0 ? t.predicted.firstBaseline : i === a.length - 1 ? t.predicted.lastBaseline : 0]) })),
        images: [{ id: 361, effPpi: json.images[0].effPpi }],
    };
    assert.deepEqual(compareApplied(json, actual), []);
    actual.texts[0].overset = 3;
    actual.texts[0].lines = actual.texts[0].lines.slice(0, 1);
    const dev = compareApplied(json, actual);
    assert.ok(dev.some(d => /overset/.test(d)) && dev.some(d => /lines, predicted|baseline/.test(d)));
    assert.throws(() => validateSpec({ texts: [{ id: 1, frame: [0, 0, -1, 1] }] }), /frame/);
});

test('motifPolygon: Fläche links vom Motiv, Treppe, Breite ≥ min', () => {
    const motif = [{ top: 20, left: 40, bottom: 30, right: 60 }, { top: 30, left: 25, bottom: 40, right: 60 }];
    const pts = motifPolygon({ top: 10, left: 5, bottom: 45, right: 70 }, motif, { gap: 1, minWidth: 10, slice: 0.5 });
    assert.ok(pts && pts.length >= 6);
    assert.ok(Math.max(...pts.map(p => p[0])) <= 70);
    // bei y 35 darf die Fläche nicht über x = 24 hinausreichen
    const xsAt35 = pts.filter(p => p[1] > 29 && p[1] < 41).map(p => p[0]);
    assert.ok(Math.max(...xsAt35) <= 24 + 1e-6, JSON.stringify(pts));
    assert.equal(motifPolygon({ top: 0, left: 0, bottom: 10, right: 20 }, motif), null);
});

test('polygonJobs + applyPolygonResult: Job für Fast-Kandidaten, Ergebnis übernommen', () => {
    const jobs = polygonJobs(RESULT.near, P, sc);
    assert.ok(jobs.length <= sc.polygon.maxShapes);
    if (!jobs.length) return;
    const j = jobs[0];
    const t = j.cand.texts.find(x => x.id === j.elId);
    const ys = j.points.map(p => p[1]);
    const res = { overset: 0, lines: t.lines.map(l => [l.text, l.baseline, l.baseline - l.top, l.bottom - l.baseline, l.x, Math.min(l.width, 5), 0, 0]) };
    const c2 = applyPolygonResult(j.cand, j.elId, j, res);
    const t2 = c2.texts.find(x => x.id === j.elId);
    assert.deepEqual(t2.shape, j.points);
    assert.equal(t2.frame[0], Math.min(...ys));
    evaluate(c2, P);
    assert.equal(typeof c2.valid, 'boolean');
});

test('rng: deterministisch', () => {
    const a = rng(7), b = rng(7);
    assert.equal(a(), b());
});

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
if (RESULT) console.log('stats', JSON.stringify(RESULT.stats));
process.exit(failed ? 1 : 0);
