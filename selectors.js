'use strict';

/*
 * Selector definitions.
 *
 * Rules:
 * 1. First selector = primary.
 * 2. Remaining selectors = fallbacks.
 * 3. A selector is valid ONLY when count() === 1.
 * 4. Never click a selector matching 0 or 2+ elements.
 *
 * Do not add XPath here.
 */

const CART_ADD_TO_CART = [
    {
        name: 'primary',
        selector:
            "[data-id='sticky-footer-container'] div:has(> svg [clip-path*='AddToCart'])"
    },

    {
        name: 'fallback 1',
        selector:
            "[data-id='sticky-footer-container'] div:has(> svg path[d^='M17 18.375'])"
    }
];

/*
 * Cart → Remove product
 *
 * Only the selector supplied so far is included.
 */
const CART_REMOVE = [
    {
        name: 'primary',
        selector:
            "div:text-is('Remove')"
    }
];

/*
 * Challenge selectors will be added here later.
 *
 * Example structure:
 *
 * const CHALLENGES = {
 *     challengeCard: [
 *         {
 *             name: 'primary',
 *             selector: 'YOUR_SELECTOR'
 *         },
 *         {
 *             name: 'fallback 1',
 *             selector: 'YOUR_FALLBACK'
 *         }
 *     ],
 *
 *     taskButton: [
 *         ...
 *     ]
 * };
 */

module.exports = {
    CART_ADD_TO_CART,
    CART_REMOVE
};