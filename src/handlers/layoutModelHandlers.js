/**
 * Layout-Modell: Analyse einer Anzeigen-Seite für einen späteren Solver in
 * Node. Jedes Tool kommt mit genau einem Bridge-Roundtrip aus; temporäre
 * Objekte werden im selben Skript wieder entfernt.
 *
 * Längen in mm (Lineal-Koordinaten wie alle Tools), Schriftgrade in pt.
 */
import fs from 'fs';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { parseItemId } from '../utils/itemUtils.js';
import { TEXT_HELPERS, resolveTextFrameSnippet } from '../utils/textSnippets.js';
import {
    loadConfig, matchRole, planPointSizes, buildFormat, edgeSides, reachesBleed,
    shapeFromPaths, normalizePolygon, polygonBounds, summarizeLines, lineRows,
    tableRow, relativeLines, TABLE_COLS, parseWidths, resolveHyphenation, r2,
} from '../utils/layoutModel.js';

const MAX_TABLE_ROWS = 240;
const MAX_SHAPES = 40;
const MEASURE_HEIGHT = 1000; // mm, Höhe der Messrahmen in der Breiten-Tabelle

// Dokumentpfad des letzten get_layout_model → Konfiguration für die Mess-Tools ohne Extra-Roundtrip
let lastDocPath = null;

/** Eigenschaften für die Rollen-Zuordnung (identisch in Modell und Mess-Tools). */
const ROLE_PROPS_SNIPPET = `
            function __roleProps(it) {
                const type = it.constructor.name;
                let g = null;
                if (type !== 'TextFrame' && type !== 'Group') {
                    try { const a = it.allGraphics; if (a && a.length) g = a[0]; } catch (e) {}
                }
                const kind = type === 'TextFrame' ? 'text' : type === 'Group' ? 'group' : g ? 'graphic' : type === 'GraphicLine' ? 'line' : 'shape';
                const p = { kind, type, name: '', label: '', layer: '', objectStyle: '' };
                try { p.name = it.name || ''; } catch (e) {}
                try { p.label = it.label || ''; } catch (e) {}
                try { p.layer = it.itemLayer.name; } catch (e) {}
                try { p.objectStyle = it.appliedObjectStyle ? it.appliedObjectStyle.name : ''; } catch (e) {}
                if (kind === 'text') {
                    p.content = String(it.texts.item(0).contents);
                    p.paragraphStyle = it.paragraphs.length ? it.paragraphs.item(0).appliedParagraphStyle.name : '';
                    p.characterStyle = it.characters.length ? it.characters.item(0).appliedCharacterStyle.name : '';
                }
                if (g) { try { p.link = g.itemLink ? g.itemLink.name : ''; } catch (e) {} }
                return { p, g };
            }
`;

/** Messrahmen vorbereiten, skalieren, Trennvariante anwenden; Zeilen kompakt lesen. */
const MEASURE_SNIPPET = `
            const { AutoSizingTypeEnum: __AS, VerticalJustification: __VJ, TextWrapModes: __TW } = require('indesign');
            function __prepare(f) {
                const t = f.textFramePreferences;
                try { t.autoSizingType = __AS.OFF; } catch (e) {}
                try { t.ignoreWrap = true; } catch (e) {}
                try { t.verticalJustification = __VJ.TOP_ALIGN; } catch (e) {}
                try { t.useFixedColumnWidth = false; } catch (e) {}
                try { f.textWrapPreferences.textWrapMode = __TW.NONE; } catch (e) {}
                while (f.paths.length > 1) f.paths.item(f.paths.length - 1).remove();
            }
            // Gemischte Schriftgrade proportional skalieren, Zeilenabstand mit
            function __scale(f, s) {
                if (Math.abs(s - 1) < 1e-6) return;
                const ranges = f.parentStory.textStyleRanges.everyItem().getElements();
                for (const rg of ranges) {
                    const ld = rg.leading;
                    rg.pointSize = rg.pointSize * s;
                    if (typeof ld === 'number') rg.leading = ld * s;
                }
            }
            function __variant(f, props) {
                const t = f.texts.item(0);
                for (const k of Object.keys(props)) t[k] = props[k];
            }
            const __lineArr = l => [l.contents, l.baseline, l.ascent, l.descent, l.x, l.width, l.paragraphEnd ? 1 : 0, l.hyphenated ? 1 : 0];
            function __frameErr(f) {
                if (Math.abs(f.rotationAngle) > 0.001 || Math.abs(f.shearAngle) > 0.001) return 'Rotated or sheared frames are not supported';
                if (!f.characters.length) return 'Frame contains no text';
                return null;
            }
`;

function configForTools(configPath) {
    return loadConfig({ configPath, docPath: lastDocPath });
}

async function pixelSize(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        const sharp = (await import('sharp')).default;
        const m = await sharp(filePath).metadata();
        if (!m.width || !m.height) return null;
        return m.orientation >= 5 ? [m.height, m.width] : [m.width, m.height];
    } catch { return null; }
}

/** Pixelmaße aus effektiver Auflösung, falls die Datei nicht lesbar ist (nur 0/90/180/270°). */
function estimatePixels(img) {
    if (!Array.isArray(img.eppi)) return null;
    const ib = img.gb;
    const w = ib[3] - ib[1], h = ib[2] - ib[0];
    const rot = ((Math.round(img.rot || 0) % 360) + 360) % 360;
    if (rot % 90 !== 0) return null;
    const [dw, dh] = rot % 180 === 0 ? [w, h] : [h, w];
    return [Math.round(img.eppi[0] * dw / 25.4), Math.round(img.eppi[1] * dh / 25.4)];
}

const nonDefault = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false));

export class LayoutModelHandlers {
    /**
     * Kompaktes Layout-Modell einer Seite: Format, aufgelöste Konfiguration,
     * Items mit Rolle, Form, Stil, Zeilen-Kurzinfo und Bild-Basisdaten.
     */
    static async getLayoutModel(args = {}) {
        const op = 'Get Layout Model';
        const pageIndex = args.pageIndex ?? 0;
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return formatErrorResponse('pageIndex must be an integer >= 0', op);
        const layer = typeof args.layer === 'string' && args.layer.trim() ? args.layer : null;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const { ScriptLanguage, AutoSizingTypeEnum } = require('indesign');
            if (${pageIndex} >= doc.pages.length) return { success: false, error: 'pageIndex ${pageIndex} out of range (pages: ' + doc.pages.length + ')' };
            const page = doc.pages.item(${pageIndex});
            ${TEXT_HELPERS}
            ${ROLE_PROPS_SNIPPET}
            // fullName/filePath werfen in UXP unter Windows → ExtendScript
            let docPath = null;
            if (doc.saved) { try { docPath = app.doScript('app.activeDocument.fullName.fsName', ScriptLanguage.JAVASCRIPT); } catch (e) {} }
            const noneCs = doc.characterStyles.item(0).name;
            const colors = {};
            function __color(c) {
                if (!c) return null;
                const type = c.constructor.name;
                let name = null;
                try { name = c.name; } catch (e) {}
                if (!name || (type === 'Swatch' && /^(None|Ohne|\\[Ohne\\])$/i.test(name))) return null;
                if (!colors[name]) {
                    try {
                        if (type === 'Color') colors[name] = [String(c.space), ...c.colorValue.map(__r)];
                        else if (type === 'Tint') colors[name] = [String(c.baseColor.space), ...c.baseColor.colorValue.map(__r), 'tint', c.tintValue, c.baseColor.name];
                        else colors[name] = [type];
                    } catch (e) { colors[name] = [type]; }
                }
                return name;
            }
            function __style(t) {
                const f = t.appliedFont;
                const size = t.pointSize, ld = t.leading;
                const auto = typeof ld !== 'number';
                const cs = t.appliedCharacterStyle;
                return {
                    ps: t.appliedParagraphStyle.name,
                    cs: cs && cs.name !== noneCs ? cs.name : null,
                    font: typeof f === 'string' ? f : f.fontFamily,
                    fontStyle: t.fontStyle,
                    size: __r(size),
                    leading: __r(auto ? size * t.autoLeading / 100 : ld),
                    leadingAuto: auto,
                    tracking: t.tracking,
                    color: __color(t.fillColor),
                    tint: t.fillTint,
                    align: String(t.justification).toLowerCase(),
                    caps: String(t.capitalization).toLowerCase(),
                    spaceBefore: __r(t.spaceBefore), spaceAfter: __r(t.spaceAfter),
                    gridAlign: String(t.alignToBaseline) === 'true' ? true : false,
                    noBreak: t.noBreak,
                    hyph: [t.hyphenation, t.hyphenateWordsLongerThan, t.hyphenateAfterFirst, t.hyphenateBeforeLast, t.hyphenateLadderLimit, __r(t.hyphenationZone), t.hyphenateCapitalizedWords],
                };
            }
            const metricSrc = {};
            function __fontMetrics(frame) {
                const res = {};
                const dup = frame.duplicate();
                const outl = [];
                try {
                    try { dup.textFramePreferences.autoSizingType = AutoSizingTypeEnum.OFF; } catch (e) {}
                    try { dup.textFramePreferences.ignoreWrap = true; } catch (e) {}
                    const gb = dup.geometricBounds;
                    dup.geometricBounds = [gb[0], gb[1], gb[0] + 300, gb[1] + 300];
                    // Formatierung des ersten Zeichens bleibt beim Ersetzen erhalten
                    dup.texts.item(0).contents = 'Hxdp';
                    const line = dup.lines.item(0);
                    const base = line.baseline;
                    res.asc = __r(line.ascent); res.desc = __r(line.descent); res.src = 'line';
                    try {
                        const ext = i => {
                            let o = dup.characters.item(i).createOutlines(false);
                            o = Array.isArray(o) ? o : [o];
                            let top = Infinity, bottom = -Infinity;
                            for (const p of o) { outl.push(p); const b = p.geometricBounds; top = Math.min(top, b[0]); bottom = Math.max(bottom, b[2]); }
                            return [top, bottom];
                        };
                        res.cap = __r(base - ext(0)[0]);
                        res.x = __r(base - ext(1)[0]);
                        res.ascG = __r(base - ext(2)[0]);
                        res.descG = __r(ext(3)[1] - base);
                        res.src = 'outlines';
                    } catch (e) { res.err = String(e.message || e); }
                } catch (e) { res.err = String(e.message || e); }
                finally {
                    for (const o of outl) { try { o.remove(); } catch (e) {} }
                    dup.remove();
                }
                return res;
            }
            const items = [];
            function walk(it, parentId) {
                const { p, g } = __roleProps(it);
                const rec = { id: it.id, props: p, parent: parentId, gb: it.geometricBounds.map(__r), rot: __r(it.rotationAngle), shear: __r(it.shearAngle) };
                try { const a = []; for (let i = 0; i < it.paths.length; i++) a.push(it.paths.item(i).entirePath); rec.paths = a; } catch (e) {}
                try { rec.fill = __color(it.fillColor); } catch (e) {}
                try { const sc = it.strokeWeight > 0 ? __color(it.strokeColor) : null; if (sc) rec.stroke = [sc, __r(it.strokeWeight)]; } catch (e) {}
                try {
                    const w = it.textWrapPreferences;
                    const mode = String(w.textWrapMode);
                    if (!/^NONE$/i.test(mode)) rec.wrap = [mode.toLowerCase(), ...[].concat(w.textWrapOffset).map(__r)];
                } catch (e) {}
                if (p.kind === 'text') {
                    const tfp = it.textFramePreferences;
                    rec.frame = {
                        inset: __arr(tfp.insetSpacing).map(__r), firstBaseline: String(tfp.firstBaselineOffset).toLowerCase(),
                        minFirstBaseline: __r(tfp.minimumFirstBaselineOffset), vAlign: String(tfp.verticalJustification).toLowerCase(),
                        cols: tfp.textColumnCount, gutter: __r(tfp.textColumnGutter), autoSize: String(tfp.autoSizingType).toLowerCase(),
                        ignoreWrap: tfp.ignoreWrap, threaded: !!(it.previousTextFrame || it.nextTextFrame),
                    };
                    const ranges = it.texts.item(0).textStyleRanges;
                    const n = ranges.length;
                    if (n) {
                        rec.style = __style(ranges.item(0));
                        if (n > 1) {
                            rec.runs = [];
                            for (let i = 0; i < Math.min(n, 8); i++) {
                                const r = ranges.item(i);
                                const f = r.appliedFont;
                                const cs = r.appliedCharacterStyle;
                                rec.runs.push([String(r.contents).length, typeof f === 'string' ? f : f.fontFamily, r.fontStyle, __r(r.pointSize), cs && cs.name !== noneCs ? cs.name : null, __color(r.fillColor)]);
                            }
                        }
                        const key = rec.style.font + '|' + rec.style.fontStyle + '|' + rec.style.size;
                        rec.metricKey = key;
                        if (!metricSrc[key]) metricSrc[key] = it;
                    }
                    rec.paraStyles = [...new Set(it.paragraphs.everyItem().getElements().map(pp => pp.appliedParagraphStyle.name))];
                    rec.lines = __readLines(it).map(l => [l.contents, l.baseline, l.ascent, l.descent, l.x, l.width, l.paragraphEnd ? 1 : 0, l.hyphenated ? 1 : 0]);
                    rec.overset = __oversetInfo(it).oversetCharacters;
                }
                if (g) {
                    const img = { id: g.id, type: g.constructor.name, gb: g.geometricBounds.map(__r) };
                    try { const l = g.itemLink; if (l) { img.link = l.name; img.path = l.filePath; img.status = String(l.status).toLowerCase(); } } catch (e) {}
                    try { img.ppi = g.actualPpi; img.eppi = g.effectivePpi; } catch (e) {}
                    try { img.rot = __r(g.absoluteRotationAngle); img.shear = __r(g.absoluteShearAngle); img.flip = String(g.absoluteFlip).toLowerCase(); img.scale = [__r(g.absoluteHorizontalScale), __r(g.absoluteVerticalScale)]; } catch (e) {}
                    rec.img = img;
                }
                items.push(rec);
                if (p.kind === 'group') {
                    rec.children = [];
                    for (const ch of it.pageItems.everyItem().getElements()) { rec.children.push(ch.id); walk(ch, it.id); }
                }
            }
            ${withMillimetersUnitsSnippet(`
                const mp = page.marginPreferences;
                const dp = doc.documentPreferences;
                const gp = doc.gridPreferences;
                const fmt = {
                    index: ${pageIndex}, name: page.name, bounds: page.bounds.map(__r), side: String(page.side),
                    margins: [mp.top, mp.left, mp.bottom, mp.right].map(__r), cols: mp.columnCount, gutter: __r(mp.columnGutter),
                    docBleed: [dp.documentBleedTopOffset, dp.documentBleedInsideOrLeftOffset, dp.documentBleedBottomOffset, dp.documentBleedOutsideOrRightOffset].map(__r),
                    facing: dp.facingPages,
                    grid: { start: __r(gp.baselineStart), step: __r(gp.baselineDivision), shown: gp.baselineGridShown, relative: String(gp.baselineGridRelativeOption) },
                };
                for (const it of page.pageItems.everyItem().getElements()) walk(it, null);
                const metrics = {};
                for (const k of Object.keys(metricSrc)) metrics[k] = __fontMetrics(metricSrc[k]);
                const layers = doc.layers.everyItem().getElements().map(l => [l.name, l.visible, l.locked]);
                let fonts = [];
                try { fonts = doc.fonts.everyItem().getElements().map(f => [String(f.name).replace(/\\t/g, ' '), String(f.status)]); } catch (e) {}
                return { success: true, docName: doc.name, docPath, modified: doc.modified, fmt, layers, items, metrics, colors, fonts };
            `)}
        `;

        const res = await ScriptExecutor.executeViaUXP(code);
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to read layout model', op);

        let cfg;
        try { cfg = loadConfig({ configPath: args.configPath, docPath: res.docPath }); }
        catch (e) { return formatErrorResponse(e.message, op); }
        if (res.docPath) lastDocPath = res.docPath;
        try {
            return formatResponse(await buildModel(res, cfg, { layer }), op);
        } catch (e) {
            return formatErrorResponse(e.message, op);
        }
    }

    /**
     * Breiten-Tabelle eines Textrahmens: Breiten × Schriftgrade × Trennvarianten
     * auf temporären Duplikaten (ein Roundtrip).
     */
    static async measureTextTable(args = {}) {
        const op = 'Measure Text Table';
        let itemId, widths, cfg, variants, sizes;
        try {
            itemId = parseItemId(args.itemId);
            widths = parseWidths(args.widths);
            cfg = configForTools(args.configPath);
            variants = resolveHyphenation(args.hyphenation, cfg.config);
            sizes = args.pointSizes == null ? [] : (Array.isArray(args.pointSizes) ? args.pointSizes : [args.pointSizes]);
            if (!sizes.every(s => typeof s === 'number' && s > 0)) throw new Error('pointSizes must be positive numbers (pt)');
            const combos = widths.length * Math.max(1, sizes.length) * variants.length;
            if (combos > MAX_TABLE_ROWS) throw new Error(`${combos} combinations requested, max ${MAX_TABLE_ROWS}; reduce widths, pointSizes or hyphenation variants`);
        } catch (e) { return formatErrorResponse(e.message, op); }

        const { config } = cfg;
        const code = `
            ${resolveTextFrameSnippet(itemId)}
            ${TEXT_HELPERS}
            ${ROLE_PROPS_SNIPPET}
            ${MEASURE_SNIPPET}
            ${matchRole.toString()}
            ${planPointSizes.toString()}
            const __roles = ${JSON.stringify(config.roles)};
            const __rules = ${JSON.stringify(config.match)};
            const __variants = ${JSON.stringify(variants)};
            const __widths = ${JSON.stringify(widths)};
            ${withMillimetersUnitsSnippet(`
                const err = __frameErr(frame);
                if (err) return { success: false, error: err };
                const m = matchRole(__roleProps(frame).p, __rules);
                const allow = (__roles[m.role] || {}).allow || {};
                const ref = frame.characters.item(0).pointSize;
                const plan = planPointSizes(ref, ${JSON.stringify(sizes)}, allow);
                if (!plan.ok.length) return { success: false, error: 'No allowed point size for role ' + m.role + ' (allowed ' + plan.range.join('..') + ' pt, rejected ' + plan.rejected.join(', ') + ')' };
                const gb = frame.geometricBounds;
                const tfp = frame.textFramePreferences;
                const info = { gb: gb.map(__r), inset: __arr(tfp.insetSpacing).map(__r), cols: tfp.textColumnCount, gutter: __r(tfp.textColumnGutter) };
                const out = [];
                for (const pt of plan.ok) {
                    for (const v of __variants) {
                        const dup = frame.duplicate();
                        try {
                            __prepare(dup);
                            __scale(dup, pt / ref);
                            __variant(dup, v.props);
                            for (const w of __widths) {
                                dup.geometricBounds = [gb[0], gb[1], gb[0] + ${MEASURE_HEIGHT}, gb[1] + w];
                                out.push({ w, pt, hyph: v.name, overset: __oversetInfo(dup).oversetCharacters, lines: __readLines(dup).map(__lineArr) });
                            }
                        } finally { dup.remove(); }
                    }
                }
                return { success: true, role: m.role, ref: __r(ref), range: plan.range, rejected: plan.rejected, info, out };
            `)}
        `;

        const res = await ScriptExecutor.executeViaUXP(code);
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to measure text table', op);
        const [top, left] = res.info.gb;
        const rows = res.out.map(m => tableRow({ ...m, lines: relativeLines(m.lines, top, left) }, res.info));
        const result = {
            itemId, role: res.role, config: cfg.file || cfg.source,
            units: 'mm, pt; top/fb/lb relative to frame top; h = first ascender to last descender; lastRel = last line / column width; rag = std dev of non-final line widths; overset = characters',
            frame: { bounds: res.info.gb.map(r2), inset: res.info.inset, cols: res.info.cols },
            refPointSize: res.ref,
            pointSizeRange: res.range,
            cols: TABLE_COLS,
            rows,
        };
        if (res.rejected.length) result.rejectedPointSizes = res.rejected;
        return formatResponse(result, op);
    }

    /**
     * Text in beliebige Umrisse laufen lassen (temporäres Duplikat mit
     * gesetztem Pfad), mehrere Kandidaten in einem Roundtrip.
     */
    static async measureTextInShapes(args = {}) {
        const op = 'Measure Text In Shapes';
        let itemId, shapes, cfg, variant, sizes;
        try {
            itemId = parseItemId(args.itemId);
            if (!Array.isArray(args.shapes) || !args.shapes.length) throw new Error('shapes must be a non-empty array of { id, points }');
            if (args.shapes.length > MAX_SHAPES) throw new Error(`max ${MAX_SHAPES} shapes per call`);
            shapes = args.shapes.map((s, i) => ({ id: s?.id ?? String(i), points: normalizePolygon(s?.points, `shapes[${i}].points`) }));
            cfg = configForTools(args.configPath);
            variant = resolveHyphenation(args.hyphenation, cfg.config, { single: true })[0];
            if (args.pointSize != null && !(typeof args.pointSize === 'number' && args.pointSize > 0)) throw new Error('pointSize must be a positive number (pt)');
            sizes = args.pointSize != null ? [args.pointSize] : [];
        } catch (e) { return formatErrorResponse(e.message, op); }

        const { config } = cfg;
        const code = `
            ${resolveTextFrameSnippet(itemId)}
            ${TEXT_HELPERS}
            ${ROLE_PROPS_SNIPPET}
            ${MEASURE_SNIPPET}
            ${matchRole.toString()}
            ${planPointSizes.toString()}
            const __roles = ${JSON.stringify(config.roles)};
            const __rules = ${JSON.stringify(config.match)};
            const __shapes = ${JSON.stringify(shapes)};
            ${withMillimetersUnitsSnippet(`
                const err = __frameErr(frame);
                if (err) return { success: false, error: err };
                const m = matchRole(__roleProps(frame).p, __rules);
                const allow = (__roles[m.role] || {}).allow || {};
                const ref = frame.characters.item(0).pointSize;
                const plan = planPointSizes(ref, ${JSON.stringify(sizes)}, allow);
                if (!plan.ok.length) return { success: false, error: 'pointSize not allowed for role ' + m.role + ' (allowed ' + plan.range.join('..') + ' pt)' };
                const out = [];
                const dup = frame.duplicate();
                try {
                    __prepare(dup);
                    __scale(dup, plan.ok[0] / ref);
                    __variant(dup, ${JSON.stringify(variant.props)});
                    for (const s of __shapes) {
                        try {
                            dup.paths.item(0).entirePath = s.points;
                            out.push({ id: s.id, overset: __oversetInfo(dup).oversetCharacters, lines: __readLines(dup).map(__lineArr) });
                        } catch (e) { out.push({ id: s.id, error: String(e.message || e) }); }
                    }
                } finally { dup.remove(); }
                return { success: true, role: m.role, pt: plan.ok[0], ref: __r(ref), out };
            `)}
        `;

        const res = await ScriptExecutor.executeViaUXP(code);
        if (!res?.success) return formatErrorResponse(res?.error || 'Failed to measure text in shapes', op);
        const results = res.out.map(o => {
            if (o.error) return { id: o.id, error: o.error };
            const shape = shapes.find(s => s.id === o.id);
            const [sTop, , sBottom] = polygonBounds(shape.points);
            const s = summarizeLines(o.lines);
            const bottom = s.top === null ? sTop : s.top + s.h;
            return {
                id: o.id,
                fits: o.overset === 0 && o.lines.length > 0,
                overset: o.overset,
                lineCount: s.n,
                usedH: r2(bottom - sTop),
                spaceBelow: r2(sBottom - bottom),
                textTop: s.top, textBottom: r2(bottom),
                hyphens: s.hyphens,
                lines: lineRows(o.lines),
            };
        });
        return formatResponse({
            itemId, role: res.role, config: cfg.file || cfg.source,
            pointSize: res.pt, refPointSize: res.ref, hyphenation: variant.name,
            units: 'mm (absolute), pt; lines = [baseline, xStart, width, hyphenated]; usedH = shape top to last descender',
            shapes: results,
        }, op);
    }
}

/** Baut das kompakte Modell aus der UXP-Rohantwort (Node-seitig, ohne InDesign). */
export async function buildModel(res, cfg, { layer = null } = {}) {
    const { config } = cfg;
    const pb = res.fmt.bounds;
    const exclude = !layer && config.sourceLayers?.exclude ? new RegExp(config.sourceLayers.exclude, 'iu') : null;
    const raw = res.items.filter(it => (layer ? it.props.layer === layer : !(exclude && exclude.test(it.props.layer))));
    if (layer && !raw.length && !res.layers.some(l => l[0] === layer)) throw new Error(`Layer '${layer}' not found`);

    const usedRoles = new Set();
    let gridUsed = false;
    const items = [];
    for (const it of raw) {
        const m = matchRole(it.props, config.match);
        usedRoles.add(m.role);
        const out = { id: it.id, role: m.role };
        if (m.rule >= 0) out.rule = m.rule;
        out.kind = it.props.kind;
        if (!['TextFrame', 'Rectangle', 'Group', 'GraphicLine'].includes(it.props.type)) out.type = it.props.type;
        out.layer = it.props.layer;
        out.bounds = it.gb.map(r2);
        const shape = it.paths ? shapeFromPaths(it.paths, it.gb) : null;
        if (shape) out.shape = shape;
        Object.assign(out, nonDefault({
            rot: it.rot || null, shear: it.shear || null, name: it.props.name, label: it.props.label,
            objectStyle: /^\[/.test(it.props.objectStyle || '') ? null : it.props.objectStyle,
            parent: it.parent, children: it.children, fill: it.fill, stroke: it.stroke, wrap: it.wrap,
        }));
        if (it.props.kind === 'text') {
            out.text = it.props.content.length > 600 ? it.props.content.slice(0, 600) + '…' : it.props.content;
            if (it.style) {
                const st = { ...it.style };
                st.hyph = { on: st.hyph[0], minWord: st.hyph[1], after: st.hyph[2], before: st.hyph[3], ladder: st.hyph[4], zone: st.hyph[5], caps: st.hyph[6] };
                const mt = res.metrics[it.metricKey];
                if (mt) st.metrics = nonDefault({ cap: r2(mt.cap), x: r2(mt.x), asc: r2(mt.asc), desc: r2(mt.desc), ascGlyph: r2(mt.ascG), descGlyph: r2(mt.descG), src: mt.src, err: mt.err });
                if (st.tint === -1 || st.tint === 100) delete st.tint;
                for (const k of ['size', 'leading', 'spaceBefore', 'spaceAfter']) st[k] = r2(st[k]);
                if (!st.spaceBefore) delete st.spaceBefore;
                if (!st.spaceAfter) delete st.spaceAfter;
                if (!st.tracking) delete st.tracking;
                if (st.gridAlign) gridUsed = true;
                out.style = nonDefault(st);
                if (it.paraStyles?.length > 1) out.paraStyles = it.paraStyles;
                if (it.runs) out.runs = it.runs;
            }
            out.frame = nonDefault({ ...it.frame, inset: it.frame.inset.map(r2), gutter: it.frame.cols > 1 ? r2(it.frame.gutter) : null, minFirstBaseline: r2(it.frame.minFirstBaseline) || null });
            const s = summarizeLines(it.lines);
            out.lines = { n: s.n, top: s.top, bottom: s.top === null ? null : r2(s.top + s.h), fb: s.fb, lb: s.lb, maxW: s.maxW, hyphens: s.hyphens, rag: s.rag, overset: it.overset, rows: lineRows(it.lines) };
        }
        if (it.props.kind !== 'text') {
            const sides = edgeSides(it.gb, pb, config.edgeTolerance);
            if (sides) { out.edge = sides; out.bleedOk = reachesBleed(it.gb, sides, buildFormatBleedBox(pb, config.imageBleed)); }
        }
        if (it.img) out.image = await imageInfo(it.img, config, m.role);
        items.push(out);
    }
    items.sort((a, b) => a.bounds[0] - b.bounds[0] || a.bounds[1] - b.bounds[1]);

    const roles = Object.fromEntries([...usedRoles].map(r => [r, config.roles[r] ? nonDefault({ rank: config.roles[r].rank, readingOrder: config.roles[r].readingOrder, allow: config.roles[r].allow }) : {}]));
    const missing = res.fonts.filter(f => !/INSTALLED/i.test(f[1]) && !/^(SUBSTITUTED|FAUXED)$/i.test(f[1]));
    return {
        document: nonDefault({ name: res.docName, path: res.docPath, modified: res.modified }),
        units: 'mm, pt; bounds [top, left, bottom, right]; line rows [baseline, xStart, width, hyphenated]; hyph [on, minWord, after, before, ladder, zone, caps]',
        format: buildFormat(res.fmt, config, gridUsed),
        config: { source: cfg.source, file: cfg.file, minPpi: config.minPpi, hyphenationVariants: Object.keys(config.hyphenation.variants), rules: config.match },
        roles,
        layers: res.layers.map(([name, visible, locked]) => (visible && !locked ? name : `${name}${visible ? '' : ' (hidden)'}${locked ? ' (locked)' : ''}`)),
        items,
        colors: res.colors,
        fonts: res.fonts.map(f => f[0]),
        ...(missing.length ? { missingFonts: missing.map(f => f[0]) } : {}),
    };
}

function buildFormatBleedBox(pb, ib) {
    return [pb[0] - ib, pb[1] - ib, pb[2] + ib, pb[3] + ib];
}

async function imageInfo(img, config, role) {
    const minPpi = config.roles[role]?.allow?.minPpi ?? config.minPpi;
    const px = (await pixelSize(img.path)) || estimatePixels(img);
    const eppi = Array.isArray(img.eppi) ? img.eppi.map(v => Math.round(v)) : null;
    let freeSpaceCache = false;
    try { freeSpaceCache = !!img.path && fs.existsSync(`${img.path}.freespace.json`); } catch {}
    return nonDefault({
        id: img.id,
        type: img.type !== 'Image' ? img.type : null,
        bounds: img.gb.map(r2),
        link: img.link, path: img.path,
        status: img.status && !/normal/i.test(img.status) ? img.status : null,
        px,
        ppi: Array.isArray(img.ppi) ? img.ppi.map(v => Math.round(v)) : null,
        effPpi: eppi,
        minPpi,
        // Faktor, um den das Bild bei Mindestauflösung noch vergrößert werden darf
        maxScale: eppi ? r2(Math.min(...eppi) / minPpi) : null,
        scale: img.scale,
        rot: img.rot || null, shear: img.shear || null,
        flip: img.flip && !/^none$/i.test(img.flip) ? img.flip : null,
        analysis: 'analyze_image_free_space',
        freeSpaceCache,
    });
}
