#!/usr/bin/env node
/**
 * Tests für src/utils/imageFeatures.js (ohne InDesign).
 * Optional: Pfad zu einem echten Bild als Argument, sonst das Artworker-Testbild.
 *   node tests/test-image-features.js [bild.jpg]
 */
import assert from 'assert/strict';
import { existsSync, readFileSync } from 'fs';
import {
    computeImageFeatures, placeFeatures, featureSummary, pageAngle, lineClass,
    getImageFeatures, readCachedFeatures, normalizeFeatureParams,
} from '../src/utils/imageFeatures.js';
import { getMotifMask } from '../src/utils/imageMask.js';

let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').filter(l => l.trim()).join('\n     ')}\n     ${e.stack.split('\n').find(l => l.includes('test-image-features')) ?? ''}`); }
}

const W = 200, H = 150;
const blank = (v = 255) => new Uint8Array(W * H).fill(v);
const fill = (g, inside, v = 0) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x + 0.5, y + 0.5)) g[y * W + x] = v; return g; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);
// Bild 100 × 75 mm an (10, 20), Rahmen = Bild
const placement = (extra = {}) => ({ imageBounds: [20, 10, 95, 110], clip: [20, 10, 95, 110], ...extra });

await test('pageAngle/lineClass: Konvention gegen den Uhrzeigersinn, Klassen', () => {
    assert.equal(pageAngle(10, 0), 0);
    near(pageAngle(10, -10), 45, 1e-9, 'rising right');
    near(pageAngle(-10, 10), 45, 1e-9, 'same line reversed');
    assert.equal(pageAngle(0, 5), 90);
    assert.equal(lineClass(4, 5), 'horizontal');
    assert.equal(lineClass(-87, 5), 'vertical');
    assert.equal(lineClass(30, 5), 'diagonal');
    assert.throws(() => normalizeFeatureParams({ maxEdges: 20 }), /maxEdges/);
});

await test('Rechteck: Standlinie horizontal, harte Kanten, h/v-Linien', () => {
    const g = fill(blank(), (x, y) => x >= 40 && x < 160 && y >= 30 && y < 110);
    const f = computeImageFeatures(g, W, H);
    assert.deepEqual(f.motif, [0.2, 0.2, 0.8, 0.733]);
    assert.ok(f.ground, 'groundLine found');
    near(f.ground.p0[1], 110 / H, 0.01);
    assert.ok(f.ground.quality > 0.9);
    for (const k of ['left', 'right', 'top', 'bottom']) assert.equal(f.extremes[k].hard, true, k);
    const p = placeFeatures(f, placement());
    assert.equal(p.groundLine.angle, 0);
    near(p.groundLine.yLeft, 20 + 110 / H * 75, 0.6);
    assert.deepEqual(p.groundLine.x, [30, 90]);
    assert.ok(p.edges.length >= 4);
    assert.ok(p.edges.slice(0, 4).every(e => e.cls !== 'diagonal'), 'axis-parallel edges first');
    assert.equal(p.edges.filter(e => e.cls === 'horizontal').length, 2);
    assert.equal(p.extremes.left.x, 30);
    assert.equal(p.principalAxis.angle, 0);
    near(p.principalAxis.length, 60, 1);
    assert.equal(p.direction.dir, 'none', 'symmetric → no direction');
});

await test('Dreieck mit Spitze links: direction left, Spiegelung → right', () => {
    // Spitze (15, 75), Basis x = 185 von y 25 bis 125
    const g = fill(blank(), (x, y) => x >= 15 && x <= 185 && Math.abs(y - 75) <= (x - 15) / 170 * 50);
    const f = computeImageFeatures(g, W, H);
    const p = placeFeatures(f, placement());
    assert.equal(p.direction.dir, 'left');
    assert.ok(p.direction.confidence >= 0.5, `confidence ${p.direction.confidence}`);
    near(Math.abs(p.direction.angle), 180, 2);
    assert.equal(p.extremes.left.hard, false, 'tip is no alignment edge');
    assert.equal(p.extremes.right.hard, true, 'base is a hard edge');
    assert.equal(p.groundLine, null, 'slanted bottom is no ground line');
    const m = placeFeatures(f, placement({ flipH: true }));
    assert.equal(m.direction.dir, 'right');
    assert.equal(m.extremes.left.hard, true);
    near(m.extremes.left.x, 110 - 185 / W * 100, 0.6);
    // Diagonale Schenkel: ±~16° (100 mm × 75 mm Bild, Pixel quadratisch skaliert)
    assert.ok(p.edges.some(e => e.cls === 'diagonal' && Math.abs(Math.abs(e.angle) - 16) <= 2), JSON.stringify(p.edges.map(e => e.angle)));
});

await test('Saliency: kontrastreicher Fleck wird Fokus', () => {
    // Graue Fläche mit Schachbrett oben rechts
    const g = fill(blank(), (x, y) => x >= 20 && x < 180 && y >= 15 && y < 135, 140);
    fill(g, (x, y) => x >= 130 && x < 160 && y >= 30 && y < 60 && (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0, 20);
    fill(g, (x, y) => x >= 130 && x < 160 && y >= 30 && y < 60 && (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 1, 240);
    const f = computeImageFeatures(g, W, H);
    const [fx, fy] = f.focus.pt;
    assert.ok(fx > 0.6 && fx < 0.82 && fy > 0.17 && fy < 0.42, `focus ${f.focus.pt}`);
    assert.ok(f.focus.conf >= 0.4, `confidence ${f.focus.conf}`);
    const p = placeFeatures(f, placement({ clip: [20, 10, 95, 60] }));
    assert.equal(p.focus.visible, false, 'focus outside clip');
    assert.ok(p.safeCrop.minCutNow.includes('right'));
    const s = featureSummary(f, placement());
    assert.equal(s.focus.length, 3);
    assert.equal(s.direction, 'none');
});

await test('leeres Bild: keine Merkmale', () => {
    const f = computeImageFeatures(blank(), W, H);
    assert.equal(f.motif, null);
    assert.deepEqual(placeFeatures(f, placement()), { motif: null });
    assert.equal(featureSummary(f, placement()), null);
});

const real = process.argv[2] || 'C:/Users/hp/git-px/artworker/test/Links/300670.JPG';
if (existsSync(real)) {
    await test(`echtes Bild ${real}`, async () => {
        const t0 = Date.now();
        const f = await getImageFeatures(real, {}, { useCache: false });
        const dt = Date.now() - t0;
        // Platzierung ähnlich testArtikel: 60 × 61,6 mm
        const pl = { imageBounds: [0, 0, 61.6, 60], clip: [0, 0, 61.6, 60] };
        const p = placeFeatures(f, pl);
        console.log(`     ${dt} ms`);
        console.log('     ' + JSON.stringify({ focus: p.focus, groundLine: p.groundLine, direction: p.direction, axis: p.principalAxis, extremes: p.extremes }));
        console.log(p.edges.map(e => `     ${e.cls.padEnd(10)} ${String(e.angle).padStart(4)}°  ${e.length} mm  s ${e.strength}  ${e.from} → ${e.to}`).join('\n'));
        const [x0, y0, x1, y1] = f.motif;
        assert.ok(x0 < 0.05 && x1 > 0.95 && near2(y0, 0.19) && near2(y1, 0.83), `motif ${f.motif}`);
        assert.equal(p.direction.dir, 'left', 'toe points left');
        assert.ok(p.direction.confidence >= 0.3);
        assert.ok(p.groundLine, 'sole bottom found');
        assert.equal(p.groundLine.angle, 0);
        near(p.groundLine.yLeft / 61.6, 0.83, 0.01, 'ground at sole bottom');
        assert.equal(p.extremes.bottom.hard, true);
        assert.equal(p.extremes.top.hard, false);
        // Fokus auf Schnürung/Schaft, nicht auf der weißen Sohle
        assert.ok(p.focus.norm[0] > 0.35 && p.focus.norm[0] < 0.7 && p.focus.norm[1] > 0.3 && p.focus.norm[1] < 0.6, `focus ${p.focus.norm}`);
        // Sohlenstreifen als lange Kante (perspektivisch leicht steigend)
        assert.ok(p.edges.some(e => e.length > 25 && e.angle > 0 && e.angle < 15 && e.from[1] / 61.6 > 0.55), 'sole stripe');
        assert.ok(p.edges.some(e => e.cls === 'horizontal' && Math.abs(e.from[1] / 61.6 - 0.83) < 0.01), 'horizontal bottom edge');
    });
    await test('Sidecar-Cache: Merkmale bleiben neben der Maske erhalten', async () => {
        await getImageFeatures(real, {});
        await getMotifMask(real, { grid: 24 }, { useCache: true });
        const json = JSON.parse(readFileSync(`${real}.freespace.json`, 'utf8'));
        assert.ok(json.features?.entries?.w250_s512, 'features in sidecar');
        assert.ok(json.entries, 'mask entries present');
        const c = await readCachedFeatures(real);
        assert.ok(c?.focus);
        assert.equal(await readCachedFeatures('C:/does/not/exist.jpg'), null);
    });
} else {
    console.log(`skip echtes Bild (nicht gefunden: ${real})`);
}

function near2(a, b) { return Math.abs(a - b) <= 0.02; }

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
