/**
 * Helpers for addressing page items by their stable InDesign id
 * (as returned by list_page_items / get_page_item_info).
 */

/**
 * Validates an item id in Node before it is interpolated into UXP code.
 * @param {any} value
 * @param {string} [label='itemId']
 * @returns {number}
 */
export function parseItemId(value, label = 'itemId') {
    const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`${label} must be a positive integer, got: ${JSON.stringify(value)}`);
    }
    return id;
}

/**
 * UXP snippet binding `varName` to the page item with the given id, or null.
 * doc.pageItems.itemByID() only sees top-level items; grouped items and
 * placed graphics are found via doc.allPageItems. `doc` must be in scope.
 * @param {string} varName - valid, unique identifier in the surrounding scope
 * @param {number} itemId - already validated via parseItemId
 */
export function findItemByIdSnippet(varName, itemId) {
    return `
            const ${varName} = (() => {
                try {
                    const c = doc.pageItems.itemByID(${itemId});
                    if (c.isValid) return c.getElements()[0];
                } catch (e) {}
                const all = doc.allPageItems;
                for (let i = 0; i < all.length; i++) {
                    if (all[i].id === ${itemId}) return all[i];
                }
                return null;
            })();
    `;
}
