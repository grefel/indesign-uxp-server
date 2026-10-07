/**
 * Layer handlers — duplicating items onto layers and per-layer previews.
 */
import fs from 'fs';
import path from 'path';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { withMillimetersUnitsSnippet } from '../utils/geometryUtils.js';
import { parseItemId } from '../utils/itemUtils.js';

export class LayerHandlers {
    /**
     * Duplicates items onto a (new) layer at their original position and
     * optionally hides the layers the sources live on.
     */
    static async duplicateItemsToLayer(args) {
        const op = 'Duplicate Items To Layer';
        const { layerName, hideSource = false } = args;
        let itemIds;
        try {
            if (!Array.isArray(args.itemIds) || args.itemIds.length === 0) throw new Error('itemIds must be a non-empty array');
            itemIds = [...new Set(args.itemIds.map(id => parseItemId(id, 'itemIds[]')))];
            if (typeof layerName !== 'string' || !layerName.trim()) throw new Error('layerName is required');
        } catch (e) { return formatErrorResponse(e.message, op); }

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const ids = ${JSON.stringify(itemIds)};
            const layerName = ${JSON.stringify(layerName)};
            const __r = v => Math.round(v * 1000) / 1000;

            const byId = new Map();
            const all = doc.allPageItems;
            for (let i = 0; i < all.length; i++) if (ids.includes(all[i].id)) byId.set(all[i].id, all[i]);
            const missing = ids.filter(id => !byId.has(id));
            if (missing.length) return { success: false, error: 'No page items with ids: ' + missing.join(', ') };

            let target = doc.layers.itemByName(layerName);
            const created = !target.isValid;
            if (created) target = doc.layers.add({ name: layerName });

            // Gesperrte Ebenen verhindern duplicate()/itemLayer → temporär entsperren
            const relock = [];
            const unlock = layer => { if (layer.locked && !relock.some(l => l.id === layer.id)) { layer.locked = false; relock.push(layer); } };
            unlock(target);

            const results = [];
            const sourceLayers = new Map();
            ${withMillimetersUnitsSnippet(`
                try {
                    for (const id of ids) {
                        const item = byId.get(id);
                        const parentType = item.parent.constructor.name;
                        if (parentType !== 'Spread' && parentType !== 'MasterSpread') {
                            results.push({ sourceId: id, error: 'Item is nested in a ' + parentType + '; duplicate its top-level container instead' });
                            continue;
                        }
                        const srcLayer = item.itemLayer;
                        sourceLayers.set(srcLayer.id, srcLayer);
                        unlock(srcLayer);
                        try {
                            const dup = item.duplicate();
                            dup.itemLayer = target;
                            results.push({
                                sourceId: id,
                                newId: dup.id,
                                type: dup.constructor.name,
                                sourceLayer: srcLayer.name,
                                geometricBounds: dup.geometricBounds.map(__r),
                            });
                        } catch (e) {
                            results.push({ sourceId: id, error: e.message });
                        }
                    }
                } finally {
                    relock.forEach(l => { l.locked = true; });
                }
            `)}

            const hiddenLayers = [];
            if (${hideSource}) {
                for (const layer of sourceLayers.values()) {
                    if (layer.id !== target.id && layer.visible) { layer.visible = false; hiddenLayers.push(layer.name); }
                }
            }
            const failed = results.filter(r => r.error);
            return {
                success: failed.length < results.length,
                error: failed.length === results.length ? 'No item could be duplicated: ' + failed.map(f => f.sourceId + ': ' + f.error).join('; ') : undefined,
                layer: target.name,
                layerCreated: created,
                units: 'mm',
                duplicated: results.filter(r => !r.error),
                failed,
                hiddenLayers,
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, op)
            : formatErrorResponse(result?.error || 'Failed to duplicate items', op);
    }

    /**
     * Exports one page with only the given layer visible as JPG/PNG in RGB.
     * Layer visibility and the app-wide export preferences are restored afterwards.
     */
    static async exportLayerPreview(args) {
        const op = 'Export Layer Preview';
        const {
            layerName,
            path: filePath,
            dpi = 150,
            pageIndex,
            transparentBackground = true,
            includeBleed = false,
            simulateOverprint = false,
        } = args;

        if (typeof layerName !== 'string' || !layerName.trim()) return formatErrorResponse('layerName is required', op);
        if (typeof filePath !== 'string' || !filePath.trim()) return formatErrorResponse('path is required', op);
        const ext = path.extname(filePath).toLowerCase();
        const format = args.format ? String(args.format).toUpperCase() : ({ '.jpg': 'JPG', '.jpeg': 'JPG', '.png': 'PNG' })[ext];
        if (format !== 'JPG' && format !== 'PNG') return formatErrorResponse('format must be JPG or PNG (or use a .jpg/.png path)', op);
        const resolution = Number(dpi);
        if (!Number.isFinite(resolution) || resolution < 1 || resolution > 2400) return formatErrorResponse('dpi must be between 1 and 2400', op);
        if (pageIndex !== undefined && pageIndex !== null && (!Number.isInteger(Number(pageIndex)) || Number(pageIndex) < 0)) {
            return formatErrorResponse('pageIndex must be a non-negative integer', op);
        }
        // Bridge und InDesign laufen auf demselben Rechner → Zielordner hier prüfen, InDesign meldet nur einen generischen Fehler
        const absPath = path.resolve(filePath);
        if (!fs.existsSync(path.dirname(absPath))) return formatErrorResponse(`Directory does not exist: ${path.dirname(absPath)}`, op);

        const prefsObj = format === 'JPG' ? 'app.jpegExportPreferences' : 'app.pngExportPreferences';
        const prefsSetup = format === 'JPG'
            ? `{
                    jpegExportRange: ExportRangeOrAllPages.EXPORT_RANGE,
                    pageString,
                    exportingSpread: false,
                    exportResolution: ${resolution},
                    jpegColorSpace: JpegColorSpaceEnum.RGB,
                    jpegQuality: JPEGOptionsQuality.MAXIMUM,
                    embedColorProfile: true,
                    antiAlias: true,
                    useDocumentBleeds: ${!!includeBleed},
                    simulateOverprint: ${!!simulateOverprint},
                }`
            : `{
                    pngExportRange: ExportRangeOrAllPages.EXPORT_RANGE,
                    pageString,
                    exportingSpread: false,
                    exportResolution: ${resolution},
                    pngColorSpace: PNGColorSpaceEnum.RGB,
                    pngQuality: PNGQualityEnum.MAXIMUM,
                    transparentBackground: ${!!transparentBackground},
                    antiAlias: true,
                    useDocumentBleeds: ${!!includeBleed},
                    simulateOverprint: ${!!simulateOverprint},
                }`;

        const code = `
            const { ExportFormat, ExportRangeOrAllPages, JpegColorSpaceEnum, JPEGOptionsQuality, PNGColorSpaceEnum, PNGQualityEnum } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const layer = doc.layers.itemByName(${JSON.stringify(layerName)});
            if (!layer.isValid) return { success: false, error: 'Layer not found: ' + ${JSON.stringify(layerName)} };

            let pageOffset = ${pageIndex !== undefined && pageIndex !== null ? Number(pageIndex) : 'null'};
            if (pageOffset === null) {
                // Erste Dokumentseite mit Objekten dieser Ebene (Musterseiten zählen nicht)
                const items = layer.allPageItems;
                for (let i = 0; i < items.length; i++) {
                    const p = items[i].parentPage;
                    if (p && p.parent.constructor.name === 'Spread' && (pageOffset === null || p.documentOffset < pageOffset)) pageOffset = p.documentOffset;
                }
                if (pageOffset === null) return { success: false, error: 'Layer has no items on document pages; pass pageIndex explicitly' };
            }
            if (pageOffset >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(pageOffset);
            // "+n" adressiert die absolute Seitennummer, unabhängig von Abschnitten
            const pageString = '+' + (pageOffset + 1);

            const prefs = ${prefsObj};
            const wanted = ${prefsSetup};
            const savedPrefs = {};
            for (const k of Object.keys(wanted)) { try { savedPrefs[k] = prefs[k]; } catch (e) {} }
            const savedVisibility = [];
            for (let i = 0; i < doc.layers.length; i++) {
                const l = doc.layers.item(i);
                savedVisibility.push([l, l.visible]);
            }
            try {
                for (const [l] of savedVisibility) l.visible = l.id === layer.id;
                for (const k of Object.keys(wanted)) prefs[k] = wanted[k];
                await doc.exportFile(ExportFormat.${format === 'JPG' ? 'JPG' : 'PNG_FORMAT'}, ${JSON.stringify(absPath)}, false);
            } finally {
                for (const [l, v] of savedVisibility) { try { l.visible = v; } catch (e) {} }
                for (const k of Object.keys(savedPrefs)) { try { prefs[k] = savedPrefs[k]; } catch (e) {} }
            }
            return {
                success: true,
                path: ${JSON.stringify(absPath)},
                format: ${JSON.stringify(format)},
                layer: layer.name,
                pageIndex: pageOffset,
                pageName: page.name,
                dpi: ${resolution},
                colorSpace: 'RGB',
                rgbProfile: doc.rgbProfile,
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        if (!result?.success) return formatErrorResponse(result?.error || 'Failed to export layer preview', op);
        if (!fs.existsSync(absPath)) return formatErrorResponse(`InDesign reported success but no file was written at ${absPath}`, op);
        return formatResponse({ ...result, bytes: fs.statSync(absPath).size }, op);
    }
}
