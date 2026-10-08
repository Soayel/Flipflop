'use strict';

require('dotenv').config();

const { chromium, devices } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const {
    CART_REMOVE,
    CART_ADD_TO_CART
} = require('./selectors');

const CONFIG = {
    baseUrl: process.env.BASE_URL || 'https://www.flipkart.com',
    cartUrl: process.env.CART_URL || 'https://www.flipkart.com/viewcart',

    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedChatId: process.env.TELEGRAM_CHAT_ID || null,

    headless: process.env.HEADLESS !== 'false',

    sessionDir: path.resolve(
        process.env.SESSION_DIR || './session'
    ),

    navigationTimeout:
        Number(process.env.NAVIGATION_TIMEOUT || 30000),

    actionTimeout:
        Number(process.env.ACTION_TIMEOUT || 10000),

    maxCartRemovals:
        Number(process.env.MAX_CART_REMOVALS || 500)
};

if (!CONFIG.telegramToken) {
    throw new Error(
        'TELEGRAM_BOT_TOKEN is missing from .env'
    );
}

const bot = new TelegramBot(
    CONFIG.telegramToken,
    { polling: true }
);

let browser = null;
let context = null;
let page = null;

const loginState = new Map();

/* -------------------------------------------------------
 * Logging
 * ----------------------------------------------------- */

function timestamp() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${timestamp()}]`, ...args);
}

function warn(...args) {
    console.warn(`[${timestamp()}] WARNING:`, ...args);
}

function error(...args) {
    console.error(`[${timestamp()}] ERROR:`, ...args);
}

/* -------------------------------------------------------
 * Telegram helpers
 * ----------------------------------------------------- */

function isAllowed(chatId) {
    if (!CONFIG.allowedChatId) {
        return true;
    }

    return String(chatId) === String(CONFIG.allowedChatId);
}

async function telegramAlert(message) {
    try {
        if (CONFIG.allowedChatId) {
            await bot.sendMessage(
                CONFIG.allowedChatId,
                `⚠️ Axiom alert\n\n${message}`
            );
        }
    } catch (err) {
        error('Unable to send Telegram alert:', err.message);
    }
}

/* -------------------------------------------------------
 * Browser
 * ----------------------------------------------------- */

async function startBrowser() {
    if (browser && context && page) {
        return;
    }

    log('Starting Chromium in Android mode...');

    browser = await chromium.launch({
        headless: CONFIG.headless
    });

    /*
     * Pixel 5 is used as the Android device profile.
     *
     * This gives the page:
     * - Android viewport
     * - Android user agent
     * - mobile screen characteristics
     * - device scale factor
     * - touch support
     */
    context = await browser.newContext({
        ...devices['Pixel 5'],

        storageState: fs.existsSync(
            path.join(CONFIG.sessionDir, 'storage-state.json')
        )
            ? path.join(CONFIG.sessionDir, 'storage-state.json')
            : undefined
    });

    context.setDefaultTimeout(CONFIG.actionTimeout);
    context.setDefaultNavigationTimeout(
        CONFIG.navigationTimeout
    );

    page = await context.newPage();

    page.on('pageerror', async err => {
        await telegramAlert(
            `Page JavaScript error:\n${err.message}`
        );
    });

    page.on('crash', async () => {
        await telegramAlert(
            'Playwright page crashed.'
        );
    });

    log('Android browser ready.');
}

async function saveSession() {
    if (!context) return;

    fs.mkdirSync(CONFIG.sessionDir, {
        recursive: true
    });

    await context.storageState({
        path: path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        )
    });

    log('Session saved.');
}

async function closeBrowser() {
    try {
        if (context) {
            await saveSession();
        }

        if (browser) {
            await browser.close();
        }
    } finally {
        browser = null;
        context = null;
        page = null;
    }
}

/* -------------------------------------------------------
 * Selector engine
 *
 * IMPORTANT:
 * - locator() only
 * - no XPath
 * - no page.$
 * - exactly one element required
 * - fallback in declared order
 * ----------------------------------------------------- */

async function resolveSelector(
    locator,
    selectorDefinitions,
    description
) {
    for (let i = 0; i < selectorDefinitions.length; i++) {
        const definition =
            selectorDefinitions[i];

        const selector =
            typeof definition === 'string'
                ? definition
                : definition.selector;

        const label =
            typeof definition === 'string'
                ? i === 0
                    ? 'primary'
                    : `fallback ${i}`
                : definition.name ||
                  (i === 0
                      ? 'primary'
                      : `fallback ${i}`);

        let count = 0;

        try {
            count = await locator(selector).count();
        } catch (err) {
            warn(
                `${description}: selector "${selector}" threw: ${err.message}`
            );

            continue;
        }

        if (count === 1) {
            if (i > 0) {
                warn(
                    `${description}: primary selector failed; using ${label}.`
                );
            }

            return {
                selector,
                locator: locator(selector),
                label
            };
        }

        if (count === 0) {
            warn(
                `${description}: ${label} matched 0 elements.`
            );
        } else {
            warn(
                `${description}: ${label} matched ${count} elements; refusing to click.`
            );
        }
    }

    return null;
}

/* -------------------------------------------------------
 * Safe click
 * ----------------------------------------------------- */

async function safeClick(
    targetPage,
    selectorDefinitions,
    description
) {
    const resolved = await resolveSelector(
        targetPage.locator.bind(targetPage),
        selectorDefinitions,
        description
    );

    if (!resolved) {
        const message =
            `No valid selector found for:\n${description}`;

        error(message);

        await telegramAlert(message);

        return false;
    }

    try {
        await resolved.locator.click({
            timeout: CONFIG.actionTimeout
        });

        log(
            `${description}: clicked using ${resolved.label}.`
        );

        return true;
    } catch (err) {
        const message =
            `${description}: click failed.\n${err.message}`;

        error(message);

        await telegramAlert(message);

        return false;
    }
}

/* -------------------------------------------------------
 * Cart
 * ----------------------------------------------------- */

async function openCart() {
    await page.goto(CONFIG.cartUrl, {
        waitUntil: 'domcontentloaded'
    });

    await page.waitForLoadState('networkidle')
        .catch(() => {});

    log(`Cart opened: ${page.url()}`);
}

async function cartRemoveButtonCount() {
    return await page
        .locator(CART_REMOVE[0].selector)
        .count()
        .catch(() => 0);
}

/*
 * Remove products until the Remove selector no longer exists.
 *
 * Because the page dynamically changes after every removal,
 * the selector is resolved again on every iteration.
 */
async function removeAllCartProducts() {
    await startBrowser();
    await openCart();

    let removed = 0;

    for (
        let iteration = 1;
        iteration <= CONFIG.maxCartRemovals;
        iteration++
    ) {
        log(
            `Cart removal iteration ${iteration}`
        );

        const removeButton =
            await resolveSelector(
                page.locator.bind(page),
                CART_REMOVE,
                'Cart → Remove product'
            );

        /*
         * No Remove button means the cart is currently empty
         * or the UI has changed.
         */
        if (!removeButton) {
            const remaining =
                await page
                    .locator('div:text-is("Remove")')
                    .count()
                    .catch(() => 0);

            if (remaining === 0) {
                log(
                    `Cart cleanup finished. Removed: ${removed}`
                );

                await bot.sendMessage(
                    CONFIG.allowedChatId ||
                    '',
                    `✅ Cart cleanup finished.\nRemoved: ${removed}`
                ).catch(() => {});

                return {
                    success: true,
                    removed
                };
            }

            return {
                success: false,
                removed,
                reason:
                    'Remove selector could not be resolved.'
            };
        }

        try {
            await removeButton.locator.click();

            removed++;

            log(
                `Remove clicked. Total removed: ${removed}`
            );
        } catch (err) {
            await telegramAlert(
                `Cart removal click failed:\n${err.message}`
            );

            return {
                success: false,
                removed,
                reason: err.message
            };
        }

        /*
         * Wait for the DOM to update.
         * Do not assume a fixed delay is enough.
         */
        try {
            await page.waitForFunction(
                previousCount => {
                    const elements =
                        document.querySelectorAll(
                            'div'
                        );

                    /*
                     * This is only a stabilization delay
                     * condition. The actual selector
                     * validation remains Playwright locator()
                     * based.
                     */
                    return elements.length > 0;
                },
                await page.locator('div').count(),
                {
                    timeout: 3000
                }
            );
        } catch {
            // The DOM may still be changing; next loop
            // re-resolves the selector anyway.
        }

        await page.waitForTimeout(300);
    }

    const message =
        `Cart cleanup stopped after reaching MAX_CART_REMOVALS=${CONFIG.maxCartRemovals}.`;

    await telegramAlert(message);

    return {
        success: false,
        removed,
        reason: 'Maximum removal limit reached.'
    };
}

/* -------------------------------------------------------
 * Login menu
 * ----------------------------------------------------- */

function loginKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🔐 OTP Login',
                        callback_data: 'login_otp'
                    }
                ],
                [
                    {
                        text: '📄 JSON Login',
                        callback_data: 'login_json'
                    }
                ]
            ]
        }
    };
}

function mainKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🛒 View Wishlist',
                        callback_data: 'wishlist'
                    }
                ],
                [
                    {
                        text: '🧹 Remove Cart Products',
                        callback_data: 'remove_cart'
                    }
                ],
                [
                    {
                        text: '🏆 Complete Challenges',
                        callback_data: 'complete_challenges'
                    }
                ],
                [
                    {
                        text: '🔄 Delete/Login New Account',
                        callback_data: 'new_login'
                    }
                ]
            ]
        }
    };
}

/* -------------------------------------------------------
 * Login handling
 * ----------------------------------------------------- */

async function beginOtpLogin(chatId) {
    loginState.set(chatId, {
        type: 'otp',
        stage: 'waiting_phone'
    });

    await bot.sendMessage(
        chatId,
        'Send the login phone number.'
    );
}

async function beginJsonLogin(chatId) {
    loginState.set(chatId, {
        type: 'json',
        stage: 'waiting_json'
    });

    await bot.sendMessage(
        chatId,
        'Send the JSON login/session data.'
    );
}

/*
 * OTP itself is deliberately entered by the user.
 * The browser can navigate to the login page and wait
 * for the user-provided OTP.
 */
async function finishOtpLogin(chatId, phone) {
    await startBrowser();

    await page.goto(CONFIG.baseUrl, {
        waitUntil: 'domcontentloaded'
    });

    loginState.set(chatId, {
        type: 'otp',
        stage: 'waiting_otp',
        phone
    });

    await bot.sendMessage(
        chatId,
        'Login page opened. Send the OTP here.'
    );
}

async function finishOtpCode(chatId, otp) {
    /*
     * Login-page selectors were not supplied yet.
     * This intentionally stops instead of guessing selectors.
     */
    await telegramAlert(
        `OTP received for chat ${chatId}, but login-page selectors are not configured yet.`
    );

    await bot.sendMessage(
        chatId,
        'OTP received, but the login selectors still need to be configured.'
    );
}

/* -------------------------------------------------------
 * JSON session
 * ----------------------------------------------------- */

async function useJsonSession(chatId, jsonText) {
    let parsed;

    try {
        parsed = JSON.parse(jsonText);
    } catch {
        await bot.sendMessage(
            chatId,
            '❌ Invalid JSON.'
        );
        return;
    }

    fs.mkdirSync(CONFIG.sessionDir, {
        recursive: true
    });

    const sessionPath =
        path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        );

    fs.writeFileSync(
        sessionPath,
        JSON.stringify(parsed, null, 2),
        'utf8'
    );

    await closeBrowser();
    await startBrowser();

    await bot.sendMessage(
        chatId,
        '✅ JSON session loaded.'
    );

    await showMainMenu(chatId);
}

/* -------------------------------------------------------
 * Account reset
 * ----------------------------------------------------- */

async function deleteLoginSession(chatId) {
    await closeBrowser();

    const sessionPath =
        path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        );

    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, {
            force: true
        });
    }

    loginState.delete(chatId);

    await bot.sendMessage(
        chatId,
        'Login session deleted.'
    );

    await bot.sendMessage(
        chatId,
        'Choose a new login method:',
        loginKeyboard()
    );
}

/* -------------------------------------------------------
 * Main menu
 * ----------------------------------------------------- */

async function showMainMenu(chatId) {
    await bot.sendMessage(
        chatId,
        'Select an operation:',
        mainKeyboard()
    );
}

/* -------------------------------------------------------
 * Telegram commands
 * ----------------------------------------------------- */

bot.onText(/^\/start$/, async msg => {
    const chatId = msg.chat.id;

    if (!isAllowed(chatId)) {
        await bot.sendMessage(
            chatId,
            'Unauthorized.'
        );
        return;
    }

    await bot.sendMessage(
        chatId,
        'Choose login method:',
        loginKeyboard()
    );
});

/* -------------------------------------------------------
 * Callback buttons
 * ----------------------------------------------------- */

bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const action = query.data;

    if (!isAllowed(chatId)) {
        return;
    }

    await bot.answerCallbackQuery(
        query.id
    ).catch(() => {});

    try {
        switch (action) {

            case 'login_otp':
                await beginOtpLogin(chatId);
                break;

            case 'login_json':
                await beginJsonLogin(chatId);
                break;

            case 'wishlist':
                await bot.sendMessage(
                    chatId,
                    'Wishlist module is waiting for its selectors.'
                );
                break;

            case 'remove_cart':
                await bot.sendMessage(
                    chatId,
                    '🧹 Starting cart cleanup...'
                );

                await removeAllCartProducts();

                await showMainMenu(chatId);
                break;

            case 'complete_challenges':
                await bot.sendMessage(
                    chatId,
                    'Challenge module is waiting for the challenge/task/product selectors.'
                );
                break;

            case 'new_login':
                await deleteLoginSession(chatId);
                break;

            default:
                warn(
                    `Unknown callback: ${action}`
                );
        }

    } catch (err) {
        error(err);

        await telegramAlert(
            `Unhandled operation error:\n${err.stack || err.message}`
        );
    }
});

/* -------------------------------------------------------
 * Text messages
 * ----------------------------------------------------- */

bot.on('message', async msg => {
    const chatId = msg.chat.id;

    if (!isAllowed(chatId)) {
        return;
    }

    if (!msg.text || msg.text.startsWith('/')) {
        return;
    }

    const state = loginState.get(chatId);

    if (!state) {
        return;
    }

    try {
        if (
            state.type === 'otp' &&
            state.stage === 'waiting_phone'
        ) {
            await finishOtpLogin(
                chatId,
                msg.text.trim()
            );

            return;
        }

        if (
            state.type === 'otp' &&
            state.stage === 'waiting_otp'
        ) {
            await finishOtpCode(
                chatId,
                msg.text.trim()
            );

            return;
        }

        if (
            state.type === 'json' &&
            state.stage === 'waiting_json'
        ) {
            await useJsonSession(
                chatId,
                msg.text.trim()
            );

            return;
        }

    } catch (err) {
        error(err);

        await telegramAlert(
            `Login error:\n${err.stack || err.message}`
        );
    }
});

/* -------------------------------------------------------
 * Shutdown
 * ----------------------------------------------------- */

async function shutdown(signal) {
    log(`${signal} received.`);

    try {
        await closeBrowser();
    } finally {
        process.exit(0);
    }
}

process.once(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.once(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'unhandledRejection',
    async reason => {
        error(
            'Unhandled rejection:',
            reason
        );

        await telegramAlert(
            `Unhandled rejection:\n${reason?.stack || reason}`
        );
    }
);

log('Telegram bot started.');