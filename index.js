'use strict';

require('dotenv').config();

const {
    chromium,
    devices
} = require('playwright');

const TelegramBot =
    require('node-telegram-bot-api');

const fs = require('fs');
const path = require('path');

const {
    CART_REMOVE,
    CART_ADD_TO_CART
} = require('./selectors');

const CONFIG = {
    baseUrl: process.env.BASE_URL || 'https://www.gulok.com',
    cartUrl: process.env.CART_URL || 'https://www.flipkart.com/viewcart',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedChatId: process.env.TELEGRAM_CHAT_ID || null,
    headless: process.env.HEADLESS !== 'false',
    sessionDir: path.resolve(
        process.env.SESSION_DIR || './session'
    ),
    navigationTimeout: Number(
        process.env.NAVIGATION_TIMEOUT || 30000
    ),
    actionTimeout: Number(
        process.env.ACTION_TIMEOUT || 10000
    ),
    maxCartRemovals: Number(
        process.env.MAX_CART_REMOVALS || 500
    )
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

function timestamp() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${timestamp()}]`, ...args);
}

function warn(...args) {
    console.warn(
        `[${timestamp()}] WARNING:`,
        ...args
    );
}

function error(...args) {
    console.error(
        `[${timestamp()}] ERROR:`,
        ...args
    );
}

function isAllowed(chatId) {
    if (!CONFIG.allowedChatId) return true;

    return String(chatId) ===
        String(CONFIG.allowedChatId);
}

async function telegramAlert(message) {
    try {
        if (!CONFIG.allowedChatId) {
            warn(
                'TELEGRAM_CHAT_ID is not configured; alert:',
                message
            );
            return;
        }

        await bot.sendMessage(
            CONFIG.allowedChatId,
            `⚠️ Axiom alert\n\n${message}`
        );
    } catch (err) {
        error(
            'Unable to send Telegram alert:',
            err.message
        );
    }
}

/* =========================================================
   BROWSER
   ========================================================= */

async function startBrowser() {
    if (browser && context && page) {
        return;
    }

    log(
        'Starting Chromium in Android mode...'
    );

    fs.mkdirSync(
        CONFIG.sessionDir,
        { recursive: true }
    );

    const sessionPath = path.join(
        CONFIG.sessionDir,
        'storage-state.json'
    );

    let storageState;

    if (fs.existsSync(sessionPath)) {
        try {
            const raw = fs.readFileSync(
                sessionPath,
                'utf8'
            );

            storageState = JSON.parse(raw);

            log(
                'Existing Playwright session found.'
            );
        } catch (err) {
            warn(
                'Existing storage-state.json could not be parsed:',
                err.message
            );

            storageState = undefined;
        }
    }

    browser = await chromium.launch({
        headless: CONFIG.headless
    });

    const contextOptions = {
        ...devices['Pixel 5']
    };

    if (storageState) {
        contextOptions.storageState =
            storageState;
    }

    context = await browser.newContext(
        contextOptions
    );

    context.setDefaultTimeout(
        CONFIG.actionTimeout
    );

    context.setDefaultNavigationTimeout(
        CONFIG.navigationTimeout
    );

    page = await context.newPage();

    page.on(
        'pageerror',
        async err => {
            error(
                'Page JavaScript error:',
                err.message
            );

            await telegramAlert(
                `Page JavaScript error:\n${err.message}`
            );
        }
    );

    page.on(
        'crash',
        async () => {
            error(
                'Playwright page crashed.'
            );

            await telegramAlert(
                'Playwright page crashed.'
            );
        }
    );

    log(
        'Android browser ready.'
    );
}

async function saveSession() {
    if (!context) return;

    fs.mkdirSync(
        CONFIG.sessionDir,
        { recursive: true }
    );

    await context.storageState({
        path: path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        )
    });

    log(
        'Playwright session saved.'
    );
}

async function closeBrowser() {
    try {
        if (context) {
            try {
                await saveSession();
            } catch (err) {
                warn(
                    'Could not save session:',
                    err.message
                );
            }
        }

        if (browser) {
            await browser.close();
        }
    } catch (err) {
        error(
            'Browser close error:',
            err.message
        );
    } finally {
        browser = null;
        context = null;
        page = null;
    }
}

/* =========================================================
   SELECTOR SYSTEM
   ========================================================= */

async function resolveSelector(
    locatorFunction,
    selectorDefinitions,
    description
) {
    for (
        let i = 0;
        i < selectorDefinitions.length;
        i++
    ) {
        const definition =
            selectorDefinitions[i];

        const selector =
            typeof definition === 'string'
                ? definition
                : definition.selector;

        const label =
            typeof definition === 'string'
                ? (
                    i === 0
                        ? 'primary'
                        : `fallback ${i}`
                )
                : (
                    definition.name ||
                    (
                        i === 0
                            ? 'primary'
                            : `fallback ${i}`
                    )
                );

        let count;

        try {
            const locator =
                locatorFunction(selector);

            count = await locator.count();
        } catch (err) {
            warn(
                `${description}: ${label} threw an error: ${err.message}`
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
                locator:
                    locatorFunction(selector),
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

async function safeClick(
    targetPage,
    selectorDefinitions,
    description
) {
    const resolved =
        await resolveSelector(
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

/* =========================================================
   CART
   ========================================================= */

async function openCart() {
    await page.goto(
        CONFIG.cartUrl,
        {
            waitUntil: 'domcontentloaded'
        }
    );

    await page
        .waitForLoadState('networkidle')
        .catch(() => {});

    log(
        `Cart opened: ${page.url()}`
    );
}

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

        if (!removeButton) {
            const remaining =
                await page
                    .locator("div:text-is('Remove')")
                    .count()
                    .catch(() => 0);

            if (remaining === 0) {
                log(
                    `Cart cleanup finished. Removed: ${removed}`
                );

                if (CONFIG.allowedChatId) {
                    await bot.sendMessage(
                        CONFIG.allowedChatId,
                        `✅ Cart cleanup finished.\n\nProducts removed: ${removed}`
                    );
                }

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
            await removeButton.locator.click({
                timeout:
                    CONFIG.actionTimeout
            });

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

        await page.waitForTimeout(500);
    }

    const message =
        `Cart cleanup stopped after reaching MAX_CART_REMOVALS=${CONFIG.maxCartRemovals}.`;

    await telegramAlert(message);

    return {
        success: false,
        removed,
        reason:
            'Maximum removal limit reached.'
    };
}

/* =========================================================
   TELEGRAM MENUS
   ========================================================= */

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
                        callback_data:
                            'complete_challenges'
                    }
                ],
                [
                    {
                        text:
                            '🔄 Delete/Login New Account',
                        callback_data:
                            'new_login'
                    }
                ]
            ]
        }
    };
}

async function showMainMenu(chatId) {
    await bot.sendMessage(
        chatId,
        'Select an operation:',
        mainKeyboard()
    );
}

/* =========================================================
   OTP LOGIN
   ========================================================= */

async function beginOtpLogin(chatId) {
    loginState.set(
        chatId,
        {
            type: 'otp',
            stage: 'waiting_phone'
        }
    );

    await bot.sendMessage(
        chatId,
        'Send the login phone number.'
    );
}

async function finishOtpLogin(
    chatId,
    phone
) {
    await startBrowser();

    await page.goto(
        CONFIG.baseUrl,
        {
            waitUntil: 'domcontentloaded'
        }
    );

    loginState.set(
        chatId,
        {
            type: 'otp',
            stage: 'waiting_otp',
            phone
        }
    );

    await bot.sendMessage(
        chatId,
        'Login page opened. Send the OTP here.'
    );
}

async function finishOtpCode(
    chatId,
    otp
) {
    await telegramAlert(
        `OTP received for chat ${chatId}, but login-page selectors are not configured yet.`
    );

    await bot.sendMessage(
        chatId,
        'OTP received. Login-page selectors still need to be configured.'
    );
}

/* =========================================================
   JSON LOGIN
   ========================================================= */

async function beginJsonLogin(chatId) {
    loginState.set(
        chatId,
        {
            type: 'json',
            stage: 'waiting_json'
        }
    );

    await bot.sendMessage(
        chatId,
        '📎 Send the Firefox cookie JSON or Playwright storage-state JSON as a .json file.\n\nThe bot will automatically detect and convert Firefox cookies.'
    );
}

/*
 * Detect Playwright storageState:
 *
 * {
 *   "cookies": [],
 *   "origins": []
 * }
 */

function isPlaywrightStorageState(data) {
    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
    ) {
        return false;
    }

    return (
        Array.isArray(data.cookies) ||
        Array.isArray(data.origins)
    );
}

/*
 * Detect a common Firefox cookie-export format:
 *
 * [
 *   {
 *      "name": "...",
 *      "value": "...",
 *      "domain": "...",
 *      "path": "/"
 *   }
 * ]
 *
 * Also supports:
 *
 * {
 *   "cookies": [...]
 * }
 */

function getFirefoxCookies(data) {
    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        typeof data === 'object' &&
        Array.isArray(data.cookies)
    ) {
        return data.cookies;
    }

    return null;
}

function convertFirefoxCookie(
    cookie
) {
    if (
        !cookie ||
        typeof cookie !== 'object'
    ) {
        return null;
    }

    if (
        typeof cookie.name !== 'string' ||
        typeof cookie.value !== 'string' ||
        typeof cookie.domain !== 'string'
    ) {
        return null;
    }

    const converted = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path:
            typeof cookie.path === 'string'
                ? cookie.path
                : '/',
        secure:
            Boolean(cookie.secure),
        httpOnly:
            Boolean(cookie.httpOnly)
    };

    /*
     * Firefox may provide expirationDate.
     * Playwright expects expires.
     */

    const expiration =
        cookie.expirationDate ??
        cookie.expires ??
        cookie.expiration;

    if (
        expiration !== undefined &&
        expiration !== null
    ) {
        const number =
            Number(expiration);

        if (
            Number.isFinite(number) &&
            number > 0
        ) {
            converted.expires = number;
        }
    }

    /*
     * Convert sameSite values.
     */

    if (
        typeof cookie.sameSite === 'string'
    ) {
        const sameSite =
            cookie.sameSite.toLowerCase();

        if (
            sameSite === 'strict'
        ) {
            converted.sameSite = 'Strict';
        } else if (
            sameSite === 'lax'
        ) {
            converted.sameSite = 'Lax';
        } else if (
            sameSite === 'none' ||
            sameSite === 'no_restriction'
        ) {
            converted.sameSite = 'None';
        }
    }

    return converted;
}

function convertFirefoxToPlaywright(
    data
) {
    const firefoxCookies =
        getFirefoxCookies(data);

    if (!firefoxCookies) {
        return null;
    }

    const cookies = [];

    for (
        const firefoxCookie
        of firefoxCookies
    ) {
        const converted =
            convertFirefoxCookie(
                firefoxCookie
            );

        if (converted) {
            cookies.push(converted);
        }
    }

    if (cookies.length === 0) {
        return null;
    }

    return {
        cookies,
        origins: []
    };
}

/*
 * Automatically detect:
 *
 * 1. Playwright storageState
 * 2. Firefox cookie export
 */

function normalizeSessionJson(
    data
) {
    if (
        isPlaywrightStorageState(data)
    ) {
        log(
            'Detected Playwright storage-state JSON.'
        );

        return data;
    }

    const converted =
        convertFirefoxToPlaywright(data);

    if (converted) {
        log(
            `Detected Firefox cookie JSON. Converted ${converted.cookies.length} cookies to Playwright format.`
        );

        return converted;
    }

    return null;
}

/* =========================================================
   INSTALL SESSION
   ========================================================= */

async function installJsonSession(
    chatId,
    sessionData
) {
    const normalized =
        normalizeSessionJson(
            sessionData
        );

    if (!normalized) {
        await bot.sendMessage(
            chatId,
            '❌ The JSON format was not recognized.\n\nExpected either a Playwright storage-state JSON or a Firefox cookie export containing name, value and domain fields.'
        );

        return false;
    }

    fs.mkdirSync(
        CONFIG.sessionDir,
        {
            recursive: true
        }
    );

    const sessionPath =
        path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        );

    await closeBrowser();

    fs.writeFileSync(
        sessionPath,
        JSON.stringify(
            normalized,
            null,
            2
        ),
        'utf8'
    );

    log(
        `Session written to ${sessionPath}`
    );

    await startBrowser();

    loginState.delete(chatId);

    await bot.sendMessage(
        chatId,
        '✅ Session imported successfully.\n\nFirefox cookies were automatically converted to Playwright format.'
    );

    await showMainMenu(chatId);

    return true;
}

/* =========================================================
   JSON TEXT
   ========================================================= */

async function useJsonText(
    chatId,
    jsonText
) {
    let parsed;

    try {
        parsed =
            JSON.parse(jsonText);
    } catch (err) {
        await bot.sendMessage(
            chatId,
            '❌ Invalid JSON.\n\nFor a large JSON, upload it as a .json file instead of pasting it.'
        );

        return;
    }

    try {
        await installJsonSession(
            chatId,
            parsed
        );
    } catch (err) {
        error(
            'Direct JSON login failed:',
            err.stack || err.message
        );

        await telegramAlert(
            `Direct JSON login failed:\n${err.message}`
        );

        await bot.sendMessage(
            chatId,
            '❌ Failed to install the JSON session.'
        );
    }
}

/* =========================================================
   JSON FILE UPLOAD
   ========================================================= */

async function useJsonFile(
    chatId,
    document
) {
    if (
        !document ||
        !document.file_id
    ) {
        await bot.sendMessage(
            chatId,
            '❌ Invalid Telegram file.'
        );

        return;
    }

    const fileName =
        document.file_name ||
        'session.json';

    if (
        !fileName
            .toLowerCase()
            .endsWith('.json')
    ) {
        await bot.sendMessage(
            chatId,
            '❌ Please upload a .json file.'
        );

        return;
    }

    let downloadedPath = null;

    try {
        fs.mkdirSync(
            CONFIG.sessionDir,
            {
                recursive: true
            }
        );

        downloadedPath =
            await bot.downloadFile(
                document.file_id,
                CONFIG.sessionDir
            );

        log(
            `JSON file downloaded: ${downloadedPath}`
        );

        const rawJson =
            fs.readFileSync(
                downloadedPath,
                'utf8'
            );

        let sessionData;

        try {
            sessionData =
                JSON.parse(rawJson);
        } catch (err) {
            await bot.sendMessage(
                chatId,
                '❌ The uploaded file is not valid JSON.'
            );

            return;
        }

        await installJsonSession(
            chatId,
            sessionData
        );
    } catch (err) {
        error(
            'JSON file login failed:',
            err.stack || err.message
        );

        await telegramAlert(
            `JSON file login failed:\n${err.message}`
        );

        await bot.sendMessage(
            chatId,
            `❌ Failed to import JSON file.\n\n${err.message}`
        );
    } finally {
        if (
            downloadedPath &&
            fs.existsSync(downloadedPath)
        ) {
            try {
                const finalSessionPath =
                    path.resolve(
                        path.join(
                            CONFIG.sessionDir,
                            'storage-state.json'
                        )
                    );

                const downloadedAbsolute =
                    path.resolve(
                        downloadedPath
                    );

                if (
                    downloadedAbsolute !==
                    finalSessionPath
                ) {
                    fs.rmSync(
                        downloadedPath,
                        {
                            force: true
                        }
                    );
                }
            } catch (err) {
                warn(
                    'Could not remove temporary JSON file:',
                    err.message
                );
            }
        }
    }
}

/* =========================================================
   DELETE SESSION
   ========================================================= */

async function deleteLoginSession(
    chatId
) {
    try {
        if (browser) {
            await browser.close();
        }
    } catch (err) {
        warn(
            'Browser close error during logout:',
            err.message
        );
    } finally {
        browser = null;
        context = null;
        page = null;
    }

    const sessionPath =
        path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        );

    if (
        fs.existsSync(sessionPath)
    ) {
        fs.rmSync(
            sessionPath,
            {
                force: true
            }
        );

        log(
            'Login session deleted.'
        );
    }

    loginState.delete(chatId);

    await bot.sendMessage(
        chatId,
        '🗑️ Login session deleted.\n\nChoose a new login method:',
        loginKeyboard()
    );
}

/* =========================================================
   /START
   ========================================================= */

bot.onText(
    /^\/start$/,
    async msg => {
        const chatId =
            msg.chat.id;

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
    }
);

/* =========================================================
   CALLBACKS
   ========================================================= */

bot.on(
    'callback_query',
    async query => {
        const chatId =
            query.message.chat.id;

        const action =
            query.data;

        if (!isAllowed(chatId)) {
            return;
        }

        await bot
            .answerCallbackQuery(
                query.id
            )
            .catch(() => {});

        try {
            switch (action) {
                case 'login_otp':
                    await beginOtpLogin(
                        chatId
                    );
                    break;

                case 'login_json':
                    await beginJsonLogin(
                        chatId
                    );
                    break;

                case 'wishlist':
                    await bot.sendMessage(
                        chatId,
                        '🛒 Wishlist module is waiting for the wishlist selectors.'
                    );
                    break;

                case 'remove_cart':
                    await bot.sendMessage(
                        chatId,
                        '🧹 Starting cart cleanup...'
                    );

                    await removeAllCartProducts();

                    await showMainMenu(
                        chatId
                    );

                    break;

                case 'complete_challenges':
                    await bot.sendMessage(
                        chatId,
                        '🏆 Challenge module is waiting for the challenge/task/product selectors.'
                    );

                    break;

                case 'new_login':
                    await deleteLoginSession(
                        chatId
                    );

                    break;

                default:
                    warn(
                        `Unknown callback: ${action}`
                    );
            }
        } catch (err) {
            error(
                'Callback error:',
                err.stack || err.message
            );

            await telegramAlert(
                `Unhandled operation error:\n${err.stack || err.message}`
            );

            await bot.sendMessage(
                chatId,
                '❌ An unexpected error occurred. Check the bot logs.'
            );
        }
    }
);

/* =========================================================
   TEXT MESSAGES
   ========================================================= */

bot.on(
    'message',
    async msg => {
        const chatId =
            msg.chat.id;

        if (!isAllowed(chatId)) {
            return;
        }

        if (
            !msg.text ||
            msg.text.startsWith('/')
        ) {
            return;
        }

        const state =
            loginState.get(chatId);

        if (!state) {
            return;
        }

        try {
            if (
                state.type === 'otp' &&
                state.stage ===
                    'waiting_phone'
            ) {
                await finishOtpLogin(
                    chatId,
                    msg.text.trim()
                );

                return;
            }

            if (
                state.type === 'otp' &&
                state.stage ===
                    'waiting_otp'
            ) {
                await finishOtpCode(
                    chatId,
                    msg.text.trim()
                );

                return;
            }

            if (
                state.type === 'json' &&
                state.stage ===
                    'waiting_json'
            ) {
                await useJsonText(
                    chatId,
                    msg.text.trim()
                );

                return;
            }
        } catch (err) {
            error(
                'Message handler error:',
                err.stack || err.message
            );

            await telegramAlert(
                `Message handler error:\n${err.message}`
            );
        }
    }
);

/* =========================================================
   DOCUMENT UPLOAD
   ========================================================= */

bot.on(
    'document',
    async msg => {
        const chatId =
            msg.chat.id;

        if (!isAllowed(chatId)) {
            return;
        }

        const state =
            loginState.get(chatId);

        if (
            !state ||
            state.type !== 'json' ||
            state.stage !==
                'waiting_json'
        ) {
            return;
        }

        try {
            await useJsonFile(
                chatId,
                msg.document
            );
        } catch (err) {
            error(
                'Document handler error:',
                err.stack || err.message
            );

            await telegramAlert(
                `JSON document handler error:\n${err.stack || err.message}`
            );

            await bot.sendMessage(
                chatId,
                '❌ JSON file processing failed.'
            );
        }
    }
);

/* =========================================================
   SHUTDOWN
   ========================================================= */

async function shutdown(signal) {
    log(
        `${signal} received.`
    );

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

process.on(
    'uncaughtException',
    async err => {
        error(
            'Uncaught exception:',
            err.stack || err.message
        );

        await telegramAlert(
            `Uncaught exception:\n${err.stack || err.message}`
        );
    }
);

log(
    'Telegram bot started.'
);
