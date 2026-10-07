/**
 * Layout-Solver: Messen (Layout-Modell + Breiten-Tabellen in Paketen),
 * Kandidaten in Node erzeugen/bewerten (utils/layoutSolver.js), die besten
 * divers auf Ebenen schreiben, nachmessen und als Kontaktbogen exportieren.
 *
 * Bridge-Roundtrips: Modell 1 + Messpakete (≤ measure.maxProbesPerScript
 * Proben je Skript) + Polygone 0–1 + Anwenden 1 + Vorschau 1.
 * Längen in mm, Schriftgrade in pt.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { TEXT_HELPERS } from '../utils/textSnippets.js';
import { loadConfig } from '../utils/layoutModel.js';
import { getMotifMask, loadGray } from '../utils/imageMask.js';
import { getImageFeatures } from '../utils/imageFeatures.js';
import { scoringConfig } from '../utils/layoutScore.js';
import {
    solverConfig, measurePlan, planMeasureJobs, batchJobs, mergeMeasurements, buildProblem, solve,
    polygonJobs, applyPolygonResult, prefilter, evaluate, selectDiverse, toSpec, validateSpec, compareApplied,
} from '../utils/layoutSolver.js';
import { layoutModelCode, buildModel, MEASURE_SNIPPET } from './layoutModelHandlers.js';

const MAX_CANDIDATES = 6;
// Konfiguration des letzten artwork_solve → artwork_apply ohne configPath
let lastRun = null;

const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);

/** Elemente per id einmal nachschlagen (allPageItems, auch verschachtelt). */
const BY_ID_SNIPPET = (ids) => `
            const __ids = ${JSON.stringify(ids)};
            const __byId = new Map();
            {
                const all = doc.allPageItems;
                for (let i = 0; i < all.length; i++) if (__ids.indexOf(all[i].id) >= 0) __byId.set(all[i].id, all[i]);
            }
`;

/** UXP: ein Messpaket – je Auftrag ein Duplikat, je Breite eine Probe; Zeilen relativ zur Rahmenoberkante/-linken. */
export function measureBatchCode(batch) {
    const ids = [...new Set(batch.map(j => j.id))];
    return `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            ${TEXT_HELPERS}
            ${MEASURE_SNIPPET}
            ${BY_ID_SNIPPET(ids)}
            const __jobs = ${JSON.stringify(batch.map(j => ({ id: j.id, pt: j.pt, hyph: j.hyph, keep: j.keep, widths: j.widths })))};
            ${withMillimetersUnitsSnippet(`
                const frames = {};
                for (const job of __jobs) {
                    const frame = __byId.get(job.id);
                    if (!frame) { frames[job.id] = { id: job.id, error: 'not found' }; continue; }
                    const err = __frameErr(frame);
                    if (err) { frames[job.id] = { id: job.id, error: err }; continue; }
                    const gb = frame.geometricBounds;
                    const c0 = frame.characters.item(0);
                    const ref = c0.pointSize;
                    if (!frames[job.id]) {
                        frames[job.id] = {
                            id: job.id, ref: __r(ref), refLd: __r(typeof c0.leading === 'number' ? c0.leading : ref * c0.autoLeading / 100),
                            align: String(frame.paragraphs.item(0).justification), paras: frame.paragraphs.length, rows: [],
                        };
                    }
                    const F = frames[job.id];
                    const dup = frame.duplicate();
                    try {
                        __prepare(dup);
                        __scale(dup, job.pt / ref);
                        __variant(dup, job.hyph.props);
                        if (job.keep) dup.texts.item(0).noBreak = true;
                        const d0 = dup.characters.item(0);
                        const ld = __r(typeof d0.leading === 'number' ? d0.leading : d0.pointSize * d0.autoLeading / 100);
                        for (const w of job.widths) {
                            dup.geometricBounds = [gb[0], gb[1], gb[0] + 1000, gb[1] + w];
                            // Bei Übersatz sind Zeilen-Eigenschaften teils nicht lesbar
                            if (dup.overflows || !dup.lines.length) { F.rows.push({ w: [w, w], pt: job.pt, ld, hyph: job.hyph.name, ov: 1, lines: null }); continue; }
                            const lines = __readLines(dup).map(l => [l.contents, __r(l.baseline - gb[0]), l.ascent, l.descent, __r(l.x - gb[1]), l.width, l.paragraphEnd ? 1 : 0, l.hyphenated ? 1 : 0]);
                            F.rows.push({ w: [w, w], pt: job.pt, ld, hyph: job.hyph.name, ov: 0, lines });
                        }
                    } finally { dup.remove(); }
                }
                return { success: true, frames: Object.values(frames) };
            `)}
    `;
}

/** UXP: Text in Polygon-Umrisse laufen lassen (je Auftrag ein Duplikat), Zeilen absolut. */
export function polygonBatchCode(jobs, hyphProps) {
    const ids = [...new Set(jobs.map(j => j.elId))];
    return `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            ${TEXT_HELPERS}
            ${MEASURE_SNIPPET}
            ${BY_ID_SNIPPET(ids)}
            const __jobs = ${JSON.stringify(jobs.map(j => ({ id: j.id, elId: j.elId, pt: j.pt, ld: j.ld, props: hyphProps[j.hyph] || {}, points: j.points })))};
            ${withMillimetersUnitsSnippet(`
                const out = [];
                for (const job of __jobs) {
                    const frame = __byId.get(job.elId);
                    if (!frame) { out.push({ id: job.id, error: 'not found' }); continue; }
                    const dup = frame.duplicate();
                    try {
                        __prepare(dup);
                        __scale(dup, job.pt / frame.characters.item(0).pointSize);
                        if (job.ld) dup.texts.item(0).leading = job.ld;
                        __variant(dup, job.props);
                        dup.paths.item(0).entirePath = job.points;
                        const ov = __oversetInfo(dup).oversetCharacters;
                        const lines = ov || !dup.lines.length ? [] : __readLines(dup).map(__lineArr);
                        out.push({ id: job.id, overset: ov, lines });
                    } catch (e) { out.push({ id: job.id, error: String(e.message || e) }); }
                    finally { dup.remove(); }
                }
                return { success: true, out };
            `)}
    `;
}

/**
 * UXP: Kandidaten auf Ebenen schreiben (gleichnamige Ebene ersetzen),
 * Quell-Ebenen ausblenden, danach im selben Skript nachmessen.
 */
export function applyCode(specs, layerNames, hyphProps, { showFirstOnly = true } = {}) {
    const ids = [...new Set(specs.flatMap(s => [...s.texts.map(t => t.id), ...s.images.map(i => i.id)]))];
    return `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            ${TEXT_HELPERS}
            ${MEASURE_SNIPPET}
            ${BY_ID_SNIPPET(ids)}
            const __specs = ${JSON.stringify(specs)};
            const __names = ${JSON.stringify(layerNames)};
            const __hyph = ${JSON.stringify(hyphProps)};
            const results = [];
            const srcLayers = new Map();
            const relock = [];
            const unlock = l => { if (l.locked) { l.locked = false; relock.push(l); } };
            ${withMillimetersUnitsSnippet(`
                try {
                    for (let i = 0; i < __specs.length; i++) {
                        const spec = __specs[i], name = __names[i];
                        const res = { layer: name, texts: [], images: [] };
                        results.push(res);
                        try {
                            const old = doc.layers.itemByName(name);
                            if (old.isValid) { old.locked = false; old.remove(); res.replaced = true; }
                            const L = doc.layers.add({ name });
                            for (const t of spec.texts) {
                                const src = __byId.get(t.id);
                                if (!src) { res.texts.push({ sourceId: t.id, error: 'source not found' }); continue; }
                                srcLayers.set(src.itemLayer.id, src.itemLayer);
                                unlock(src.itemLayer);
                                const d = src.duplicate();
                                try {
                                    d.itemLayer = L;
                                    __prepare(d);
                                    const ref = d.characters.item(0).pointSize;
                                    if (t.pointSize && Math.abs(t.pointSize / ref - 1) > 1e-4) __scale(d, t.pointSize / ref);
                                    if (t.leading && !t.leadingAuto) d.texts.item(0).leading = t.leading;
                                    if (t.hyphenation) __variant(d, __hyph[t.hyphenation] || {});
                                    if (t.noBreak) d.texts.item(0).noBreak = true;
                                    d.geometricBounds = t.frame;
                                    if (t.shape) d.paths.item(0).entirePath = t.shape;
                                    // Höhe auf Inhalt: Rundung kann die letzte Zeile in den Übersatz schieben
                                    let grown = 0;
                                    if (!t.shape) {
                                        for (let k = 0; k < 12 && d.overflows; k++) {
                                            const b = d.geometricBounds;
                                            d.geometricBounds = [b[0], b[1], b[2] + 0.25, b[3]];
                                            grown += 0.25;
                                        }
                                    }
                                    const ov = __oversetInfo(d).oversetCharacters;
                                    const lines = d.lines.length && !ov ? __readLines(d).map(l => [l.contents, l.baseline]) : [];
                                    res.texts.push({ sourceId: t.id, id: d.id, overset: ov, grown, lines, bounds: d.geometricBounds.map(__r) });
                                } catch (e) { res.texts.push({ sourceId: t.id, id: d.id, error: String(e.message || e) }); }
                            }
                            for (const im of spec.images) {
                                const src = __byId.get(im.id);
                                if (!src) { res.images.push({ sourceId: im.id, error: 'source not found' }); continue; }
                                srcLayers.set(src.itemLayer.id, src.itemLayer);
                                unlock(src.itemLayer);
                                const d = src.duplicate();
                                try {
                                    d.itemLayer = L;
                                    d.geometricBounds = im.frame;
                                    const g = d.allGraphics.length ? d.allGraphics[0] : null;
                                    if (!g) throw new Error('frame contains no graphic');
                                    g.geometricBounds = im.imageBounds;
                                    // Bild mit (weißem) Hintergrund hinter die Texte, Text darf in freie Bildflächen ragen
                                    d.sendToBack();
                                    let eppi = null;
                                    try { eppi = g.effectivePpi; } catch (e) {}
                                    res.images.push({ sourceId: im.id, id: d.id, effPpi: eppi, frame: d.geometricBounds.map(__r), imageBounds: g.geometricBounds.map(__r) });
                                } catch (e) { res.images.push({ sourceId: im.id, id: d.id, error: String(e.message || e) }); }
                            }
                            L.visible = ${showFirstOnly ? 'i === 0' : 'true'};
                        } catch (e) { res.error = String(e.message || e); }
                    }
                } finally { relock.forEach(l => { try { l.locked = true; } catch (e) {} }); }
                const hidden = [];
                for (const l of srcLayers.values()) if (__names.indexOf(l.name) < 0 && l.visible) { l.visible = false; hidden.push(l.name); }
                return { success: true, results, hiddenLayers: hidden };
            `)}
    `;
}

/** UXP: jede Ebene einzeln als PNG (RGB) exportieren, Sichtbarkeit und Export-Voreinstellungen danach wiederherstellen. */
export function previewCode(layerNames, files, pageIndex, dpi) {
    return `
            const { ExportFormat, ExportRangeOrAllPages, PNGColorSpaceEnum, PNGQualityEnum } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const names = ${JSON.stringify(layerNames)};
            const files = ${JSON.stringify(files.map(f => f.replace(/\\/g, '/')))};
            const prefs = app.pngExportPreferences;
            const wanted = {
                pngExportRange: ExportRangeOrAllPages.EXPORT_RANGE, pageString: '+${pageIndex + 1}', exportingSpread: false,
                exportResolution: ${dpi}, pngColorSpace: PNGColorSpaceEnum.RGB, pngQuality: PNGQualityEnum.HIGH,
                transparentBackground: false, antiAlias: true, useDocumentBleeds: false, simulateOverprint: false,
            };
            const saved = {};
            for (const k of Object.keys(wanted)) { try { saved[k] = prefs[k]; } catch (e) {} }
            const vis = doc.layers.everyItem().getElements().map(l => [l, l.visible]);
            const done = [];
            try {
                for (const k of Object.keys(wanted)) prefs[k] = wanted[k];
                for (let i = 0; i < names.length; i++) {
                    const layer = doc.layers.itemByName(names[i]);
                    if (!layer.isValid) { done.push({ layer: names[i], error: 'layer not found' }); continue; }
                    for (const [l] of vis) l.visible = l.id === layer.id;
                    await doc.exportFile(ExportFormat.PNG_FORMAT, files[i], false);
                    done.push({ layer: names[i], file: files[i] });
                }
            } finally {
                for (const [l, v] of vis) { try { l.visible = v; } catch (e) {} }
                for (const k of Object.keys(saved)) { try { prefs[k] = saved[k]; } catch (e) {} }
            }
            return { success: true, done };
    `;
}

const escXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** Kontaktbogen: Kacheln nebeneinander, darunter Beschriftung (Ebene, Topologie, Score). */
export async function contactSheet(tiles, outFile) {
    const sharp = (await import('sharp')).default;
    const metas = await Promise.all(tiles.map(t => sharp(t.file).metadata()));
    const pad = 16, label = 44;
    const tw = Math.max(...metas.map(m => m.width)), th = Math.max(...metas.map(m => m.height));
    const W = pad + tiles.length * (tw + pad), H = pad + th + label + pad;
    const comps = [];
    tiles.forEach((t, i) => {
        const x = pad + i * (tw + pad);
        comps.push({ input: t.file, left: x, top: pad });
        const svg = `<svg width="${tw}" height="${label}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${tw}" height="1" fill="#999"/>
            <text x="0" y="18" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#222">${escXml(t.title)}</text>
            <text x="0" y="36" font-family="Arial, sans-serif" font-size="12" fill="#555">${escXml(t.subtitle)}</text></svg>`;
        comps.push({ input: Buffer.from(svg), left: x, top: pad + th + 4 });
    });
    await sharp({ create: { width: W, height: H, channels: 3, background: '#e8e8e8' } }).composite(comps).png().toFile(outFile);
    return outFile;
}

const inkCache = new Map();
/** Mittlere Tinte der Motivpixel 0..1 (wie score_layout). */
async function motifInk(file, whiteThreshold = 250) {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (inkCache.has(key)) return inkCache.get(key);
    const img = await loadGray(file, 256);
    let s = 0, n = 0;
    for (let i = 0; i < img.gray.length; i++) if (img.gray[i] < whiteThreshold) { s += 255 - img.gray[i]; n++; }
    const ink = n ? s / n / 255 : 0;
    inkCache.set(key, ink);
    return ink;
}

/** Trennvarianten-Eigenschaften je Name für UXP. */
function hyphPropsOf(config) {
    return { asIs: {}, ...config.hyphenation.variants };
}

/** Quell-Ebene: Parameter oder die nicht ausgeschlossene Ebene mit den meisten Objekten. */
function pickSourceLayer(res, config, explicit, prefix) {
    if (explicit) return explicit;
    const ex = config.sourceLayers?.exclude ? new RegExp(config.sourceLayers.exclude, 'iu') : null;
    const counts = new Map();
    for (const it of res.items) {
        const l = it.props.layer;
        if ((ex && ex.test(l)) || (prefix && l.startsWith(prefix)) || it.parent) continue;
        counts.set(l, (counts.get(l) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function compactResult(spec, layer, applied) {
    const t = Object.fromEntries(spec.texts.map(x => [x.role, x]));
    const im = spec.images[0];
    return {
        layer, topology: spec.topology, score: spec.score, breakdown: spec.breakdown,
        params: {
            ...spec.params,
            headline: t.headline ? { pt: t.headline.pointSize, leading: t.headline.leading, width: round(t.headline.frame[3] - t.headline.frame[1]), lines: t.headline.predicted.lines.length } : undefined,
            description: t.description ? { width: round(t.description.frame[3] - t.description.frame[1]), hyphenation: t.description.hyphenation, lines: t.description.predicted.lines.length, polygon: !!t.description.shape || undefined } : undefined,
            image: im ? { frame: im.frame, widthMm: im.widthMm, effPpi: im.effPpi?.[0] } : undefined,
        },
        ...(applied ? { deviations: applied } : {}),
    };
}

/** Kandidaten anwenden und Abweichungen bestimmen (ein Roundtrip). */
async function applySpecs(specs, layerNames, config) {
    const res = await ScriptExecutor.executeViaUXP(applyCode(specs, layerNames, hyphPropsOf(config)));
    if (!res?.success) throw new Error(res?.error || 'Failed to apply candidates');
    const deviations = res.results.map((r, i) => {
        if (r.error) return [`layer error: ${r.error}`];
        const dev = compareApplied(specs[i], { texts: r.texts, images: r.images });
        for (const t of r.texts) if (t.grown) dev.push(`text ${t.sourceId}: frame grown by ${t.grown} mm to avoid overset`);
        return dev;
    });
    return { res, deviations };
}

export class LayoutSolverHandlers {
    /** Kompletter Lauf: messen, erzeugen, bewerten, auswählen, anwenden, Vorschau. */
    static async artworkSolve(args = {}) {
        const op = 'Artwork Solve';
        const t0 = Date.now();
        const pageIndex = args.pageIndex ?? 0;
        const count = args.count ?? 3;
        const apply = args.apply !== false, preview = args.preview !== false && apply;
        const prefix = typeof args.layerPrefix === 'string' && args.layerPrefix.trim() ? args.layerPrefix : 'Layoutvorschlag';
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return formatErrorResponse('pageIndex must be an integer >= 0', op);
        if (!Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES) return formatErrorResponse(`count must be an integer 1..${MAX_CANDIDATES}`, op);
        let roundtrips = 0;
        const timing = {};
        const warnings = [];
        try {
            // 1. Modell
            const res = await ScriptExecutor.executeViaUXP(layoutModelCode(pageIndex));
            roundtrips++;
            if (!res?.success) return formatErrorResponse(res?.error || 'Failed to read layout model', op);
            if (!res.docPath) return formatErrorResponse('Document is not saved; save it first (the solver never saves)', op);
            const cfg = loadConfig({ configPath: args.configPath, docPath: res.docPath });
            const config = cfg.config;
            const sc = solverConfig(config, args.seed != null ? { seed: args.seed } : {});
            const sourceLayer = pickSourceLayer(res, config, args.sourceLayer, prefix);
            if (!sourceLayer) return formatErrorResponse('No source layer found', op);
            const model = await buildModel(res, cfg, { layer: sourceLayer });
            timing.model = Date.now() - t0;

            // 2. Bilddaten (Node, Sidecar-Cache)
            const imgItem = model.items.filter(i => i.image && i.role === 'image').sort((a, b) => (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) - (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]))[0];
            let imageData = null;
            if (imgItem?.image?.path && fs.existsSync(imgItem.image.path)) {
                const file = imgItem.image.path;
                imageData = { mask: null, feat: null, ink: null };
                try { imageData.mask = await getMotifMask(file, { grid: scoringConfig(config).maskGrid }); } catch (e) { warnings.push(`mask: ${e.message}`); }
                try { imageData.feat = await getImageFeatures(file); } catch (e) { warnings.push(`features: ${e.message}`); }
                try { imageData.ink = await motifInk(file); } catch { /* Default aus Config */ }
                if (Math.abs(imgItem.rot || 0) > 0.01 || Math.abs(imgItem.image.rot || 0) > 0.01) warnings.push('image is rotated; solver assumes 0°');
            } else if (imgItem) warnings.push('image link missing; image treated as fixed');

            // 3. Messpakete
            const t1 = Date.now();
            const plan = measurePlan(config, sc, { layer: sourceLayer });
            const jobs = planMeasureJobs(model, plan);
            const batches = batchJobs(jobs, plan.maxProbes);
            const parts = [];
            for (const b of batches) {
                const r = await ScriptExecutor.executeViaUXP(measureBatchCode(b));
                roundtrips++;
                if (!r?.success) return formatErrorResponse(r?.error || 'Measurement failed', op);
                parts.push({ frames: r.frames.map(f => ({ ...f, role: model.items.find(i => i.id === f.id)?.role })) });
            }
            const meas = mergeMeasurements(parts);
            for (const f of meas.frames) if (f.error) warnings.push(`measure ${f.id}: ${f.error}`);
            timing.measure = Date.now() - t1;

            // Rohdaten für Offline-Analyse des Generators
            if (args.dumpPath) fs.writeFileSync(args.dumpPath, JSON.stringify({ model, meas, configFile: cfg.file, imagePath: imgItem?.image?.path || null }));

            // 4. Erzeugen + Bewerten
            const t2 = Date.now();
            const P = buildProblem(model, meas, imageData, config, sc);
            const out = solve(P, sc);
            timing.solve = Date.now() - t2;

            // 5. Polygone für Fast-Kandidaten (ein Roundtrip)
            let polyStats = null;
            if (sc.polygon.enabled && out.near.length) {
                const t3 = Date.now();
                const pj = polygonJobs(out.near, P, sc);
                if (pj.length) {
                    const r = await ScriptExecutor.executeViaUXP(polygonBatchCode(pj, hyphPropsOf(config)));
                    roundtrips++;
                    let ok = 0;
                    const rejected = {};
                    const rej = k => { rejected[k] = (rejected[k] || 0) + 1; };
                    if (r?.success) {
                        const H8 = scoringConfig(config).rules.H8;
                        for (const o of r.out) {
                            const job = pj.find(j => j.id === o.id);
                            if (o.error) { rej('error'); continue; }
                            if (o.overset || !o.lines.length) { rej('overset'); continue; }
                            const c = applyPolygonResult(job.cand, job.elId, job, o);
                            const bad = prefilter(c, P, { minGap: H8?.minGap ?? 1 });
                            if (Object.keys(bad).length) { rej(`prefilter:${[...new Set(Object.values(bad).flat().map(x => x.split(':')[0]))].join('+')}`); continue; }
                            evaluate(c, P);
                            if (c.valid) { out.valid.push(c); ok++; } else rej(`rules:${[...new Set(c.violations.map(v => v.rule))].join('+')}`);
                        }
                    } else warnings.push(`polygon measurement failed: ${r?.error}`);
                    polyStats = { measured: pj.length, valid: ok, rejected, ms: Date.now() - t3 };
                }
            }
            if (!out.valid.length) {
                return formatErrorResponse(`No valid layout found (${out.stats.generated} generated, ${out.stats.prefiltered} passed prefilter, ${out.stats.scored} scored). Relax config.solver (splits, topologies, measure.minWidth) or check roles.`, op);
            }
            const chosen = selectDiverse(out.valid, count, sc.diversity.minDistance);
            const specs = chosen.map((c, i) => toSpec(c, P, `c${i + 1}`));
            const layerNames = specs.map((_, i) => `${prefix}${i + 1}`);
            lastRun = { docPath: res.docPath, configFile: cfg.file, sourceLayer, pageIndex };

            // 6. Anwenden + Nachmessen
            let deviations = specs.map(() => null), hiddenLayers = [];
            if (apply) {
                const t4 = Date.now();
                const a = await applySpecs(specs, layerNames, config);
                roundtrips++;
                deviations = a.deviations;
                hiddenLayers = a.res.hiddenLayers;
                timing.apply = Date.now() - t4;
            }

            // 7. Vorschau
            let contact = null;
            if (preview) {
                const t5 = Date.now();
                const dir = args.previewDir ? path.resolve(args.previewDir) : path.join(os.tmpdir(), 'artwork-solver');
                fs.mkdirSync(dir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const base = path.basename(res.docPath, path.extname(res.docPath));
                const files = layerNames.map(n => path.join(dir, `${base}-${n}-${stamp}.png`));
                const r = await ScriptExecutor.executeViaUXP(previewCode(layerNames, files, pageIndex, args.previewDpi ?? 96));
                roundtrips++;
                if (r?.success) {
                    const tiles = r.done.filter(d => !d.error && fs.existsSync(d.file)).map(d => {
                        const i = layerNames.indexOf(d.layer);
                        return { file: d.file, title: `${d.layer}  ·  ${specs[i].score}`, subtitle: `${specs[i].topology}${specs[i].params.bleed?.length ? ` bleed ${specs[i].params.bleed.join('+')}` : ''} · ${specs[i].params.anchor} · price ${specs[i].params.price}` };
                    });
                    if (tiles.length) contact = await contactSheet(tiles, path.join(dir, `${base}-contact-${stamp}.png`));
                    for (const t of tiles) { try { fs.unlinkSync(t.file); } catch { /* egal */ } }
                } else warnings.push(`preview failed: ${r?.error}`);
                timing.preview = Date.now() - t5;
            }

            const byTopo = {};
            for (const c of out.valid) byTopo[c.setup.topo] = (byTopo[c.setup.topo] || 0) + 1;
            return formatResponse({
                document: res.docName, config: cfg.file || cfg.source, sourceLayer,
                units: 'mm, pt; score 0..1; breakdown S1..S10 (see score_layout)',
                proposals: specs.map((s, i) => compactResult(s, apply ? layerNames[i] : null, deviations[i])),
                contactSheet: contact,
                ...(hiddenLayers.length ? { hiddenLayers } : {}),
                stats: {
                    ...out.stats, validByTopology: byTopo, polygon: polyStats,
                    probes: jobs.reduce((n, j) => n + j.widths.length, 0), measureBatches: batches.length,
                    roundtrips, ms: Date.now() - t0, timing,
                },
                candidates: args.returnCandidates ? specs : undefined,
                ...(warnings.length ? { warnings } : {}),
            }, op);
        } catch (e) {
            return formatErrorResponse(e.message, op);
        }
    }

    /** Serialisierte Kandidaten (artwork_solve returnCandidates) auf Ebenen anwenden. */
    static async artworkApply(args = {}) {
        const op = 'Artwork Apply';
        let specs, names, cfg;
        try {
            if (!Array.isArray(args.candidates) || !args.candidates.length) throw new Error('candidates must be a non-empty array');
            if (args.candidates.length > MAX_CANDIDATES) throw new Error(`max ${MAX_CANDIDATES} candidates`);
            specs = args.candidates.map((c, i) => validateSpec({ texts: [], images: [], ...c }, i));
            names = args.layerNames;
            if (!Array.isArray(names) || names.length !== specs.length || !names.every(n => typeof n === 'string' && n.trim())) throw new Error('layerNames must be an array of layer names, one per candidate');
            cfg = loadConfig({ configPath: args.configPath, docPath: lastRun?.docPath });
        } catch (e) { return formatErrorResponse(e.message, op); }
        try {
            const specsN = specs.map(s => ({ ...s, texts: s.texts.map(t => ({ ...t, predicted: t.predicted || { lines: [] } })) }));
            const { res, deviations } = await applySpecs(specsN, names, cfg.config);
            return formatResponse({
                layers: names,
                deviations: Object.fromEntries(names.map((n, i) => [n, deviations[i]])),
                hiddenLayers: res.hiddenLayers,
                applied: res.results.map(r => ({ layer: r.layer, texts: r.texts.map(t => ({ sourceId: t.sourceId, id: t.id, bounds: t.bounds, lines: t.lines?.length, overset: t.overset, error: t.error })), images: r.images })),
            }, op);
        } catch (e) { return formatErrorResponse(e.message, op); }
    }
}
