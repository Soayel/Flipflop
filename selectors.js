'use strict';

/*
 * Keep selectors exactly as supplied by the user.
 * Add verified selectors for the currently blank sections when available.
 */
module.exports = {
  cart: {
    // Supplied primary selector; do not simplify or rewrite.
    removePrimary: "div:text-is('Remove')",
    // Supplied fallback selector; do not simplify or rewrite.
    removeFallbacks: [
      "div:has(> div > svg path[d^='M216 56H40'])"
    ]
  },

  product: {
    // Supplied by the user for the sticky footer Add to Cart icon.
    addToCartPrimary:
      "[data-id='sticky-footer-container'] div:has(> svg [clip-path*='AddToCart'])",
    addToCartFallbacks: [
      "[data-id='sticky-footer-container'] div:has(> svg path[d^='M17 18.375'])"
    ]
  },

  wishlist: {
    // Not supplied yet. Configure via .env after inspecting the page.
    itemSelectorEnv: "WISHLIST_ITEM_SELECTOR",
    removeSelectorEnv: "WISHLIST_REMOVE_SELECTOR"
  },

  login: {
    // Not supplied yet. Configure via .env.
    openSelectorEnv: "LOGIN_OPEN_SELECTOR",
    identifierSelectorEnv: "LOGIN_IDENTIFIER_SELECTOR",
    sendOtpSelectorEnv: "LOGIN_SEND_OTP_SELECTOR",
    otpInputSelectorEnv: "LOGIN_OTP_INPUT_SELECTOR",
    verifyOtpSelectorEnv: "LOGIN_VERIFY_OTP_SELECTOR"
  },

  challenges: {
    // Intentionally unconfigured until challenge/task/product selectors are provided.
    challengeCard: "",
    taskCard: "",
    taskOpenButton: "",
    productCard: "",
    shareButton: "",
    wishlistButton: "",
    addToCartButton: ""
  }
};
