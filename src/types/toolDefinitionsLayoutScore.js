/**
 * Tool definitions: Layout-Bewertung (harte Regeln + gewichteter Score)
 */

export const layoutScoreToolDefinitions = [
    {
        name: 'score_layout',
        description: 'Evaluate existing layout variants (one per layer) of an ad page: hard rules + weighted design score, for calibrating a layout solver. Reads all given layers in ONE InDesign round trip (lines via everyItem, no temporary objects, document unchanged); image motif mask and features come from the sidecar cache or are computed in Node. Hard rules (any violation ⇒ valid=false; each can be disabled in config.scoring.rules): H1 no overset, H2 text line boxes (incl. ascenders/descenders) inside type area, H3 keepTogether roles (price) on one line, H4 only allowed style changes vs. the same role on the source layer (headline size/leading ±15 %, others unchanged), H5 effective ppi >= minPpi, H6 image edge either >= page margin inside the page or bleeding to imageBleedBox, H7 image safeCrop fully visible, H8 no text line closer than minGap (mm) to the motif, H9 no overlapping text line boxes, H10 no line starting with a dash, hyphenation >= 3 chars each side. Criteria S1–S10 (0..1, 1 = good; null = no data, excluded from the sum): S1 alignment lines (shared text edges/baselines/cap height with other elements, motif edges, ground line, type area; near-miss penalty; wish alignments), S2 spacing rhythm (gaps as multiples of the spacing module, equal gaps for equal relations), S3 grouping (text↔motif distance vs. distance within the text group, target ratio 1.5), S4 hierarchy (optical weight vs. config rank, Spearman), S5 balance (weighted centroid vs. optical center 50 %/45 %), S6 white space (pinched gaps < 1 module, dominant empty hole), S7 image share (visible motif area / type area in target range), S8 typography (rag, hyphens, short last line, headline balance, chars per line), S9 reading flow (Z pattern vs. readingOrder), S10 gaze (motif direction points to the text). score = Σ w·S / Σ w (weights in config.scoring.weights). Output per layer: valid, score, breakdown (2 decimals), notes, violations; with detail: alignment lines, unanchored lines, gaps, optical weights, centroid, largest hole. Lengths in mm, sizes in pt.',
        inputSchema: {
            type: 'object',
            properties: {
                layers: { type: 'array', items: { type: 'string' }, description: 'Layer names to evaluate (max 12), e.g. ["Ebene 1", "Layoutvorschlag1"]. Hidden layers are evaluated too.' },
                pageIndex: { type: 'number', description: 'Zero-based page index', default: 0 },
                configPath: { type: 'string', description: 'Path to artwork.config.json (or its folder). Default: searched in the document folder and its parents, then env ARTWORK_CONFIG, then built-in defaults. Section "scoring" holds weights, tolerances, target ranges, wish alignments and rule switches; scoring.sourceLayer = layer with the original styles for H4 (default: first layer not matching sourceLayers.exclude).' },
                detail: { type: 'boolean', description: 'Include alignment lines, gaps, optical weights, centroid and largest empty rectangle', default: false },
            },
            required: ['layers'],
        },
    },
];
