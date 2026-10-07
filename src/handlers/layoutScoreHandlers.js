/**
 * Layout-Bewertung bestehender Ebenen: liest alle Ebenen einer Seite in einem
 * Bridge-Roundtrip (Zeilen per everyItem, ohne temporäre Objekte, Dokument
 * unverändert), baut je Ebene eine Szene und bewertet sie mit
 * src/utils/layoutScore.js. Bildmaske/-merkmale aus dem Sidecar-Cache bzw.
 * per Node berechnet.
 */
import fs from 'fs';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { TEXT_HELPERS } from '../utils/textSnippets.js';
import { loadConfig, matchRole, buildFormat } from '../utils/layoutModel.js';
import { getMotifMask, loadGray } from '../utils/imageMask.js';
import { getImageFeatures } from '../utils/imageFeatures.js';
import { scoreLayout, scoringConfig, colorInk, placeImageData } from '../utils/layoutScore.js';
import { ROLE_PROPS_SNIPPET } from './layoutModelHandlers.js';

const MAX_LAYERS = 12;
const inkCache = new Map();

/** Mittlere Tinte (1 − Luminanz) der Motivpixel eines Bildes, 0..1. */
async function motifInk(file, whiteThreshold = 250) {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}|${whiteThreshold}`;
    if (inkCache.has(key)) return inkCache.get(key);
    const img = await loadGray(file, 256);
    let s = 0, n = 0;
    for (let i = 0; i < img.gray.length; i++) {
        const g = img.gray[i];
        if (g < whiteThreshold) { s += 255 - g; n++; }
    }
    const ink = n ? s / n / 255 : 0;
    inkCache.set(key, ink);
    return ink;
}

/** Bilddaten je Linkdatei einmal laden (Maske, Merkmale, Tinte); Fehler → null + Warnung. */
async function imageAssets(file, grid, warnings) {
    const out = { mask: null, feat: null, ink: null };
    if (!file || !fs.existsSync(file)) { warnings.push(`Linked file not found: ${file}`); return out; }
    try { out.mask = await getMotifMask(file, { grid }); } catch (e) { warnings.push(`Mask failed for ${file}: ${e.message}`); }
    try { out.feat = await getImageFeatures(file); } catch (e) { warnings.push(`Features failed for ${file}: ${e.message}`); }
    try { out.ink = await motifInk(file); } catch { /* Default aus Config */ }
    return out;
}

/** UXP-Skript: Format, Ebenen und alle Objekte der Seite (Text: Zeilen, Stil, Übersatz; Grafik: Bildbounds, ppi, Link). */
export const READ_CODE = (pageIndex) => `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const { ScriptLanguage } = require('indesign');
            if (${pageIndex} >= doc.pages.length) return { success: false, error: 'pageIndex ${pageIndex} out of range (pages: ' + doc.pages.length + ')' };
            const page = doc.pages.item(${pageIndex});
            ${TEXT_HELPERS}
            ${ROLE_PROPS_SNIPPET}
            let docPath = null;
            if (doc.saved) { try { docPath = app.doScript('app.activeDocument.fullName.fsName', ScriptLanguage.JAVASCRIPT); } catch (e) {} }
            function __color(c) {
                if (!c) return null;
                const type = c.constructor.name;
                let name = null;
                try { name = c.name; } catch (e) {}
                if (!name || /^(None|Ohne|\\[Ohne\\])$/i.test(name)) return null;
                if (/^(Paper|Papier|\\[Papier\\])$/i.test(name)) return { name, space: 'RGB', values: [255, 255, 255] };
                try {
                    if (type === 'Color') return { name, space: String(c.space), values: c.colorValue };
                    if (type === 'Tint') return { name, space: String(c.baseColor.space), values: c.baseColor.colorValue, tint: c.tintValue };
                } catch (e) {}
                return { name };
            }
            const items = [];
            function walk(it) {
                const { p, g } = __roleProps(it);
                if (p.kind === 'group') { for (const ch of it.pageItems.everyItem().getElements()) walk(ch); return; }
                const rec = { id: it.id, props: p, gb: it.geometricBounds.map(__r) };
                if (p.kind === 'text') {
                    rec.lines = __readLines(it).map(l => [l.contents, __r(l.top), __r(l.bottom), l.baseline, l.x, l.width, l.hyphenated ? 1 : 0, l.paragraphEnd ? 1 : 0]);
                    rec.overset = __oversetInfo(it).oversetCharacters;
                    const ranges = it.texts.item(0).textStyleRanges;
                    if (ranges.length) {
                        const t = ranges.item(0);
                        const f = t.appliedFont, ld = t.leading;
                        rec.style = {
                            size: __r(t.pointSize),
                            leading: __r(typeof ld === 'number' ? ld : t.pointSize * t.autoLeading / 100),
                            font: typeof f === 'string' ? f : f.fontFamily,
                            fontStyle: t.fontStyle,
                            color: __color(t.fillColor),
                            tint: t.fillTint,
                        };
                    }
                }
                if (g) {
                    const img = { gb: g.geometricBounds.map(__r) };
                    try { const l = g.itemLink; if (l) { img.path = l.filePath; img.status = String(l.status); } } catch (e) {}
                    try { img.eppi = g.effectivePpi; } catch (e) {}
                    try { img.rot = __r(g.absoluteRotationAngle); img.shear = __r(g.absoluteShearAngle); img.flip = String(g.absoluteFlip); } catch (e) {}
                    rec.img = img;
                }
                items.push(rec);
            }
            ${withMillimetersUnitsSnippet(`
                const mp = page.marginPreferences;
                const dp = doc.documentPreferences;
                const fmt = {
                    index: ${pageIndex}, name: page.name, bounds: page.bounds.map(__r), side: String(page.side),
                    margins: [mp.top, mp.left, mp.bottom, mp.right].map(__r), cols: mp.columnCount, gutter: __r(mp.columnGutter),
                    docBleed: [dp.documentBleedTopOffset, dp.documentBleedInsideOrLeftOffset, dp.documentBleedBottomOffset, dp.documentBleedOutsideOrRightOffset].map(__r),
                    facing: dp.facingPages,
                };
                for (const it of page.pageItems.everyItem().getElements()) walk(it);
                const layers = doc.layers.everyItem().getElements().map(l => [l.name, l.visible]);
                return { success: true, docName: doc.name, docPath, fmt, layers, items };
            `)}
`;

const styleOf = (s) => {
    if (!s) return {};
    const c = s.color ? { ...s.color, tint: s.tint } : null;
    const { ink, accent } = colorInk(c);
    return { size: s.size, leading: s.leading, font: s.font, fontStyle: s.fontStyle, color: s.color?.name ?? null, ink, accent };
};

const toLine = l => ({ text: l[0], top: l[1], bottom: l[2], baseline: l[3], x: l[4], width: l[5], hyphenated: !!l[6], paragraphEnd: !!l[7] });

/**
 * Szenen aller Ebenen aus der UXP-Rohantwort (Node-seitig). Exportiert für
 * Kalibrier-Skripte, die die Rohdaten selbst lesen.
 */
export async function buildScenes(res, cfg, layers, { warnings = [] } = {}) {
    const { config } = cfg;
    const sc = scoringConfig(config);
    const fmt = buildFormat(res.fmt, config);
    const pb = res.fmt.bounds;
    const exclude = config.sourceLayers?.exclude ? new RegExp(config.sourceLayers.exclude, 'iu') : null;
    const source = sc.sourceLayer || (res.layers.find(([n]) => !(exclude && exclude.test(n))) || [])[0] || null;
    if (sc.sourceLayer && !res.layers.some(([n]) => n === sc.sourceLayer)) warnings.push(`scoring.sourceLayer '${sc.sourceLayer}' not found; H4 skipped`);

    const items = res.items.map(it => ({ ...it, role: matchRole(it.props, config.match).role }));
    const originals = {};
    for (const it of items) if (it.props.layer === source && it.props.kind === 'text' && it.style && !originals[it.role]) originals[it.role] = styleOf(it.style);

    const assets = new Map();
    const scenes = {};
    for (const layer of layers) {
        const elements = [], images = [];
        for (const it of items.filter(i => i.props.layer === layer)) {
            if (it.props.kind === 'text') {
                elements.push({
                    id: it.id, role: it.role, frame: it.gb, overset: it.overset || 0,
                    lines: (it.lines || []).map(toLine), style: styleOf(it.style), original: originals[it.role] || null,
                });
            }
            if (it.img) {
                const im = it.img;
                if (Math.abs(im.rot || 0) > 0.01 || Math.abs(im.shear || 0) > 0.01) warnings.push(`${layer}: image ${it.id} rotated/sheared; motif positions approximate`);
                if (!assets.has(im.path)) assets.set(im.path, await imageAssets(im.path, sc.maskGrid, warnings));
                const a = assets.get(im.path);
                const placed = placeImageData(a.mask, a.feat, { imageBounds: im.gb, frameBounds: it.gb, pageBounds: pb, flip: im.flip });
                images.push({
                    id: it.id, role: it.role === 'unknown' ? 'image' : it.role, frame: it.gb, imageBounds: im.gb,
                    effPpi: Array.isArray(im.eppi) ? im.eppi : null, ...placed, ...(a.ink !== null ? { ink: a.ink } : {}),
                });
            }
        }
        scenes[layer] = { format: fmt, config, elements, images };
    }
    return { scenes, source, format: fmt };
}

const round2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 + 0 : v);

export class LayoutScoreHandlers {
    /** Bewertet Ebenen einer Seite: harte Regeln + gewichteter Score. */
    static async scoreLayout(args = {}) {
        const op = 'Score Layout';
        const pageIndex = args.pageIndex ?? 0;
        const layers = args.layers;
        if (!Array.isArray(layers) || !layers.length || !layers.every(l => typeof l === 'string' && l.trim())) return formatErrorResponse('layers must be a non-empty array of layer names', op);
        if (layers.length > MAX_LAYERS) return formatErrorResponse(`max ${MAX_LAYERS} layers per call`, op);
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return formatErrorResponse('pageIndex must be an integer >= 0', op);

        let res;
        try { res = await ScriptExecutor.executeViaUXP(READ_CODE(pageIndex)); }
        catch (e) { return formatErrorResponse(e.message, op); }
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to read layers', op);
        const missing = layers.filter(l => !res.layers.some(([n]) => n === l));
        if (missing.length) return formatErrorResponse(`Layer(s) not found: ${missing.join(', ')} (available: ${res.layers.map(l => l[0]).join(', ')})`, op);

        let cfg;
        try { cfg = loadConfig({ configPath: args.configPath, docPath: res.docPath }); scoringConfig(cfg.config); }
        catch (e) { return formatErrorResponse(e.message, op); }

        const warnings = [];
        try {
            const { scenes, source } = await buildScenes(res, cfg, layers, { warnings });
            const sc = scoringConfig(cfg.config);
            const results = layers.map(layer => {
                const r = scoreLayout(scenes[layer], { detail: !!args.detail });
                const out = {
                    layer,
                    valid: r.valid,
                    score: round2(r.score),
                    breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, b]) => [k, round2(b.v)])),
                    notes: Object.fromEntries(Object.entries(r.breakdown).filter(([, b]) => b.note).map(([k, b]) => [k, b.note])),
                };
                if (r.violations.length) out.violations = r.violations.map(v => `${v.rule} [${v.ids.join(',')}] ${v.detail}`);
                if (r.skipped.length) out.skipped = r.skipped.map(s => `${s.rule} [${s.ids.join(',')}] ${s.reason}`);
                if (r.detail) out.detail = r.detail;
                return out;
            });
            return formatResponse({
                document: res.docName,
                config: cfg.file || cfg.source,
                sourceLayer: source,
                units: 'mm, pt; scores 0..1 (1 = good); score = Σ w·S / Σ w over non-null criteria',
                weights: sc.weights,
                results,
                ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
            }, op);
        } catch (e) {
            return formatErrorResponse(e.message, op);
        }
    }
}

