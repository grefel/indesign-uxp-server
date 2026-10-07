/**
 * Layout-Modell für kleine Artikel-Anzeigen – reine Logik ohne InDesign:
 * Projekt-Konfiguration (artwork.config.json) laden/prüfen, Rollen zuordnen,
 * Format ableiten, Zeilen zusammenfassen, Tabellenzeilen kompaktieren und
 * Polygone prüfen.
 *
 * Längen in mm (Lineal-Koordinaten des Dokuments), Schriftgrade in pt.
 * Bounds immer [top, left, bottom, right].
 */
import fs from 'fs';
import path from 'path';

export const CONFIG_FILE = 'artwork.config.json';

export const r2 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 + 0 : v);

const PRICE_CONTENT = '(€|EUR|CHF|\\$|£|\\d+[.,]\\d{2}|\\d+[.,]-)';

export const DEFAULT_CONFIG = {
    // Anschnitt für randabfallende Bilder, unabhängig vom Dokument-Anschnitt
    imageBleed: 3,
    minPpi: 200,
    // Toleranz, ab der ein Rahmen als „an der Seitenkante“ gilt
    edgeTolerance: 0.1,
    // Motiv darf vom Bildrahmen angeschnitten werden (safeCrop/H7 gilt weiter); false: Solver schneidet nicht, score_layout meldet H7
    allowMotifCut: true,
    // Standardabstände = Basis (kleinster Seitenrand oder Zahl in mm) × Faktor
    spacing: { base: 'minMargin', factors: { margin: 1, gap: 0.5 } },
    // Ebenen, die get_layout_model ohne layer-Parameter ignoriert
    sourceLayers: { exclude: '^(Layoutvorschlag|Variante?|Test_|Solver|Manuell)' },
    hyphenation: {
        default: ['off', 'on', 'strict'],
        variants: {
            off: { hyphenation: false },
            on: { hyphenation: true },
            strict: {
                hyphenation: true, hyphenateWordsLongerThan: 7, hyphenateAfterFirst: 3,
                hyphenateBeforeLast: 3, hyphenateLadderLimit: 1, hyphenateCapitalizedWords: false,
            },
        },
    },
    // rank: 1 = wichtigstes Element; readingOrder nur für Texte
    roles: {
        headline: { rank: 1, readingOrder: 1, allow: { move: true, resize: true, reflow: true, hyphenation: true, pointSize: 0.15, leading: 0.15 } },
        image: { rank: 2, readingOrder: null, allow: { move: true, resize: true, crop: true, scale: true, rotate: true, minPpi: 200 } },
        price: { rank: 3, readingOrder: 3, allow: { move: true, resize: true, keepTogether: true } },
        description: { rank: 4, readingOrder: 2, allow: { move: true, resize: true, reflow: true, hyphenation: true } },
        logo: { rank: 5, readingOrder: null, allow: { move: true, scale: true, minPpi: 200 } },
    },
    // Zuordnungsregeln, erste passende gewinnt; alle Kriterien einer Regel müssen passen
    match: [
        { role: 'headline', paragraphStyle: '^(h\\d|head|headline|title|titel|überschrift)' },
        { role: 'price', paragraphStyle: '^(price|preis)' },
        { role: 'description', paragraphStyle: '^(desc|beschr|body|text|copy|fließ|fliess)' },
        { role: 'price', kind: 'text', content: PRICE_CONTENT, maxChars: 40 },
        { role: 'logo', name: 'logo' },
        { role: 'logo', label: 'logo' },
        { role: 'logo', layer: 'logo' },
        { role: 'logo', kind: 'graphic', link: 'logo' },
        { role: 'image', kind: 'graphic' },
    ],
};

// Regex-Kriterien; kind/type exakt (ohne Groß-/Kleinschreibung), maxChars numerisch
export const MATCH_REGEX_KEYS = ['paragraphStyle', 'characterStyle', 'objectStyle', 'name', 'label', 'layer', 'content', 'link'];
const MATCH_KEYS = [...MATCH_REGEX_KEYS, 'kind', 'type', 'maxChars'];

// ------------------------------------------------------------------ Konfiguration

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** Objekte schlüsselweise mischen, Arrays komplett ersetzen, $-/_-Schlüssel (Kommentare) ignorieren. */
export function deepMerge(base, over) {
    if (!isObj(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (k.startsWith('$') || k.startsWith('_')) continue;
        out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
}

/**
 * Konfigurationsdatei suchen: configPath → Ordner des Dokuments und Elternordner
 * aufwärts → Env ARTWORK_CONFIG → null (eingebaute Defaults).
 */
export function findConfigFile({ configPath = null, docPath = null, env = process.env } = {}) {
    if (configPath) {
        const abs = path.resolve(configPath);
        const file = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, CONFIG_FILE) : abs;
        if (!fs.existsSync(file)) throw new Error(`Config file not found: ${file}`);
        return { file, source: 'configPath' };
    }
    if (docPath) {
        let dir = path.dirname(path.resolve(docPath));
        for (;;) {
            const file = path.join(dir, CONFIG_FILE);
            if (fs.existsSync(file)) return { file, source: 'document' };
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    if (env?.ARTWORK_CONFIG) {
        const file = path.resolve(env.ARTWORK_CONFIG);
        if (!fs.existsSync(file)) throw new Error(`ARTWORK_CONFIG file not found: ${file}`);
        return { file, source: 'env' };
    }
    return { file: null, source: 'defaults' };
}

/** Prüft eine (gemischte) Konfiguration; wirft mit verständlicher Meldung. */
export function validateConfig(cfg) {
    const num = (v, label) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`config.${label} must be a number >= 0`); };
    num(cfg.imageBleed, 'imageBleed');
    num(cfg.minPpi, 'minPpi');
    num(cfg.edgeTolerance, 'edgeTolerance');
    if (typeof cfg.allowMotifCut !== 'boolean') throw new Error('config.allowMotifCut must be true or false');
    if (!isObj(cfg.roles)) throw new Error('config.roles must be an object { roleName: { rank, readingOrder, allow } }');
    for (const [name, def] of Object.entries(cfg.roles)) {
        if (!isObj(def)) throw new Error(`config.roles.${name} must be an object`);
        if (def.allow !== undefined && !isObj(def.allow)) throw new Error(`config.roles.${name}.allow must be an object`);
        if (def.readingOrderFlexible !== undefined && typeof def.readingOrderFlexible !== 'boolean') throw new Error(`config.roles.${name}.readingOrderFlexible must be true or false`);
        for (const k of ['pointSize', 'leading']) {
            const v = def.allow?.[k];
            if (v !== undefined && v !== false && !(typeof v === 'number' && v >= 0 && v < 1)) {
                throw new Error(`config.roles.${name}.allow.${k} must be a fraction 0..1 (e.g. 0.15 for ±15 %) or false`);
            }
        }
    }
    if (!Array.isArray(cfg.match)) throw new Error('config.match must be an array of rules');
    cfg.match.forEach((rule, i) => {
        if (!isObj(rule)) throw new Error(`config.match[${i}] must be an object`);
        if (!rule.role || (!cfg.roles[rule.role] && rule.role !== 'unknown')) throw new Error(`config.match[${i}].role '${rule.role}' is not defined in config.roles`);
        const keys = Object.keys(rule).filter(k => k !== 'role' && !k.startsWith('$') && !k.startsWith('_'));
        if (!keys.length) throw new Error(`config.match[${i}] has no criteria`);
        for (const k of keys) {
            if (!MATCH_KEYS.includes(k)) throw new Error(`config.match[${i}]: unknown criterion '${k}' (allowed: ${MATCH_KEYS.join(', ')})`);
            if (MATCH_REGEX_KEYS.includes(k)) {
                try { new RegExp(rule[k], 'iu'); } catch (e) { throw new Error(`config.match[${i}].${k}: invalid regex: ${e.message}`); }
            }
            if (k === 'maxChars' && !(Number.isInteger(rule[k]) && rule[k] > 0)) throw new Error(`config.match[${i}].maxChars must be a positive integer`);
        }
    });
    const hy = cfg.hyphenation;
    if (!isObj(hy?.variants)) throw new Error('config.hyphenation.variants must be an object');
    for (const [name, props] of Object.entries(hy.variants)) {
        if (!/^[\w-]+$/.test(name)) throw new Error(`config.hyphenation.variants: invalid name '${name}'`);
        if (!isObj(props)) throw new Error(`config.hyphenation.variants.${name} must be an object`);
        for (const [k, v] of Object.entries(props)) {
            if (k.startsWith('$') || k.startsWith('_')) continue;
            // Wird als Eigenschaft in UXP gesetzt → nur einfache Namen und Werte
            if (!/^[a-zA-Z]+$/.test(k) || !['boolean', 'number'].includes(typeof v)) {
                throw new Error(`config.hyphenation.variants.${name}.${k}: only InDesign paragraph properties with boolean/number values are allowed`);
            }
        }
    }
    for (const v of hy.default || []) if (!hy.variants[v]) throw new Error(`config.hyphenation.default: unknown variant '${v}'`);
    if (cfg.sourceLayers?.exclude) {
        try { new RegExp(cfg.sourceLayers.exclude, 'iu'); } catch (e) { throw new Error(`config.sourceLayers.exclude: invalid regex: ${e.message}`); }
    }
    return cfg;
}

/** Entfernt $-/_-Kommentarschlüssel rekursiv (für Rückgabe und UXP-Übergabe). */
export function stripComments(v) {
    if (Array.isArray(v)) return v.map(stripComments);
    if (!isObj(v)) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('$') && !k.startsWith('_')).map(([k, x]) => [k, stripComments(x)]));
}

/** Konfiguration laden: Datei (s. findConfigFile) über DEFAULT_CONFIG mischen und prüfen. */
export function loadConfig(opts = {}) {
    const { file, source } = findConfigFile(opts);
    if (!file) return { config: validateConfig(stripComments(DEFAULT_CONFIG)), source, file: null };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`Config file ${file} is not valid JSON: ${e.message}`); }
    return { config: validateConfig(stripComments(deepMerge(DEFAULT_CONFIG, raw))), source, file };
}

// ------------------------------------------------------------------ Rollen

/**
 * Erste passende Zuordnungsregel. Eigenständig (keine Closures), weil sie auch
 * per toString() in UXP-Skripte eingebettet wird.
 * @param {object} p Eigenschaften: kind, type, paragraphStyle, characterStyle, objectStyle, name, label, layer, content, link
 * @param {Array<object>} rules config.match
 * @returns {{role: string, rule: number}}
 */
export function matchRole(p, rules) {
    const rx = ['paragraphStyle', 'characterStyle', 'objectStyle', 'name', 'label', 'layer', 'content', 'link'];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        let ok = true, n = 0;
        for (const k of Object.keys(r)) {
            if (k === 'role' || k[0] === '$' || k[0] === '_') continue;
            const v = r[k];
            n++;
            if (k === 'kind' || k === 'type') ok = String(p[k] || '').toLowerCase() === String(v).toLowerCase();
            else if (k === 'maxChars') ok = String(p.content || '').trim().length <= v;
            else if (rx.indexOf(k) >= 0) ok = p[k] != null && p[k] !== '' && new RegExp(v, 'iu').test(String(p[k]));
            else ok = false;
            if (!ok) break;
        }
        if (ok && n) return { role: r.role, rule: i };
    }
    return { role: 'unknown', rule: -1 };
}

/**
 * Erlaubte Schriftgrade gegenüber dem Referenzgrad ref (pt). Eigenständig für UXP.
 * allow.pointSize = Anteil (0.15 → ±15 %); fehlt er, ist nur ref erlaubt.
 * @returns {{ok:number[], rejected:number[], range:number[]}}
 */
export function planPointSizes(ref, sizes, allow) {
    const f = allow && typeof allow.pointSize === 'number' ? allow.pointSize : 0;
    const lo = ref * (1 - f) - 0.005, hi = ref * (1 + f) + 0.005;
    const ok = [], rejected = [];
    const list = sizes && sizes.length ? sizes : [ref];
    for (const s of list) {
        const v = Math.round(s * 100) / 100;
        if (v >= lo && v <= hi) { if (ok.indexOf(v) < 0) ok.push(v); } else rejected.push(v);
    }
    return { ok, rejected, range: [Math.round(ref * (1 - f) * 100) / 100, Math.round(ref * (1 + f) * 100) / 100] };
}

// ------------------------------------------------------------------ Format

/**
 * Seitenränder physisch (oben, links, unten, rechts). Bei doppelseitigen
 * Dokumenten ist marginPreferences.left der Bundsteg; auf linken Seiten liegt er rechts.
 */
export function physicalMargins(mp, facing, side) {
    const [t, l, b, r] = mp;
    return facing && /LEFT/i.test(String(side)) ? [t, r, b, l] : [t, l, b, r];
}

/**
 * Format-Block des Modells.
 * @param {object} raw { bounds, margins[t,l,b,r] (marginPreferences), cols, gutter, docBleed[t,in,b,out], facing, side, grid }
 * @param {object} config aufgelöste Konfiguration
 * @param {boolean} gridUsed Text richtet sich am Grundlinienraster aus
 */
export function buildFormat(raw, config, gridUsed = false) {
    const pb = raw.bounds;
    const m = physicalMargins(raw.margins, raw.facing, raw.side);
    const bleed = physicalMargins(raw.docBleed || [0, 0, 0, 0], raw.facing, raw.side);
    const ib = config.imageBleed;
    const baseMm = typeof config.spacing?.base === 'number' ? config.spacing.base : Math.min(...m);
    const modules = Object.fromEntries(Object.entries(config.spacing?.factors || {}).map(([k, f]) => [k, r2(baseMm * f)]));
    const fmt = {
        page: { index: raw.index, name: raw.name, size: [r2(pb[3] - pb[1]), r2(pb[2] - pb[0])], bounds: pb.map(r2) },
        margins: m.map(r2),
        typeArea: [pb[0] + m[0], pb[1] + m[1], pb[2] - m[2], pb[3] - m[3]].map(r2),
        columns: [raw.cols, r2(raw.gutter)],
        docBleed: bleed.every(v => !v) ? 0 : bleed.map(r2),
        imageBleed: ib,
        imageBleedBox: [pb[0] - ib, pb[1] - ib, pb[2] + ib, pb[3] + ib].map(r2),
        modules,
        grid: null,
    };
    if (raw.facing) fmt.page.side = String(raw.side).toLowerCase();
    if (raw.grid && (raw.grid.shown || gridUsed)) {
        fmt.grid = { start: r2(raw.grid.start), step: r2(raw.grid.step), relativeTo: String(raw.grid.relative).toLowerCase() };
    }
    return fmt;
}

/** Seiten, an denen ein Rahmen die Seitenkante erreicht oder überragt ('t','l','b','r'). */
export function edgeSides(bounds, pageBounds, tol = 0.1) {
    let s = '';
    if (bounds[0] <= pageBounds[0] + tol) s += 't';
    if (bounds[1] <= pageBounds[1] + tol) s += 'l';
    if (bounds[2] >= pageBounds[2] - tol) s += 'b';
    if (bounds[3] >= pageBounds[3] - tol) s += 'r';
    return s;
}

/** Reicht der Rahmen an allen Kanten-Seiten bis in den Bild-Anschnitt? */
export function reachesBleed(bounds, sides, bleedBox, tol = 0.01) {
    const idx = { t: 0, l: 1, b: 2, r: 3 };
    return [...sides].every(s => (s === 't' || s === 'l') ? bounds[idx[s]] <= bleedBox[idx[s]] + tol : bounds[idx[s]] >= bleedBox[idx[s]] - tol);
}

// ------------------------------------------------------------------ Form

/** Ankerpunkte eines entirePath (Punkte [x,y] oder [[lx,ly],[ax,ay],[rx,ry]]) und ob Kurven vorkommen. */
export function pathAnchors(entirePath) {
    let curved = false;
    const pts = entirePath.map(p => {
        if (Array.isArray(p[0])) {
            const [l, a, r] = p;
            if (Math.abs(l[0] - a[0]) > 1e-3 || Math.abs(l[1] - a[1]) > 1e-3 || Math.abs(r[0] - a[0]) > 1e-3 || Math.abs(r[1] - a[1]) > 1e-3) curved = true;
            return a;
        }
        return p;
    });
    return { pts, curved };
}

/**
 * Form eines Rahmens: null für ein achsparalleles Rechteck = Bounds, sonst
 * { pts, curved?, paths? } mit Ankerpunkten [x,y] in mm.
 */
export function shapeFromPaths(paths, bounds, tol = 0.01) {
    if (!Array.isArray(paths) || !paths.length) return null;
    const parsed = paths.map(pathAnchors);
    if (parsed.length === 1 && !parsed[0].curved && parsed[0].pts.length === 4) {
        const [t, l, b, r] = bounds;
        const onCorner = ([x, y]) => (Math.abs(x - l) < tol || Math.abs(x - r) < tol) && (Math.abs(y - t) < tol || Math.abs(y - b) < tol);
        const distinct = new Set(parsed[0].pts.map(([x, y]) => `${Math.abs(x - l) < tol ? 'l' : 'r'}${Math.abs(y - t) < tol ? 't' : 'b'}`));
        if (parsed[0].pts.every(onCorner) && distinct.size === 4) return null;
    }
    const out = { pts: parsed[0].pts.map(p => p.map(r2)) };
    if (parsed.some(p => p.curved)) out.curved = true;
    if (parsed.length > 1) out.paths = parsed.slice(1).map(p => p.pts.map(q => q.map(r2)));
    return out;
}

/** Polygon prüfen und normieren: ≥3 verschiedene Punkte, Schlusspunkt/Doppelpunkte entfernt, Fläche > 0. */
export function normalizePolygon(points, label = 'points') {
    if (!Array.isArray(points)) throw new Error(`${label} must be an array of [x, y] pairs`);
    const pts = [];
    for (const p of points) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v))) {
            throw new Error(`${label}: every point must be [x, y] with finite numbers (mm), got ${JSON.stringify(p)}`);
        }
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) pts.push([p[0], p[1]]);
    }
    if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
    if (pts.length < 3) throw new Error(`${label} needs at least 3 distinct points`);
    if (polygonArea(pts) < 1e-4) throw new Error(`${label} encloses no area`);
    return pts;
}

export function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
}

/** Bounds [top, left, bottom, right] eines Polygons. */
export function polygonBounds(pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

// ------------------------------------------------------------------ Zeilen / Tabellen

/**
 * Zeile aus UXP: [text, baseline, ascent, descent, x, width, paragraphEnd 0/1, hyphenated 0/1]
 * Zusammenfassung; Positionen relativ zu top (0 → absolut).
 * rag = Std.-Abweichung der Zeilenbreiten ohne Absatz-Endzeilen und Leerzeilen.
 */
export function summarizeLines(lines, { top = 0, textWidth = null } = {}) {
    const vis = lines.filter(l => String(l[0]).trim() !== '');
    if (!vis.length) return { n: lines.length, top: null, h: 0, fb: null, lb: null, maxW: 0, lastRel: 0, hyphens: 0, dashStarts: 0, rag: 0 };
    const first = vis[0], last = vis[vis.length - 1];
    const textTop = first[1] - first[2];
    const textBottom = Math.max(...vis.map(l => l[1] + l[3]));
    const body = vis.filter(l => !l[6] && l !== last).map(l => l[5]);
    let rag = 0;
    if (body.length > 1) {
        const mean = body.reduce((s, w) => s + w, 0) / body.length;
        rag = Math.sqrt(body.reduce((s, w) => s + (w - mean) ** 2, 0) / body.length);
    }
    return {
        n: lines.length,
        top: r2(textTop - top),
        h: r2(textBottom - textTop),
        fb: r2(first[1] - top),
        lb: r2(last[1] - top),
        maxW: r2(Math.max(...vis.map(l => l[5]))),
        lastRel: textWidth ? r2(last[5] / textWidth) : null,
        hyphens: lines.filter(l => l[7]).length,
        dashStarts: vis.filter(l => /^\s*[-–—‒]/.test(String(l[0]))).length,
        rag: r2(rag),
    };
}

/** Spalten der Breiten-Tabelle (eine Zeile je Breite × Schriftgrad × Trennvariante). */
export const TABLE_COLS = ['w', 'pt', 'hyph', 'lines', 'top', 'h', 'fb', 'lb', 'maxW', 'lastRel', 'hyphens', 'dashStarts', 'rag', 'overset'];

/** Satzbreite einer Spalte: Rahmenbreite − Innenabstände − Spaltenabstände. */
export function textColumnWidth(width, inset, cols = 1, gutter = 0) {
    const [, l = 0, , r = 0] = inset.length === 4 ? inset : [inset[0], inset[0], inset[0], inset[0]];
    return (width - l - r - gutter * (cols - 1)) / cols;
}

/** Kompakte Tabellenzeile gemäß TABLE_COLS aus einer Rohmessung { w, pt, hyph, overset, lines }. */
export function tableRow(m, frameInfo) {
    const s = summarizeLines(m.lines, { top: 0, textWidth: textColumnWidth(m.w, frameInfo.inset, frameInfo.cols, frameInfo.gutter) });
    return [r2(m.w), r2(m.pt), m.hyph, s.n, s.top, s.h, s.fb, s.lb, s.maxW, s.lastRel, s.hyphens, s.dashStarts, s.rag, m.overset];
}

/** Zeilen relativ zur Rahmenoberkante/-linken machen (für die Tabelle). */
export function relativeLines(lines, top, left) {
    return lines.map(l => [l[0], l[1] - top, l[2], l[3], l[4] - left, l[5], l[6], l[7]]);
}

/** Kompakte Zeilen [baseline, x, width, hyphenated] für Modell/Polygon-Ausgabe. */
export const lineRows = lines => lines.map(l => [r2(l[1]), r2(l[4]), r2(l[5]), l[7] ? 1 : 0]);

/** Breiten-Spezifikation: Liste oder { min, max, step } → sortierte Liste in mm. */
export function parseWidths(spec, maxCount = 200) {
    let list;
    if (Array.isArray(spec)) list = spec;
    else if (isObj(spec)) {
        const { min, max, step } = spec;
        if (![min, max, step].every(v => typeof v === 'number' && Number.isFinite(v)) || min <= 0 || max < min || step <= 0) {
            throw new Error('widths {min, max, step} must be numbers with 0 < min <= max and step > 0');
        }
        list = [];
        for (let w = min; w <= max + 1e-9; w += step) list.push(w);
        if (list.length > maxCount) throw new Error(`widths range yields ${list.length} values, max ${maxCount}`);
    } else throw new Error('widths must be an array of mm values or {min, max, step}');
    const out = [...new Set(list.map(v => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`widths: invalid width ${JSON.stringify(v)}`);
        return r2(v);
    }))].sort((a, b) => a - b);
    if (!out.length) throw new Error('widths is empty');
    if (out.length > maxCount) throw new Error(`too many widths (${out.length}), max ${maxCount}`);
    return out;
}

/** Trennvarianten aus Parameter (Name oder Liste) gegen die Konfiguration auflösen. */
export function resolveHyphenation(param, config, { single = false } = {}) {
    const hy = config.hyphenation;
    if (param === undefined || param === null) {
        if (single) return [{ name: 'asIs', props: {} }];
        return (hy.default?.length ? hy.default : ['asIs']).map(n => ({ name: n, props: hy.variants[n] || {} }));
    }
    const names = Array.isArray(param) ? param : [param];
    if (single && names.length !== 1) throw new Error('hyphenation must be a single variant name');
    return names.map(n => {
        if (n === 'asIs') return { name: n, props: {} };
        if (!hy.variants[n]) throw new Error(`Unknown hyphenation variant '${n}' (available: asIs, ${Object.keys(hy.variants).join(', ')})`);
        return { name: n, props: hy.variants[n] };
    });
}


