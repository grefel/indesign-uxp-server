/**
 * Export handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse, escapeJsxString } from '../utils/stringUtils.js';

export class ExportHandlers {
    /**
     * Export document to PDF
     */
    static async exportPDF(args) {
        const {
            filePath,
            pages = 'all',
            quality = 'PRINT',
            includeBleed = false,
            includeMarks = false,
        } = args;

        // Built-in InDesign preset names guaranteed present across versions.
        const presetMap = {
            PRESS: '[Press Quality]',
            PRINT: '[High Quality Print]',
            SCREEN: '[Smallest File Size]',
            DIGITAL: '[High Quality Print]',
        };
        const preset = presetMap[quality] || presetMap.PRINT;
        const pageRange = pages === 'all' ? 'All' : pages;

        const code = `
            const { ExportFormat } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            try {
                // L6: pageRange/bleed/marks live on app.pdfExportPreferences, not the
                // exportFile() call itself — must be set before every export or InDesign
                // silently reuses whatever range was last used (often just page 1).
                app.pdfExportPreferences.pageRange = ${JSON.stringify(pageRange)};
                app.pdfExportPreferences.useDocumentBleedWithPDF = ${JSON.stringify(includeBleed)};
                app.pdfExportPreferences.cropMarks = ${JSON.stringify(includeMarks)};
                await doc.exportFile(ExportFormat.pdfType, ${JSON.stringify(filePath)}, false, ${JSON.stringify(preset)});
                return { success: true, message: 'PDF exported to ' + ${JSON.stringify(filePath)}, pages: ${JSON.stringify(pageRange)} };
            } catch(e) {
                return { success: false, error: 'Export failed: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Export PDF") :
            formatErrorResponse(result?.error || 'Failed to export PDF', "Export PDF");
    }

    /**
     * Export pages as images
     */
    static async exportImages(args) {
        const {
            folderPath,
            format = 'JPEG',
            quality = 80,
            resolution = 300,
            pageRange = 'all'
        } = args;

        const formatLower = format.toLowerCase();

        // M4: validate pageRange entries before sending to UXP — invalid entries were
        // silently skipped, returning a count lower than expected with no error reported
        if (pageRange !== 'all') {
            const entries = pageRange.split(',');
            const invalid = entries.filter(p => {
                const n = parseInt(p.trim(), 10);
                return isNaN(n) || n < 1;
            });
            if (invalid.length > 0) {
                return formatErrorResponse(
                    `Invalid page range entries (must be positive integers): ${invalid.join(', ')}`,
                    "Export Images"
                );
            }
        }

        const code = `
            const { ExportFormat } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            const folder = ${JSON.stringify(folderPath)};

            try {
                const formatStr = ${JSON.stringify(format)};
                // UXP kennt nur JPG und PNG_FORMAT als Bildexport; TIFF gibt es in ExportFormat nicht.
                // Die app-weiten Farbraum-Vorgaben können auf GRAY stehen → RGB erzwingen.
                const { ExportRangeOrAllPages, PNGColorSpaceEnum, JpegColorSpaceEnum, JPEGOptionsQuality } = require('indesign');
                let exportFormat, prefs;
                if (formatStr === 'PNG') {
                    exportFormat = ExportFormat.PNG_FORMAT;
                    prefs = app.pngExportPreferences;
                    prefs.pngExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
                    prefs.pngColorSpace = PNGColorSpaceEnum.RGB;
                } else if (formatStr === 'TIFF') {
                    return { success: false, error: 'TIFF export is not supported by the InDesign UXP API; use JPEG or PNG' };
                } else {
                    exportFormat = ExportFormat.JPG;
                    prefs = app.jpegExportPreferences;
                    prefs.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
                    prefs.jpegColorSpace = JpegColorSpaceEnum.RGB;
                    const q = ${Number(quality) || 80};
                    prefs.jpegQuality = q >= 90 ? JPEGOptionsQuality.MAXIMUM : q >= 70 ? JPEGOptionsQuality.HIGH : q >= 40 ? JPEGOptionsQuality.MEDIUM : JPEGOptionsQuality.LOW;
                }
                prefs.exportResolution = ${Number(resolution) || 300};
                prefs.exportingSpread = false;

                const ext = ${JSON.stringify(formatLower)};
                const pageRangeStr = ${JSON.stringify(pageRange)};
                const indices = pageRangeStr === 'all'
                    ? Array.from({ length: doc.pages.length }, (_, i) => i)
                    : pageRangeStr.split(',').map(p => parseInt(p, 10) - 1).filter(i => i >= 0 && i < doc.pages.length);
                let exportedCount = 0;
                // Page hat kein exportFile() → Dokument-Export mit absoluter Seitenangabe "+n"
                for (const i of indices) {
                    prefs.pageString = '+' + (i + 1);
                    await doc.exportFile(exportFormat, folder + '/page_' + (i + 1) + '.' + ext, false);
                    exportedCount++;
                }

                return { success: true, count: exportedCount };
            } catch(e) {
                return { success: false, error: 'Error exporting images: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(`${result.count} pages exported as ${format} images to: ${folderPath}`, "Export Images") :
            formatErrorResponse(result?.error || 'Failed to export images', "Export Images");
    }

    /**
     * Package document for printing
     */
    static async packageDocument(args) {
        const { folderPath, includeFonts = true, includeLinks = true, includeProfiles = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;

            try {
                doc.packageForPrint(
                    ${JSON.stringify(folderPath)},
                    ${includeFonts},
                    ${includeLinks},
                    ${includeProfiles},
                    false,
                    false,
                    true
                );
                return { success: true };
            } catch(e) {
                return { success: false, error: 'Error packaging document: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(`Document packaged successfully to: ${folderPath}`, "Package Document") :
            formatErrorResponse(result?.error || 'Failed to package document', "Package Document");
    }
} 