/**
 * Tool definitions: Bildanalyse (Motivmaske, Kollision Text ↔ Motiv)
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
