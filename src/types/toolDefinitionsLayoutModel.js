/**
 * Tool definitions: Layout-Modell (Analyse) und Text-Messungen für einen Layout-Solver
 */

const configPath = { type: 'string', description: 'Path to artwork.config.json (or its folder). Default: searched in the document folder and its parents, then env ARTWORK_CONFIG, then built-in defaults. Measure tools without configPath use the config found for the document of the last get_layout_model call.' };

const hyphenationItem = { type: 'string', description: "Variant name from config.hyphenation.variants (default config: 'off', 'on', 'strict') or 'asIs' (unchanged)" };

export const layoutModelToolDefinitions = [
    {
        name: 'get_layout_model',
        description: 'Compact layout model of one page in a single InDesign round trip, for a layout solver. Returns: format (page size/bounds, physical page margins from page.marginPreferences, type area, columns, document bleed, imageBleed + imageBleedBox = area a bleeding image must reach, baseline grid if shown/used, spacing modules derived from the margin), resolved project config (source file, role rules), roles in use (rank, readingOrder, allowed changes), items (role or "unknown", matched rule index, kind, layer, bounds, polygon shape for non-rectangular frames, fill/stroke/wrap; text: content, style incl. font metrics cap/x-height/ascender/descender in mm, frame insets/first baseline, line summary and rows [baseline, xStart, width, hyphenated]; graphics: image bounds, link, pixels, actual/effective ppi, maxScale at minPpi, rotation/flip, edge sides + bleedOk, hint to analyze_image_free_space), used colors and fonts. Layers matching config.sourceLayers.exclude (default Layoutvorschlag*) are skipped unless layer is given. All lengths in mm (document ruler coordinates), sizes in pt.',
        inputSchema: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index', default: 0 },
                layer: { type: 'string', description: 'Only items on this layer' },
                configPath,
            },
        },
    },
    {
        name: 'measure_text_table',
        description: 'Measure a text frame as an elastic box: for every width × point size × hyphenation variant the text is set on a temporary duplicate (top-aligned, wrap ignored, tall frame; removed afterwards) in one round trip. Returns compact rows with cols [w, pt, hyph, lines, top, h, fb, lb, maxW, lastRel, hyphens, dashStarts, rag, overset]: width mm, point size of the first character (pt), variant, line count, text top (first ascender) and h (first ascender to last descender), first/last baseline — all relative to the frame top in mm; widest line mm, last line width / column width, hyphenated lines, lines starting with a dash, rag = std dev of non-final line widths mm, overset characters. Point sizes outside the range allowed by the role (config allow.pointSize, e.g. ±15 % for headline) are rejected; leading scales proportionally. Max 240 combinations.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'number', description: 'Id of the text frame' },
                widths: {
                    description: 'Frame widths in mm: array of numbers or {min, max, step}',
                    oneOf: [
                        { type: 'array', items: { type: 'number' } },
                        { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' } }, required: ['min', 'max', 'step'] },
                    ],
                },
                pointSizes: { type: 'array', items: { type: 'number' }, description: 'Point sizes (pt) for the first character, other text scaled proportionally. Default: current size' },
                hyphenation: { type: 'array', items: hyphenationItem, description: 'Hyphenation variants, default config.hyphenation.default (off, on, strict)' },
                configPath,
            },
            required: ['itemId', 'widths'],
        },
    },
    {
        name: 'measure_text_in_shapes',
        description: 'Flow the text of a frame into arbitrary outlines (triangles, trapezoids, rectangle minus motif …) using one temporary polygon duplicate whose path is set per shape (wrap ignored, top-aligned; removed afterwards) — several candidate shapes in one round trip. Points are [x, y] in mm, document ruler coordinates (same as bounds of get_layout_model). Non-rectangular frames use the first inset value uniformly. Returns per shape: fits, overset characters, lineCount, usedH (shape top to last descender), spaceBelow (to shape bottom), textTop/textBottom, hyphens and lines [baseline, xStart, width, hyphenated] in absolute mm.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'number', description: 'Id of the text frame' },
                shapes: {
                    type: 'array',
                    description: 'Candidate outlines (max 40)',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Polygon corners [[x, y], …] in mm, at least 3' },
                        },
                        required: ['points'],
                    },
                },
                pointSize: { type: 'number', description: 'Point size (pt) of the first character, only within the range allowed by the role. Default: current' },
                hyphenation: { ...hyphenationItem, description: `${hyphenationItem.description}. Default asIs` },
                configPath,
            },
            required: ['itemId', 'shapes'],
        },
    },
];
