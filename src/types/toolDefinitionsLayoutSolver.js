/**
 * Tool definitions: Layout-Solver (Kandidaten erzeugen, bewerten, auf Ebenen anwenden)
 */

const box = { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[top, left, bottom, right] in mm (document ruler coordinates)' };

export const layoutSolverToolDefinitions = [
    {
        name: 'artwork_solve',
        description: 'Layout solver for a small ad page: reads the layout model of the source layer, measures every text frame as a width table in batched round trips (widths config.solver.measure.minWidth .. type-area width in measure.step mm; headline point sizes within allow.pointSize, leading within allow.leading; hyphenation variants per role), generates thousands of candidates in Node (image zone left/right/top/bottom/overlay, optionally bleeding by imageBleed; image scale between "fits zone" and minPpi with safe crop kept visible; text stacked in readingOrder, price placed freely: below text, bottom right, on the motif ground line, beside the description; alignment variants cap height = motif top, last baseline = motif ground line), prefilters by hard rules, scores with score_layout rules, measures text in polygon outlines along the motif for the most promising near-misses (one round trip), selects the best candidate, then greedily the most different arrangements (feature distance: direction text→image, image third/size class, bleed, text columns, stacking order, price position) among candidates with score ≥ solver.diversity.minScore × best (fallback down to fallbackScore if none differs by minDistance) and writes them to layers <layerPrefix>1..N (same-named layers are replaced, source items duplicated, source layer hidden, only the first proposal layer visible), re-measures them in the same script and reports deviations from the prediction, then exports every proposal layer (RGB PNG) into one contact sheet. The document is never saved. Returns per proposal: layer, topology, score + breakdown S1..S10, key parameters (column width, headline pt/leading, description width/hyphenation, image frame/size/effective ppi), deviations; contact sheet path; stats (candidates generated/prefiltered/scored/valid, round trips, ms). Lengths mm, sizes pt. Solver parameters: section "solver" in artwork.config.json.',
        inputSchema: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Zero-based page index', default: 0 },
                sourceLayer: { type: 'string', description: 'Layer with the original items. Default: the non-excluded layer with most items (config.sourceLayers.exclude and layerPrefix are skipped)' },
                count: { type: 'number', description: 'Number of proposals (1..6)', default: 3 },
                apply: { type: 'boolean', description: 'Write proposals to layers (false = compute only)', default: true },
                preview: { type: 'boolean', description: 'Export a contact sheet PNG of the proposal layers (requires apply)', default: true },
                layerPrefix: { type: 'string', description: 'Name prefix of the proposal layers', default: 'Layoutvorschlag' },
                previewDir: { type: 'string', description: 'Folder for the contact sheet. Default: <tmp>/artwork-solver' },
                previewDpi: { type: 'number', description: 'Export resolution of the preview tiles (dpi)', default: 96 },
                returnCandidates: { type: 'boolean', description: 'Also return the full serialized candidates (input format of artwork_apply)', default: false },
                configPath: { type: 'string', description: 'Path to artwork.config.json (or its folder). Default: searched from the document folder upwards' },
                dumpPath: { type: 'string', description: 'Write model + measurement tables as JSON to this file (offline analysis of the generator)' },
                seed: { type: 'number', description: 'Seed for the stratified sampling when more candidates pass the prefilter than config.solver.budget' },
            },
        },
    },
    {
        name: 'artwork_apply',
        description: 'Write serialized solver candidates (from artwork_solve with returnCandidates, possibly modified) to layers in one round trip: same-named layers are replaced, source items duplicated and set to the given geometry/typography, source layers hidden, only the first layer visible; text frames are grown in 0.25 mm steps if the last line would be overset. Re-measures and reports deviations from `predicted` (line count/breaks, first/last baseline ±0.15 mm, effective ppi). Candidate format: { texts: [{ id (source text frame id), role, frame [t,l,b,r] mm, shape? [[x,y],…] mm polygon outline, pointSize pt, leading pt, leadingAuto (keep auto leading), hyphenation (variant name of config.hyphenation.variants or "asIs"), noBreak?, predicted?: { lines: [text…], firstBaseline mm, lastBaseline mm } }], images: [{ id (source graphic frame id), frame [t,l,b,r] mm, imageBounds [t,l,b,r] mm (image content, aspect ratio must be kept), effPpi? }] }.',
        inputSchema: {
            type: 'object',
            properties: {
                candidates: {
                    type: 'array',
                    description: 'Candidates (max 6), see description for the format',
                    items: {
                        type: 'object',
                        properties: {
                            texts: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, frame: box, shape: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, pointSize: { type: 'number' }, leading: { type: 'number' }, leadingAuto: { type: 'boolean' }, hyphenation: { type: 'string' }, noBreak: { type: 'boolean' } }, required: ['id', 'frame'] } },
                            images: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, frame: box, imageBounds: box }, required: ['id', 'frame', 'imageBounds'] } },
                        },
                    },
                },
                layerNames: { type: 'array', items: { type: 'string' }, description: 'Target layer per candidate (replaced if it exists)' },
                configPath: { type: 'string', description: 'Path to artwork.config.json for hyphenation variants. Default: config of the last artwork_solve' },
            },
            required: ['candidates', 'layerNames'],
        },
    },
];
