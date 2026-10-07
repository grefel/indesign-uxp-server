/**
 * Layer tool definitions for InDesign MCP Server
 * Layer management and functionality
 */

export const layerToolDefinitions = [
    // =================== LAYERS MANAGEMENT ===================
    {
        name: 'create_layer',
        description: 'Create a new layer',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Layer name' },
                visible: { type: 'boolean', description: 'Layer visibility', default: true },
                locked: { type: 'boolean', description: 'Layer locked state', default: false },
                color: { type: 'string', description: 'Layer color (RGB values as comma-separated string or UI color name)', default: 'BLUE' },
            },
            required: ['name'],
        },
    },
    {
        name: 'set_active_layer',
        description: 'Set the active layer',
        inputSchema: {
            type: 'object',
            properties: {
                layerName: { type: 'string', description: 'Layer name to activate' },
            },
            required: ['layerName'],
        },
    },
    {
        name: 'list_layers',
        description: 'List all layers in the document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'duplicate_items_to_layer',
        description: 'Duplicate page items onto a layer (created on top if missing) at their exact original position; optionally hide the layers the source items are on. Locked source/target layers are unlocked temporarily. Items nested in groups are rejected — pass the group.',
        inputSchema: {
            type: 'object',
            properties: {
                itemIds: { type: 'array', items: { type: 'number' }, description: 'Ids of the items to duplicate (from list_page_items / get_page_item_info)' },
                layerName: { type: 'string', description: 'Target layer name' },
                hideSource: { type: 'boolean', description: 'Hide the source layers afterwards', default: false },
            },
            required: ['itemIds', 'layerName'],
        },
    },
    {
        name: 'export_layer_preview',
        description: 'Export a single page as JPG or PNG with only one layer visible, always in RGB (document RGB profile, embedded for JPG). Layer visibility and InDesign export preferences are restored afterwards.',
        inputSchema: {
            type: 'object',
            properties: {
                layerName: { type: 'string', description: 'Layer to show' },
                path: { type: 'string', description: 'Output file path (.jpg/.jpeg or .png); the directory must exist' },
                dpi: { type: 'number', description: 'Resolution in ppi', default: 150 },
                format: { type: 'string', enum: ['JPG', 'PNG'], description: 'Overrides the format derived from the file extension' },
                pageIndex: { type: 'number', description: 'Page index (0-based, absolute). Default: first page with items on the layer' },
                transparentBackground: { type: 'boolean', description: 'PNG only: transparent instead of white background', default: true },
                includeBleed: { type: 'boolean', description: 'Include the document bleed', default: false },
                simulateOverprint: { type: 'boolean', description: 'Simulate overprint', default: false },
            },
            required: ['layerName', 'path'],
        },
    },
]; 