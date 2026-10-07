/**
 * UXP-Snippets für Textrahmen-Messungen, gemeinsam genutzt von textMetricsHandlers
 * und layoutModelHandlers.
 */
import { findItemByIdSnippet } from './itemUtils.js';

/**
 * In-script helpers shared by all text metric tools. Line properties are read
 * via everyItem() so long frames cost one bridge round trip per property
 * instead of one per line. ascent/descent/baseline follow the vertical
 * measurement unit (pinned to mm by the caller).
 */
export const TEXT_HELPERS = `
            const __r = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
            const __arr = v => (Array.isArray(v) ? v : [v]);
            function __readLines(frame) {
                const L = frame.lines;
                const n = L.length;
                if (!n) return [];
                const ev = L.everyItem();
                const contents = __arr(ev.contents), baseline = __arr(ev.baseline),
                      ascent = __arr(ev.ascent), descent = __arr(ev.descent),
                      x1 = __arr(ev.horizontalOffset), x2 = __arr(ev.endHorizontalOffset),
                      size = __arr(ev.pointSize), leading = __arr(ev.leading);
                const texts = contents.map(c => String(c));
                const lines = [];
                for (let i = 0; i < n; i++) {
                    const raw = texts[i];
                    const paragraphEnd = /\\r$/.test(raw);
                    const forcedBreak = /\\n$/.test(raw);
                    const text = raw.replace(/[\\r\\n]$/, '');
                    // Zeile endet mitten im Wort und die nächste beginnt mit einem Buchstaben → Silbentrennung
                    const hyphenated = !paragraphEnd && !forcedBreak && i + 1 < n
                        && /\\p{L}$/u.test(text) && /^\\p{L}/u.test(texts[i + 1]);
                    lines.push({
                        index: i,
                        contents: text,
                        baseline: __r(baseline[i]),
                        ascent: __r(ascent[i]),
                        descent: __r(descent[i]),
                        top: __r(baseline[i] - ascent[i]),
                        bottom: __r(baseline[i] + descent[i]),
                        x: __r(x1[i]),
                        width: __r(x2[i] - x1[i]),
                        pointSize: typeof size[i] === 'number' ? __r(size[i]) : 'mixed',
                        leading: typeof leading[i] === 'number' ? __r(leading[i]) : 'auto',
                        paragraphEnd,
                        forcedBreak,
                        hyphenated,
                    });
                }
                return lines;
            }
            function __textBlock(frame, lines) {
                const gb = frame.geometricBounds;
                const inset = frame.textFramePreferences.insetSpacing;
                const insetBottom = Array.isArray(inset) ? inset[2] : inset;
                if (!lines.length) return null;
                const first = lines[0], last = lines[lines.length - 1];
                return {
                    top: first.top,
                    firstBaseline: first.baseline,
                    lastBaseline: last.baseline,
                    bottom: last.bottom,
                    maxLineWidth: __r(Math.max(...lines.map(l => l.width))),
                    spaceBelowLastBaseline: __r(gb[2] - insetBottom - last.baseline),
                    spaceBelowDescender: __r(gb[2] - insetBottom - last.bottom),
                };
            }
            function __oversetInfo(frame) {
                const story = frame.parentStory;
                const containers = story.textContainers;
                let shown = 0;
                for (let i = 0; i < containers.length; i++) shown += containers[i].characters.length;
                const oversetCharacters = Math.max(0, story.characters.length - shown);
                return { storyOverset: oversetCharacters > 0, oversetCharacters, frameOverflows: frame.overflows };
            }
            function __frameInfo(frame) {
                const tfp = frame.textFramePreferences;
                const gb = frame.geometricBounds;
                return {
                    geometricBounds: gb.map(__r),
                    width: __r(gb[3] - gb[1]),
                    height: __r(gb[2] - gb[0]),
                    insetSpacing: __arr(tfp.insetSpacing).map(__r),
                    columnCount: tfp.textColumnCount,
                    firstBaselineOffset: String(tfp.firstBaselineOffset),
                    verticalJustification: String(tfp.verticalJustification),
                    autoSizingType: String(tfp.autoSizingType),
                    previousTextFrameId: frame.previousTextFrame ? frame.previousTextFrame.id : null,
                    nextTextFrameId: frame.nextTextFrame ? frame.nextTextFrame.id : null,
                };
            }
`;

export function resolveTextFrameSnippet(itemId) {
    return `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            ${findItemByIdSnippet('frame', itemId)}
            if (!frame) return { success: false, error: 'No page item with id ${itemId}' };
            if (frame.constructor.name !== 'TextFrame') {
                return { success: false, error: 'Item ${itemId} is a ' + frame.constructor.name + ', expected a TextFrame' };
            }
    `;
}
