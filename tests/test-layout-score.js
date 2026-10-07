#!/usr/bin/env node
/**
 * Tests für src/utils/layoutScore.js (ohne InDesign, synthetische Szenen).
 *   node tests/test-layout-score.js
 */
import assert from 'assert/strict';
import { loadConfig, buildFormat, deepMerge } from '../src/utils/layoutModel.js';
import {
    scoreLayout, scoreScene, checkHardRules, scoringConfig, colorInk, spearman, parseAnchor, placeImageData, rect, PT_MM,
} from '../src/utils/layoutScore.js';

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

const CONFIG = loadConfig({ env: {} }).config;
// Seite 75 × 60 mm, Ränder 5 mm → Satzspiegel [5, 5, 55, 70], Modul gap 2,5 mm
const FORMAT = buildFormat({ index: 0, name: '1', bounds: [0, 0, 60, 75], margins: [5, 5, 5, 5], cols: 1, gutter: 4, docBleed: [0, 0, 0, 0], facing: false, side: 'RIGHT_HAND' }, CONFIG);

const STYLES = {
    headline: { size: 12, leading: 14.4, font: 'Noto Sans', fontStyle: 'Bold', color: 'Black', ink: 1, accent: 0 },
    description: { size: 8, leading: 9.6, font: 'Noto Sans', fontStyle: 'Regular', color: 'Black', ink: 1, accent: 0 },
    price: { size: 24, leading: 28.8, font: 'Noto Sans', fontStyle: 'Bold', color: 'Red', ink: 0.82, accent: 0.85 },
};

/** Textelement: Zeilen untereinander ab Oberkante top, Breiten in mm (Text = n Wörter je Zeile). */
function text(id, role, x, top, widths, { size = STYLES[role].size, texts = null, style = {}, original = undefined, overset = 0, hyphen = [] } = {}) {
    const A = 0.3775 * size, D = 0.1033 * size, L = size * 1.2 * PT_MM;
    let bl = top + A;
    const lines = widths.map((w, i) => {
        const t = texts?.[i] ?? 'Wort '.repeat(Math.max(1, Math.round(w / 7))).trim();
        const l = { top: bl - A, bottom: bl + D, baseline: bl, x, width: w, text: t, hyphenated: hyphen.includes(i), paragraphEnd: i === widths.length - 1 };
        bl += L;
        return l;
    });
    const st = { ...STYLES[role], size, leading: size * 1.2, ...style };
    return {
        id, role, frame: [top, x, lines[lines.length - 1].bottom, x + Math.max(...widths)], overset, lines, style: st,
        original: original === undefined ? { ...STYLES[role] } : original,
    };
}

/** Bild mit rechteckigem Motiv (in Zellen zerlegt) und optionalen Merkmalen. */
function image(id, frame, motif, { imageBounds = frame, effPpi = [300, 300], features = null, ink = 0.6 } = {}) {
    const [t, l, b, r] = motif;
    const cells = [];
    for (let y = t; y < b - 1e-9; y += 2) for (let x = l; x < r - 1e-9; x += 2) cells.push(rect(y, x, Math.min(b, y + 2), Math.min(r, x + 2)));
    return { id, role: 'image', frame, imageBounds, effPpi, motifRects: cells, features, ink };
}

function features(motif, { dir = 'none', conf = 0, angle = 0, ground = null, safe = null } = {}) {
    const [t, l, b, r] = motif;
    return {
        centroid: { page: [(l + r) / 2, (t + b) / 2] },
        safeCrop: { min: { page: safe || [t + 2, l + 2, b - 2, r - 2] } },
        extremes: { left: { x: l, hard: true }, right: { x: r, hard: true }, top: { y: t, hard: false }, bottom: { y: b, hard: true } },
        edges: [],
        groundLine: ground === null ? null : { angle: 0, yLeft: ground, yRight: ground, x: [l, r], quality: 0.5 },
        direction: { dir, confidence: conf, angle },
    };
}

/** Gültiger Grundaufbau: Headline oben voll breit, Bild links, Beschreibung + Preis rechts. */
function baseScene(over = {}) {
    const motif = [17, 6, 50, 38];
    return {
        format: FORMAT,
        config: over.config || CONFIG,
        elements: over.elements || [
            text(1, 'headline', 5, 5, [60, 40]),
            text(2, 'description', 42, 17, [28, 27, 28, 20]),
            text(3, 'price', 42, 41.5, [26]),
        ],
        images: over.images || [image(10, [12, -3, 55, 40], motif, { features: features(motif) })],
    };
}

const rules = r => r.violations.map(v => v.rule);
const S = (scene, k) => scoreLayout(scene).breakdown[k].v;

// ------------------------------------------------------------------ Grundlagen

test('Grundaufbau ist gültig, alle Kriterien liefern Werte, Score = gewichtetes Mittel', () => {
    const r = scoreLayout(baseScene());
    assert.equal(r.valid, true, JSON.stringify(r.violations));
    const sc = scoringConfig(CONFIG);
    let ws = 0, acc = 0;
    for (const [k, b] of Object.entries(r.breakdown)) {
        if (b.v === null) continue;
        assert.ok(b.v >= 0 && b.v <= 1, `${k} in 0..1`);
        ws += sc.weights[k]; acc += sc.weights[k] * b.v;
    }
    assert.ok(Math.abs(r.score - acc / ws) < 0.002);
    assert.equal(scoreScene, scoreLayout);
});

test('checkHardRules und skipScoreIfInvalid', () => {
    const bad = baseScene({ elements: [text(1, 'headline', 5, 5, [60], { overset: 3 })] });
    assert.deepEqual(rules(checkHardRules(bad)), ['H1']);
    const r = scoreLayout(bad, { skipScoreIfInvalid: true });
    assert.equal(r.valid, false);
    assert.equal(r.score, null);
});

test('colorInk: Schwarz, Weiß, Rot, Tonwert', () => {
    assert.equal(colorInk({ space: 'CMYK', values: [0, 0, 0, 100] }).ink, 1);
    assert.equal(colorInk({ space: 'RGB', values: [255, 255, 255] }).ink, 0);
    const red = colorInk({ space: 'CMYK', values: [15, 100, 100, 0] });
    assert.ok(red.ink > 0.7 && red.accent > 0.8);
    assert.ok(Math.abs(colorInk({ space: 'CMYK', values: [0, 0, 0, 100], tint: 50 }).ink - 0.5) < 0.01);
    assert.deepEqual(colorInk(null), { ink: 1, accent: 0 });
});

test('spearman und parseAnchor', () => {
    assert.equal(spearman([1, 2, 3], [10, 20, 30]), 1);
    assert.equal(spearman([1, 2, 3], [30, 20, 10]), -1);
    assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
    assert.deepEqual(parseAnchor('price.lastBaseline'), { role: 'price', prop: 'lastBaseline', axis: 'y' });
    assert.equal(parseAnchor('image.motifLeft').axis, 'x');
    assert.equal(parseAnchor('foo'), null);
});

test('scoringConfig: Mischen, Regeln per true/false, Prüfung', () => {
    const cfg = deepMerge(CONFIG, { scoring: { weights: { S1: 5 }, rules: { H8: false, H2: { tolerance: 1 } } } });
    const sc = scoringConfig(cfg);
    assert.equal(sc.weights.S1, 5);
    assert.equal(sc.weights.S2, 1);
    assert.equal(sc.rules.H8.enabled, false);
    assert.equal(sc.rules.H2.tolerance, 1);
    assert.equal(sc.rules.H2.enabled, true);
    assert.throws(() => scoringConfig({ scoring: { weights: { S11: 1 } } }), /unknown criterion/);
    assert.throws(() => scoringConfig({ scoring: { alignment: { wishes: [{ a: 'price.lastBaseline', b: 'image.motifLeft' }] } } }), /mix x and y/);
});

// ------------------------------------------------------------------ Harte Regeln

test('H1 Übersatz', () => {
    const s = baseScene();
    s.elements[1].overset = 5;
    assert.ok(rules(scoreLayout(s)).includes('H1'));
});

test('H2 Zeilenbox (inkl. Oberlänge) außerhalb des Satzspiegels', () => {
    const s = baseScene();
    s.elements[0] = text(1, 'headline', 5, 4, [60, 40]); // Oberlänge 1 mm im Rand
    assert.deepEqual(rules(scoreLayout(s)), ['H2']);
    s.elements[0] = text(1, 'headline', 4.9, 5, [60]);
    assert.ok(rules(scoreLayout(s)).includes('H2'));
});

test('H3 Preis einzeilig', () => {
    const s = baseScene();
    s.elements[2] = text(3, 'price', 42, 36, [20, 10]);
    assert.ok(rules(scoreLayout(s)).includes('H3'));
});

test('H4 Stiländerungen: Headline ±15 %, andere unverändert, Schrift/Farbe fix', () => {
    const s = baseScene();
    s.elements[0] = text(1, 'headline', 5, 5, [60], { size: 13.5 }); // +12,5 %
    assert.equal(scoreLayout(s).valid, true, JSON.stringify(scoreLayout(s).violations));
    s.elements[0] = text(1, 'headline', 5, 5, [60], { size: 14 }); // +16,7 %
    assert.ok(rules(scoreLayout(s)).includes('H4'));
    const d = baseScene();
    d.elements[1] = text(2, 'description', 42, 17, [28, 27, 28, 20], { size: 8.5 });
    assert.ok(rules(scoreLayout(d)).includes('H4'));
    const f = baseScene();
    f.elements[1] = text(2, 'description', 42, 17, [28, 27, 28, 20], { style: { fontStyle: 'Italic' } });
    assert.match(scoreLayout(f).violations[0].detail, /fontStyle changed/);
    const n = baseScene();
    n.elements[1].original = null;
    assert.ok(scoreLayout(n).skipped.some(x => x.rule === 'H4'));
});

test('H5 effektive Auflösung', () => {
    const s = baseScene();
    s.images[0].effPpi = [180, 180];
    assert.deepEqual(rules(scoreLayout(s)), ['H5']);
});

test('H6 Bildkante: Rand oder Anschnitt, nichts dazwischen', () => {
    const motif = [17, 6, 50, 38];
    const mk = frame => baseScene({ images: [image(10, frame, motif, { features: features(motif) })] });
    assert.equal(scoreLayout(mk([12, -3, 55, 40])).valid, true); // links randabfallend bis Anschnitt
    assert.equal(scoreLayout(mk([12, 5, 55, 40])).valid, true); // links am Satzspiegel
    assert.deepEqual(rules(scoreLayout(mk([12, 2, 55, 40]))), ['H6']); // Blitzer
    assert.deepEqual(rules(scoreLayout(mk([12, -1, 55, 40]))), ['H6']); // nicht bis Anschnitt
    assert.deepEqual(rules(scoreLayout(mk([12, -3, 58, 40]))), ['H6']); // unten 2 mm
    // Bild kleiner als Rahmen: die sichtbare Bildkante zählt
    const s = mk([12, -3, 55, 40]);
    s.images[0].imageBounds = [12, 1, 55, 40];
    assert.ok(rules(scoreLayout(s)).includes('H6'));
});

test('H7 safeCrop sichtbar', () => {
    const motif = [17, 6, 50, 38];
    const s = baseScene({ images: [image(10, [12, -3, 55, 40], motif, { features: features(motif, { safe: [20, 10, 45, 42] }) })] });
    assert.ok(rules(scoreLayout(s)).includes('H7'));
    const n = baseScene();
    n.images[0].features = null;
    assert.ok(scoreLayout(n).skipped.some(x => x.rule === 'H7'));
});

test('H8 Mindestabstand Text ↔ Motiv, abschaltbar', () => {
    const s = baseScene();
    s.elements[1] = text(2, 'description', 38.5, 17, [28, 27, 28, 20]); // 0,5 mm neben dem Motiv (rechts 38)
    assert.deepEqual(rules(scoreLayout(s)), ['H8']);
    s.config = deepMerge(CONFIG, { scoring: { rules: { H8: false } } });
    assert.equal(scoreLayout(s).valid, true, JSON.stringify(scoreLayout(s).violations));
    const n = baseScene();
    n.images[0].motifRects = null;
    assert.ok(scoreLayout(n).skipped.some(x => x.rule === 'H8'));
});

test('H9 Textblöcke überlappen nicht', () => {
    const s = baseScene();
    s.elements[2] = text(3, 'price', 42, 25, [26]);
    assert.ok(rules(scoreLayout(s)).includes('H9'));
});

test('H10 Strich am Zeilenanfang und kurze Trennfragmente', () => {
    const s = baseScene();
    s.elements[0] = text(1, 'headline', 5, 5, [60, 40], { texts: ['Manualhi Pltfrm J Shoe Bkw', '- Schwarz/Weiss'] });
    assert.deepEqual(rules(scoreLayout(s)), ['H10']);
    const h = baseScene();
    h.elements[1] = text(2, 'description', 42, 17, [28, 27, 28, 20], { texts: ['Coole Boots mit Plateau', 'sohle aus Gummi und', 'Stoff, Farbe schwarz', 'und weiß'], hyphen: [0] });
    assert.equal(scoreLayout(h).valid, true, JSON.stringify(scoreLayout(h).violations));
    h.elements[1] = text(2, 'description', 42, 17, [28, 27, 28, 20], { texts: ['Coole Boots von DC. Die Soh', 'le ist eine Plateau', 'sohle aus Gummi', 'weiß'], hyphen: [0] });
    assert.ok(rules(scoreLayout(h)).includes('H10'));
});

// ------------------------------------------------------------------ Kriterien

test('S1 Ausrichtung: gemeinsame Kanten besser als verstreute; Wunsch-Ausrichtung', () => {
    const aligned = baseScene();
    const scattered = baseScene({
        elements: [
            text(1, 'headline', 6.2, 5.5, [58, 39]),
            text(2, 'description', 43.3, 18.2, [26, 25, 26, 19]),
            text(3, 'price', 41.1, 41.5, [26]),
        ],
    });
    assert.ok(S(aligned, 'S1') > S(scattered, 'S1') + 0.1, `${S(aligned, 'S1')} vs ${S(scattered, 'S1')}`);
    // Preis-Grundlinie auf Standlinie
    const motif = [17, 6, 50, 38];
    const withGround = (dy) => {
        const s = baseScene({ images: [image(10, [12, -3, 55, 40], motif, { features: features(motif, { ground: 50 }) })] });
        const p = text(3, 'price', 42, 0, [26]);
        const shift = 50 + dy - p.lines[0].baseline;
        for (const l of p.lines) { l.top += shift; l.bottom += shift; l.baseline += shift; }
        s.elements[2] = p;
        return scoreLayout(s, { detail: true });
    };
    const on = withGround(0), off = withGround(1);
    assert.ok(on.breakdown.S1.v > off.breakdown.S1.v, `${on.breakdown.S1.v} vs ${off.breakdown.S1.v}`);
    assert.ok(on.detail.alignment.wishes.some(([w, d]) => /price.lastBaseline/.test(w) && d === 0));
});

test('S1: unsichtbare Rahmenkanten (weißer Hintergrund) zählen nicht, angeschnittenes Motiv schon', () => {
    const motif = [17, 6, 50, 38];
    const s = baseScene({ images: [image(10, [12, -3, 45, 40], motif, { features: features(motif) })] });
    const d = scoreLayout(s, { detail: true }).detail.alignment;
    assert.ok(!d.unanchored.some(x => /frame\.right/.test(x)));
    // Motiv unten angeschnitten → Rahmenunterkante ist eine sichtbare Linie
    const cut = baseScene({ images: [image(10, [12, -3, 45, 40], [17, 6, 50, 38], { features: null })] });
    const all = JSON.stringify(scoreLayout(cut, { detail: true }).detail.alignment);
    assert.match(all, /10\.frame\.bottom/);
});

test('S2 Rhythmus: Lücken als Modul-Vielfache besser als krumme', () => {
    const mk = (g1, g2) => baseScene({
        elements: [
            text(1, 'headline', 42, 5, [28]),
            text(2, 'description', 42, 0, [28, 27]),
            text(3, 'price', 42, 0, [26]),
        ],
    });
    const stack = (g1, g2) => {
        const s = mk();
        const [h, d, p] = s.elements;
        const move = (e, top) => { const dy = top - e.lines[0].top; for (const l of e.lines) { l.top += dy; l.bottom += dy; l.baseline += dy; } };
        move(d, h.lines.at(-1).bottom + g1);
        move(p, d.lines.at(-1).bottom + g2);
        return s;
    };
    const good = S(stack(2.5, 2.5), 'S2'), bad = S(stack(1.3, 3.8), 'S2');
    assert.ok(good > bad + 0.2, `${good} vs ${bad}`);
});

test('S3 Gruppierung: Text nah am Motiv schlechter als Textgruppe mit Abstand', () => {
    const near = baseScene();
    near.elements = near.elements.map(e => text(e.id, e.role, 39.2, e.lines[0].top, e.lines.map(l => l.width)));
    near.elements[0] = text(1, 'headline', 39.2, 5, [30]);
    const far = baseScene();
    far.elements[0] = text(1, 'headline', 46, 5, [24]);
    far.elements[1] = text(2, 'description', 46, 12, [24, 23, 24, 18]);
    far.elements[2] = text(3, 'price', 46, 28, [24]);
    assert.ok(S(far, 'S3') > S(near, 'S3'), `${S(far, 'S3')} vs ${S(near, 'S3')}`);
});

test('S4 Hierarchie: Gewicht passend zum Rang besser als umgekehrt', () => {
    const cfg = deepMerge(CONFIG, { roles: { image: { rank: 9 } } });
    const good = baseScene({ config: cfg });
    const bad = baseScene({ config: cfg });
    bad.elements[0] = text(1, 'headline', 5, 5, [12], { style: { fontStyle: 'Regular', ink: 0.3 } });
    assert.ok(S(good, 'S4') > S(bad, 'S4'), `${S(good, 'S4')} vs ${S(bad, 'S4')}`);
});

test('S5 Balance: Schwerpunkt mittig besser als in der Ecke', () => {
    const corner = baseScene({
        elements: [text(1, 'headline', 5, 5, [20]), text(2, 'description', 5, 12, [20, 20]), text(3, 'price', 5, 20, [20])],
        images: [image(10, [5, 30, 20, 45], [6, 31, 19, 44], { features: features([6, 31, 19, 44]) })],
    });
    assert.ok(S(baseScene(), 'S5') > S(corner, 'S5'));
});

test('S6 Weißraum: eingeklemmte Lücke und großes Loch kosten', () => {
    const s = baseScene();
    const pinched = baseScene();
    pinched.elements[2] = text(3, 'price', 42, s.elements[1].lines.at(-1).bottom + 0.6, [26]);
    assert.ok(S(s, 'S6') > S(pinched, 'S6'));
    assert.match(scoreLayout(pinched).breakdown.S6.note, /pinched/);
    const hole = baseScene({
        elements: [text(1, 'headline', 5, 5, [30]), text(2, 'description', 5, 12, [30, 28]), text(3, 'price', 5, 20, [26])],
        images: [image(10, [5, 40, 20, 55], [6, 41, 19, 54], { features: features([6, 41, 19, 54]) })],
    });
    assert.ok(S(hole, 'S6') < S(s, 'S6'));
});

test('S7 Bildanteil im Zielbereich; ohne Bild null und nicht gewichtet', () => {
    const big = baseScene(); // Motiv 33 × 32 mm ≈ 32 % des Satzspiegels
    const small = baseScene({ images: [image(10, [12, -3, 55, 40], [30, 20, 40, 30], { features: features([30, 20, 40, 30]) })] });
    assert.ok(S(big, 'S7') > S(small, 'S7'));
    const none = baseScene({ images: [] });
    const r = scoreLayout(none);
    assert.equal(r.breakdown.S7.v, null);
    assert.equal(r.breakdown.S10.v, null);
    assert.ok(r.score !== null);
});

test('S8 Typografie: kurze letzte Zeile und Trennungen kosten', () => {
    const good = baseScene();
    const bad = baseScene();
    bad.elements[1] = text(2, 'description', 42, 17, [28, 27, 28, 4], { texts: ['Coole Boots von DC. Die So', 'hle ist eine Plateau', 'sohle aus Gummi und Stoff', 'weiß'], hyphen: [0, 1] });
    assert.ok(S(good, 'S8') > S(bad, 'S8'), `${S(good, 'S8')} vs ${S(bad, 'S8')}`);
});

test('S9 Lesefluss: Preis vor Beschreibung ist eine Inversion', () => {
    const inv = baseScene();
    inv.elements[1] = text(2, 'description', 42, 30, [28, 27, 28]);
    inv.elements[2] = text(3, 'price', 42, 17, [26]);
    assert.equal(S(baseScene(), 'S9'), 1);
    assert.ok(S(inv, 'S9') < 1);
});

test('S10 Blickrichtung: zum Text 1, weg 0, unsicher neutral', () => {
    const motif = [17, 6, 50, 38];
    const mk = (dir, angle, conf) => baseScene({ images: [image(10, [12, -3, 55, 40], motif, { features: features(motif, { dir, angle, conf }) })] });
    assert.ok(S(mk('right', 0, 0.8), 'S10') > 0.8);
    assert.ok(S(mk('left', 180, 0.8), 'S10') < 0.2);
    assert.equal(S(mk('left', 180, 0.1), 'S10'), 0.5);
});

test('placeImageData: Maske und Merkmale in Seiten-mm', () => {
    const mask = { cols: 2, rows: 2, cells: [[0, 0, 0, 0, 0.5, 0.5], [1, 1, 0.5, 0.5, 1, 1]] };
    const d = placeImageData(mask, null, { imageBounds: [10, 10, 30, 30], frameBounds: [10, 10, 25, 30], pageBounds: [0, 0, 60, 75] });
    assert.equal(d.features, null);
    assert.equal(d.motifRects.length, 2);
    assert.deepEqual(d.motifRects[1], { top: 20, left: 20, bottom: 25, right: 30 });
});

test('Geschwindigkeit: 1000 Bewertungen', () => {
    const s = baseScene();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) scoreLayout(s);
    const ms = performance.now() - t0;
    console.log(`     ${(ms / 1000).toFixed(2)} ms je Szene`);
    assert.ok(ms < 20000);
});

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
