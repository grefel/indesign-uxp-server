/**
 * Tool definitions: Bildanalyse (Motivmaske, Merkmale/Linien, Kollision Text ↔ Motiv)
 */

const maskParams = {
    grid: { type: 'number', description: 'Cells along the longer image side (square cells, 4..256)' },
    whiteThreshold: { type: 'number', description: 'Pixels with luminance below this (0..255, alpha flattened onto white) count as motif', default: 250 },
    occupiedRatio: { type: 'number', description: 'A cell is motif if more than this fraction of its pixels is motif', default: 0.02 },
    fillHoles: { type: 'boolean', description: 'Treat free cells enclosed by motif (e.g. white laces) as motif', default: true },
    useCache: { type: 'boolean', description: 'Use/write the sidecar cache <link>.freespace.json next to the linked file', default: true },
};

export const imageAnalysisToolDefinitions = [
    {
        name: 'analyze_image_free_space',
        description: 'Analyse a placed image without viewing it: motif mask (maskRows, "#" motif, "." free, page orientation), motif bounding box (normalized 0..1 and page mm), per-row motif spans [top, bottom, left1, right1, left2, right2, …] in page mm (visible part only), largest free rectangles in the visible image area, visible ratio and cut sides of the motif, and max width/scale at 200 ppi. Motif = non-white pixels. All positions in mm.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'number', description: 'Id of the graphic frame or of the placed image itself' },
                ...maskParams,
                grid: { ...maskParams.grid, default: 32 },
            },
            required: ['itemId'],
        },
    },
    {
        name: 'analyze_image_features',
        description: 'Focus point and alignment lines of a placed image, from pixel analysis (motif = non-white pixels, white areas enclosed by the motif count as motif). Returns centroid (ink-weighted center of mass), focus (center of interest from edge density, local contrast and saturation with mild center bias; point, region, confidence 0..1, visible in frame), safeCrop (min = focus region + buffer, motif = motif bbox; sides currently cut), principalAxis (PCA of the motif: angle, length, eccentricity 0..1, center, ends), groundLine (bottom contour line the motif stands on, only if near horizontal ±10° and supported, else null: angle, yLeft/yRight at the motif edges, x range, support x range, quality = supported share of motif columns), edges (dominant straight edges, horizontal/vertical first: class, angle, length, strength = contrast 0..1, from/to, norm), extremes (outer motif edges left/right/top/bottom; hard = straight axis-parallel edge usable as alignment line, otherwise a single point such as a tip), direction (facing/movement direction from the tapered end along the principal axis: left|right|up|down|none, confidence 0..1, angle). Positions in page mm for the current placement (flips applied) plus normalized 0..1 of the image bounds; angles in degrees, 0 = horizontal, positive = counter-clockwise. Results are cached in the sidecar <link>.freespace.json.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'number', description: 'Id of the graphic frame or of the placed image itself' },
                whiteThreshold: maskParams.whiteThreshold,
                axisTolerance: { type: 'number', description: 'Max deviation in degrees for an edge to be classed horizontal or vertical (0..30)', default: 5 },
                maxEdges: { type: 'number', description: 'Number of edges returned (0..12)', default: 6 },
                useCache: maskParams.useCache,
            },
            required: ['itemId'],
        },
    },
    {
        name: 'check_motif_collision',
        description: 'Check text frames (line by line: baseline-ascent..baseline+descent, horizontalOffset..endHorizontalOffset) and/or rectangles against the visible motif of a placed image (non-white pixels inside its frame). Returns per item ok, minimal distance to the motif and, for collisions, the affected lines with overlap in mm. Without itemIds and rects all text frames on the image page and layer are checked. All values in mm.',
        inputSchema: {
            type: 'object',
            properties: {
                imageItemId: { type: 'number', description: 'Id of the graphic frame or placed image' },
                itemIds: { type: 'array', items: { type: 'number' }, description: 'Text frame ids to check (other item types are checked by their geometric bounds)' },
                rects: {
                    type: 'array',
                    description: 'Additional rectangles in page mm',
                    items: {
                        type: 'object',
                        properties: {
                            label: { type: 'string' },
                            top: { type: 'number' }, left: { type: 'number' },
                            bottom: { type: 'number' }, right: { type: 'number' },
                        },
                        required: ['top', 'left', 'bottom', 'right'],
                    },
                },
                minGap: { type: 'number', description: 'Required clearance to the motif in mm; closer counts as collision', default: 0 },
                ...maskParams,
                grid: { ...maskParams.grid, default: 64 },
            },
            required: ['imageItemId'],
        },
    },
];
