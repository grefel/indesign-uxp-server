#!/usr/bin/env node
/**
 * Tests für src/utils/layoutModel.js (ohne InDesign).
 *   node tests/test-layout-model.js
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    DEFAULT_CONFIG, deepMerge, findConfigFile, loadConfig, validateConfig, stripComments,
    matchRole, planPointSizes, buildFormat, physicalMargins, edgeSides, reachesBleed,
    pathAnchors, shapeFromPaths, normalizePolygon, polygonArea, polygonBounds,
    summarizeLines, tableRow, relativeLines, TABLE_COLS, parseWidths, resolveHyphenation, textColumnWidth,
} from '../src/utils/layoutModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-model-'));
const cfgDefaults = loadConfig({ env: {} }).config;

test('deepMerge: Objekte gemischt, Arrays ersetzt, Kommentare ignoriert', () => {
    const m = deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9], $comment: 'x' });
    assert.deepEqual(m, { a: { b: 1, c: 3 }, l: [9] });
});

test('findConfigFile: Dokumentordner aufwärts, dann Env, dann Defaults', () => {
    const proj = path.join(tmp, 'proj'), sub = path.join(proj, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(proj, 'artwork.config.json'), JSON.stringify({ imageBleed: 5 }));
    const doc = path.join(sub, 'x.indd');
    assert.equal(findConfigFile({ docPath: doc, env: {} }).file, path.join(proj, 'artwork.config.json'));
    const envFile = path.join(tmp, 'env.json');
    fs.writeFileSync(envFile, '{}');
    assert.equal(findConfigFile({ docPath: path.join(tmp, 'other', 'y.indd'), env: { ARTWORK_CONFIG: envFile } }).source, 'env');
    assert.equal(findConfigFile({ env: {} }).source, 'defaults');
    // configPath als Ordner
    assert.equal(findConfigFile({ configPath: proj, env: {} }).source, 'configPath');
    assert.throws(() => findConfigFile({ configPath: path.join(tmp, 'nope.json'), env: {} }), /not found/);
});

test('loadConfig: Datei über Defaults mischen', () => {
    const { config, source } = loadConfig({ docPath: path.join(tmp, 'proj', 'a', 'x.indd'), env: {} });
    assert.equal(source, 'document');
    assert.equal(config.imageBleed, 5);
    assert.equal(config.roles.headline.allow.pointSize, 0.15);
});

test('Beispiel-Konfiguration im artworker-Projekt ist gültig', () => {
    const f = 'C:/Users/hp/git-px/artworker/artwork.config.json';
    if (!fs.existsSync(f)) return;
    const { config } = loadConfig({ configPath: f, env: {} });
    assert.equal(config.imageBleed, 3);
    assert.ok(!('$match' in config));
});

test('validateConfig: unbekannte Rolle, Kriterium, Regex, Trenn-Eigenschaft', () => {
    const base = stripComments(DEFAULT_CONFIG);
    assert.throws(() => validateConfig({ ...base, match: [{ role: 'foo', kind: 'text' }] }), /not defined/);
    assert.throws(() => validateConfig({ ...base, match: [{ role: 'image', colour: 'x' }] }), /unknown criterion/);
    assert.throws(() => validateConfig({ ...base, match: [{ role: 'image', name: '(' }] }), /invalid regex/);
    assert.throws(() => validateConfig(deepMerge(base, { hyphenation: { variants: { x: { 'a.b': 1 } } } })), /only InDesign/);
    assert.throws(() => validateConfig(deepMerge(base, { roles: { headline: { allow: { pointSize: 15 } } } })), /fraction/);
});

test('matchRole: Priorität, Absatzformat, Preis-Inhalt, Bild, unknown', () => {
    const rules = cfgDefaults.match;
    assert.equal(matchRole({ kind: 'text', paragraphStyle: 'h1', content: 'Nur 9,99 €' }, rules).role, 'headline');
    assert.equal(matchRole({ kind: 'text', paragraphStyle: 'desc', content: 'Text' }, rules).role, 'description');
    assert.equal(matchRole({ kind: 'text', paragraphStyle: '[Einfacher Absatz]', content: '67,99 €' }, rules).role, 'price');
    assert.equal(matchRole({ kind: 'text', paragraphStyle: '[Einfacher Absatz]', content: 'x'.repeat(50) + ' 9,99' }, rules).role, 'unknown');
    assert.equal(matchRole({ kind: 'graphic', link: 'firmenLogo.ai' }, rules).role, 'logo');
    assert.equal(matchRole({ kind: 'graphic', link: '300670.JPG' }, rules).role, 'image');
    assert.equal(matchRole({ kind: 'shape' }, rules).role, 'unknown');
    // eingebettete Variante (UXP) verhält sich gleich
    const embedded = new Function(`${matchRole.toString()}; return matchRole;`)();
    assert.deepEqual(embedded({ kind: 'text', paragraphStyle: 'price' }, rules), matchRole({ kind: 'text', paragraphStyle: 'price' }, rules));
});

test('planPointSizes: ±15 % bei headline, sonst nur Referenz', () => {
    const p = planPointSizes(12, [10, 10.2, 12, 13.8, 14], { pointSize: 0.15 });
    assert.deepEqual(p.ok, [10.2, 12, 13.8]);
    assert.deepEqual(p.rejected, [10, 14]);
    assert.deepEqual(planPointSizes(8, [], {}).ok, [8]);
    assert.deepEqual(planPointSizes(8, [9], {}).rejected, [9]);
});

test('buildFormat: Seitenränder, Satzspiegel, Bild-Anschnitt, Module', () => {
    const raw = { index: 0, name: '1', bounds: [0, 0, 60, 75], side: 'RIGHT_HAND', margins: [5, 5, 5, 5], cols: 1, gutter: 4.233, docBleed: [0, 0, 0, 0], facing: false, grid: { start: 12.7, step: 4.233, shown: false, relative: 'TOP_OF_PAGE_OF_BASELINE_GRID_RELATIVE_OPTION' } };
    const f = buildFormat(raw, cfgDefaults);
    assert.deepEqual(f.typeArea, [5, 5, 55, 70]);
    assert.deepEqual(f.imageBleedBox, [-3, -3, 63, 78]);
    assert.equal(f.docBleed, 0);
    assert.deepEqual(f.modules, { margin: 5, gap: 2.5 });
    assert.equal(f.grid, null);
    assert.ok(buildFormat(raw, cfgDefaults, true).grid);
    assert.deepEqual(physicalMargins([1, 2, 3, 4], true, 'LEFT_HAND'), [1, 4, 3, 2]);
});

test('edgeSides / reachesBleed', () => {
    assert.equal(edgeSides([0, 10, 60, 75], [0, 0, 60, 75]), 'tbr');
    assert.equal(edgeSides([7.99, 1.77, 58, 50.45], [0, 0, 60, 75]), '');
    assert.equal(reachesBleed([-3, 10, 63, 78], 'tbr', [-3, -3, 63, 78]), true);
    assert.equal(reachesBleed([0, 10, 63, 78], 'tbr', [-3, -3, 63, 78]), false);
});

test('shapeFromPaths: Rechteck → null, Dreieck/Kurven → Punkte', () => {
    const b = [2, 33, 22.4, 73];
    assert.equal(shapeFromPaths([[[33, 2], [33, 22.4], [73, 22.4], [73, 2]]], b), null);
    const tri = shapeFromPaths([[[33, 2], [73, 2], [33, 22.4]]], b);
    assert.deepEqual(tri.pts, [[33, 2], [73, 2], [33, 22.4]]);
    const curved = [[[0, 0], [1, 0], [2, 0]], [[5, 5], [5, 5], [5, 5]], [[0, 5], [0, 5], [0, 5]]];
    assert.equal(pathAnchors(curved).curved, true);
    assert.equal(shapeFromPaths([curved], [0, 0, 5, 5]).curved, true);
});

test('normalizePolygon / Fläche / Bounds', () => {
    const p = normalizePolygon([[5, 20], [45, 20], [45, 20], [5, 55], [5, 20]]);
    assert.deepEqual(p, [[5, 20], [45, 20], [5, 55]]);
    assert.equal(polygonArea(p), 700);
    assert.deepEqual(polygonBounds(p), [20, 5, 55, 45]);
    assert.throws(() => normalizePolygon([[0, 0], [1, 1], [2, 2]]), /no area/);
    assert.throws(() => normalizePolygon([[0, 0], [1]]), /\[x, y\]/);
});

// Zeilen: [text, baseline, ascent, descent, x, width, paragraphEnd, hyphenated]
const lines = [
    ['Coole Boots von DC. Die ', 5.02, 3.02, 0.83, 33, 40, 0, 0],
    ['Sohle ist eine Plateau', 8.4, 3.02, 0.83, 33, 36, 0, 1],
    ['- sohle Höhe', 11.79, 3.02, 0.83, 33, 38, 0, 0],
    ['weiß.', 15.18, 3.02, 0.83, 33, 8, 1, 0],
];

test('summarizeLines: Höhe, Grundlinien, Trennungen, Strich am Anfang, Flatter', () => {
    const s = summarizeLines(lines, { top: 2, textWidth: 40 });
    assert.equal(s.n, 4);
    assert.equal(s.top, 0);
    assert.equal(s.fb, 3.02);
    assert.equal(s.lb, 13.18);
    assert.equal(s.h, 14.01);
    assert.equal(s.hyphens, 1);
    assert.equal(s.dashStarts, 1);
    assert.equal(s.lastRel, 0.2);
    assert.equal(s.rag, 1.63); // Std.-Abw. von 40, 36, 38
    assert.equal(summarizeLines([], {}).n, 0);
});

test('tableRow: kompakte Zeile gemäß TABLE_COLS', () => {
    const row = tableRow({ w: 40, pt: 8, hyph: 'on', overset: 0, lines: relativeLines(lines, 2, 33) }, { inset: [0, 0, 0, 0], cols: 1, gutter: 0 });
    assert.equal(row.length, TABLE_COLS.length);
    assert.deepEqual(row.slice(0, 4), [40, 8, 'on', 4]);
    assert.equal(row[TABLE_COLS.indexOf('lastRel')], 0.2);
    assert.equal(textColumnWidth(50, [1, 2, 1, 3], 2, 5), 20);
});

test('parseWidths / resolveHyphenation', () => {
    assert.deepEqual(parseWidths({ min: 25, max: 45, step: 10 }), [25, 35, 45]);
    assert.deepEqual(parseWidths([30, 20, 20.004]), [20, 30]);
    assert.throws(() => parseWidths({ min: 1, max: 1000, step: 1 }), /max 200/);
    assert.throws(() => parseWidths([0]), /invalid width/);
    assert.deepEqual(resolveHyphenation(undefined, cfgDefaults).map(v => v.name), ['off', 'on', 'strict']);
    assert.deepEqual(resolveHyphenation(undefined, cfgDefaults, { single: true }), [{ name: 'asIs', props: {} }]);
    assert.throws(() => resolveHyphenation(['nix'], cfgDefaults), /Unknown hyphenation/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
