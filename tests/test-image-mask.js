#!/usr/bin/env node
/**
 * Tests für src/utils/imageMask.js (ohne InDesign).
 * Optional: Pfad zu einem echten Bild als Argument, sonst das Artworker-Testbild.
 *   node tests/test-image-mask.js [bild.jpg]
 */
import assert from 'assert/strict';
import { existsSync, rmSync } from 'fs';
import {
    buildMask, gridDims, getMotifMask, placeMask, rowSpans, largestFreeRects,
    checkRect, rectDistance, resolutionInfo, orientedMaskRows,
} from '../src/utils/imageMask.js';

let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// Synthetisches Bild 200×100: weiß, schwarzes Quadrat x 120..179, y 20..79, weißes Loch darin
function synthetic() {
    const w = 200, h = 100, g = new Uint8Array(w * h).fill(255);
    for (let y = 20; y < 80; y++) for (let x = 120; x < 180; x++) g[y * w + x] = 0;
    for (let y = 40; y < 60; y++) for (let x = 140; x < 160; x++) g[y * w + x] = 255;
    return { g, w, h };
}
const P = { grid: 20, whiteThreshold: 250, occupiedRatio: 0.02 };

await test('gridDims: quadratische Zellen, längere Seite = grid', () => {
    assert.deepEqual(gridDims(200, 100, 20), { cols: 20, rows: 10 });
    assert.deepEqual(gridDims(1168, 1200, 32), { cols: 31, rows: 32 });
});

await test('buildMask: Motiv, Pixel-BBox und gefüllte Löcher', () => {
    const { g, w, h } = synthetic();
    const m = buildMask(g, w, h, P);
    assert.equal(m.maskRows.length, 10);
    assert.equal(m.maskRows[0], '....................');
    assert.equal(m.maskRows[5], '............######..');
    const xs = m.cells.map(c => c[2]), x1 = m.cells.map(c => c[4]);
    assert.equal(Math.min(...xs), 0.6);
    assert.equal(Math.max(...x1), 0.9);
    const noFill = buildMask(g, w, h, { ...P, fillHoles: false });
    assert.equal(noFill.maskRows[4], '............##..##..');
});

await test('placeMask/rowSpans: Umrechnung in Seiten-mm, Beschnitt, Spiegelung', () => {
    const { g, w, h } = synthetic();
    const m = buildMask(g, w, h, P);
    // Bild 100×50 mm an (10,10); Rahmen schneidet rechts bei x=95 ab
    const placement = { imageBounds: [10, 10, 60, 110], clip: [10, 10, 60, 95] };
    const placed = placeMask(m, placement);
    const spans = rowSpans(placed);
    assert.deepEqual(spans[0], [20, 25, 70, 95]);
    assert.equal(spans.length, 6);
    const full = rowSpans(placed, { visibleOnly: false });
    assert.deepEqual(full[0], [20, 25, 70, 100]);
    const flipped = placeMask(m, { ...placement, flipH: true, clip: null });
    assert.deepEqual(rowSpans(flipped)[0], [20, 25, 20, 50]);
    assert.equal(orientedMaskRows(m, { flipH: true })[5], '..######............');
});

await test('largestFreeRects: größte Freifläche links', () => {
    const { g, w, h } = synthetic();
    const m = buildMask(g, w, h, P);
    const placement = { imageBounds: [0, 0, 50, 100], clip: [0, 0, 50, 100] };
    const free = largestFreeRects(placeMask(m, placement), placement);
    assert.deepEqual(free[0].bounds, [0, 0, 50, 60]);
});

await test('checkRect/rectDistance', () => {
    const motif = [{ top: 10, left: 10, bottom: 20, right: 20 }];
    assert.equal(rectDistance({ top: 0, left: 23, bottom: 5, right: 30 }, motif[0]), Math.hypot(3, 5));
    const hit = checkRect({ top: 15, left: 0, bottom: 18, right: 12 }, motif);
    assert.equal(hit.collides, true);
    assert.equal(hit.overlapX, 2);
    assert.equal(hit.overlapY, 3);
    assert.equal(checkRect({ top: 15, left: 0, bottom: 18, right: 8 }, motif).collides, false);
    assert.equal(checkRect({ top: 15, left: 0, bottom: 18, right: 8 }, motif, 3).collides, true);
});

await test('resolutionInfo: Reserve bis 200 ppi', () => {
    const r = resolutionInfo({ pixelWidth: 2000, pixelHeight: 1000 }, [0, 0, 50, 127]);
    assert.equal(r.maxWidthMmAt200dpi, 254);
    assert.equal(r.maxScaleFactorAt200dpi, 2);
});

const real = process.argv[2] || 'C:/Users/hp/git-px/artworker/test/Links/300670.JPG';
if (existsSync(real)) {
    await test(`echtes Bild ${real}`, async () => {
        const sidecar = `${real}.freespace.json`;
        if (existsSync(sidecar)) rmSync(sidecar);
        const t0 = Date.now();
        const m = await getMotifMask(real, { grid: 32 });
        const dt = Date.now() - t0;
        const m2 = await getMotifMask(real, { grid: 32 });
        assert.equal(m2.cache, 'memory');
        assert.deepEqual(m2.maskRows, m.maskRows);
        const x0 = Math.min(...m.cells.map(c => c[2])), y0 = Math.min(...m.cells.map(c => c[3]));
        const x1 = Math.max(...m.cells.map(c => c[4])), y1 = Math.max(...m.cells.map(c => c[5]));
        console.log(`     ${m.pixelWidth}×${m.pixelHeight}, ${m.cols}×${m.rows} Zellen, ${dt} ms, Cache: ${m.cache}`);
        console.log(`     motifBBox norm x ${x0.toFixed(3)}–${x1.toFixed(3)}, y ${y0.toFixed(3)}–${y1.toFixed(3)}`);
        console.log(m.maskRows.map(r => '     ' + r).join('\n'));
        assert.equal(m.pixelWidth, 1168);
        assert.equal(m.pixelHeight, 1200);
        // Sneaker: fast volle Breite, oberes Viertel frei
        assert.ok(x0 < 0.06 && x1 > 0.94, 'motif spans nearly full width');
        assert.ok(y0 > 0.1, 'top area is free');
        assert.equal(m.maskRows[2].includes('#'), false);
    });
} else {
    console.log(`skip echtes Bild (nicht gefunden: ${real})`);
}

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
