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

/* =======================================================
   CONFIG
======================================================= */

const CONFIG = {
    baseUrl:
        process.env.BASE_URL ||
        'https://www.gulok.com',

    cartUrl:
        process.env.CART_URL ||
        'https://www.flipkart.com/viewcart',

    telegramToken:
        process.env.TELEGRAM_BOT_TOKEN,

    allowedChatId:
        process.env.TELEGRAM_CHAT_ID ||
        null,

    headless:
        process.env.HEADLESS !== 'false',

    sessionDir:
        path.resolve(
            process.env.SESSION_DIR ||
            './session'
        ),

    navigationTimeout:
        Number(
            process.env.NAVIGATION_TIMEOUT ||
            30000
        ),

    actionTimeout:
        Number(
            process.env.ACTION_TIMEOUT ||
            10000
        ),

    maxCartRemovals:
        Number(
            process.env.MAX_CART_REMOVALS ||
            500
        )
};


/* =======================================================
   VALIDATE CONFIG
======================================================= */

if (!CONFIG.telegramToken) {
    throw new Error(
        'TELEGRAM_BOT_TOKEN is missing from .env'
    );
}


/* =======================================================
   TELEGRAM
======================================================= */

const bot =
    new TelegramBot(
        CONFIG.telegramToken,
        {
            polling: true
        }
    );


/* =======================================================
   GLOBAL STATE
======================================================= */

let browser = null;
let context = null;
let page = null;


/*
 * Per-Telegram-user temporary login state.
 *
 * Example:
 *
 * {
 *   type: 'json',
 *   stage: 'waiting_json'
 * }
 */
const loginState =
    new Map();


/* =======================================================
   LOGGING
======================================================= */

function timestamp() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(
        `[${timestamp()}]`,
        ...args
    );
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


/* =======================================================
   TELEGRAM SECURITY
======================================================= */

function isAllowed(chatId) {
    /*
     * If TELEGRAM_CHAT_ID is empty, allow requests.
     *
     * For production, setting TELEGRAM_CHAT_ID is
     * strongly recommended.
     */
    if (!CONFIG.allowedChatId) {
        return true;
    }

    return (
        String(chatId) ===
        String(CONFIG.allowedChatId)
    );
}


/* =======================================================
   TELEGRAM ALERT
======================================================= */

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


/* =======================================================
   BROWSER START
======================================================= */

async function startBrowser() {

    /*
     * Don't create multiple browser instances.
     */
    if (
        browser &&
        context &&
        page
    ) {
        return;
    }

    log(
        'Starting Chromium in Android mode...'
    );

    fs.mkdirSync(
        CONFIG.sessionDir,
        {
            recursive: true
        }
    );


    /*
     * Playwright storage-state location.
     */
    const sessionPath =
        path.join(
            CONFIG.sessionDir,
            'storage-state.json'
        );


    /*
     * Only use storageState if it exists
     * and appears to contain JSON.
     */
    let storageState;

    if (
        fs.existsSync(sessionPath)
    ) {
        try {
            const raw =
                fs.readFileSync(
                    sessionPath,
                    'utf8'
                );

            storageState =
                JSON.parse(raw);

            log(
                'Existing Playwright session found.'
            );

        } catch (err) {

            warn(
                'Existing storage-state.json could not be parsed:',
                err.message
            );

            /*
             * Do not silently use a broken session.
             */
            storageState = undefined;
        }
    }


    browser =
        await chromium.launch({
            headless:
                CONFIG.headless
        });


    /*
     * Android device emulation.
     *
     * This is NOT desktop Chrome with a mobile
     * viewport. Playwright applies the device
     * profile including mobile user-agent,
     * viewport, touch, scale factor, etc.
     */
    const contextOptions = {
        ...devices['Pixel 5']
    };

    if (storageState) {
        contextOptions.storageState =
            storageState;
    }


    context =
        await browser.newContext(
            contextOptions
        );


    context.setDefaultTimeout(
        CONFIG.actionTimeout
    );

    context.setDefaultNavigationTimeout(
        CONFIG.navigationTimeout
    );


    page =
        await context.newPage();


    /*
     * Page-level error reporting.
     */
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


    /*
     * Browser page crash.
     */
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


/* =======================================================
   SAVE SESSION
======================================================= */

async function saveSession() {

    if (!context) {
        return;
    }

    fs.mkdirSync(
        CONFIG.sessionDir,
        {
            recursive: true
        }
    );

    await context.storageState({
        path:
            path.join(
                CONFIG.sessionDir,
                'storage-state.json'
            )
    });

    log(
        'Playwright session saved.'
    );
}


/* =======================================================
   CLOSE BROWSER
======================================================= */

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


/* =======================================================
   SAFE SELECTOR RESOLUTION
======================================================= */

/*
 * Rules:
 *
 * 1. page.locator() only.
 * 2. Never XPath.
 * 3. Never page.$().
 * 4. Primary first.
 * 5. Fallbacks in order.
 * 6. count() MUST equal exactly 1.
 * 7. 0 = reject.
 * 8. 2+ = reject.
 * 9. Never click an ambiguous selector.
 */

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
                locatorFunction(
                    selector
                );

            count =
                await locator.count();

        } catch (err) {

            warn(
                `${description}: ${label} threw an error: ${err.message}`
            );

            continue;
        }


        /*
         * EXACTLY ONE = valid.
         */
        if (count === 1) {

            if (i > 0) {

                warn(
                    `${description}: primary selector failed; using ${label}.`
                );
            }

            return {
                selector,
                locator:
                    locatorFunction(
                        selector
                    ),
                label
            };
        }


        /*
         * Zero elements.
         */
        if (count === 0) {

            warn(
                `${description}: ${label} matched 0 elements.`
            );

            continue;
        }


        /*
         * Multiple elements.
         */
        warn(
            `${description}: ${label} matched ${count} elements; refusing to click.`
        );
    }


    return null;
}


/* =======================================================
   SAFE CLICK
======================================================= */

async function safeClick(
    targetPage,
    selectorDefinitions,
    description
) {

    const resolved =
        await resolveSelector(
            targetPage.locator.bind(
                targetPage
            ),
            selectorDefinitions,
            description
        );


    if (!resolved) {

        const message =
            `No valid selector found for:\n${description}`;

        error(message);

        await telegramAlert(
            message
        );

        return false;
    }


    try {

        await resolved.locator.click({
            timeout:
                CONFIG.actionTimeout
        });

        log(
            `${description}: clicked using ${resolved.label}.`
        );

        return true;

    } catch (err) {

        const message =
            `${description}: click failed.\n${err.message}`;

        error(message);

        await telegramAlert(
            message
        );

        return false;
    }
}


/* =======================================================
   OPEN CART
======================================================= */

async function openCart() {

    await page.goto(
        CONFIG.cartUrl,
        {
            waitUntil:
                'domcontentloaded'
        }
    );


    /*
     * Network idle isn't guaranteed on modern
     * ecommerce pages, therefore failure here
     * is intentionally ignored.
     */
    await page
        .waitForLoadState(
            'networkidle'
        )
        .catch(() => {});


    log(
        `Cart opened: ${page.url()}`
    );
}


/* =======================================================
   REMOVE ALL CART PRODUCTS
======================================================= */

async function removeAllCartProducts() {

    await startBrowser();

    await openCart();

    let removed = 0;


    /*
     * Re-resolve the Remove selector after every
     * removal because the DOM changes dynamically.
     */
    for (
        let iteration = 1;
        iteration <=
        CONFIG.maxCartRemovals;
        iteration++
    ) {

        log(
            `Cart removal iteration ${iteration}`
        );


        const removeButton =
            await resolveSelector(
                page.locator.bind(
                    page
                ),
                CART_REMOVE,
                'Cart → Remove product'
            );


        /*
         * No valid Remove button.
         */
        if (!removeButton) {

            /*
             * Check the supplied primary selector
             * directly to distinguish "empty cart"
             * from selector failure.
             */
            const remaining =
                await page
                    .locator(
                        "div:text-is('Remove')"
                    )
                    .count()
                    .catch(() => 0);


            if (remaining === 0) {

                log(
                    `Cart cleanup finished. Removed: ${removed}`
                );


                if (
                    CONFIG.allowedChatId
                ) {

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


        /*
         * Click exactly one validated element.
         */
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
                reason:
                    err.message
            };
        }


        /*
         * Give the ecommerce UI a moment to process
         * the action. The selector is revalidated on
         * the next iteration.
         */
        await page.waitForTimeout(
            500
        );
    }


    /*
     * Protection against an infinite loop caused
     * by a broken page.
     */
    const message =
        `Cart cleanup stopped after reaching MAX_CART_REMOVALS=${CONFIG.maxCartRemovals}.`;


    await telegramAlert(
        message
    );


    return {
        success: false,
        removed,
        reason:
            'Maximum removal limit reached.'
    };
}


/* =======================================================
   LOGIN KEYBOARD
======================================================= */

function loginKeyboard() {

    return {
        reply_markup: {
            inline_keyboard: [

                [
                    {
                        text:
                            '🔐 OTP Login',
                        callback_data:
                            'login_otp'
                    }
                ],

                [
                    {
                        text:
                            '📄 JSON Login',
                        callback_data:
                            'login_json'
                    }
                ]

            ]
        }
    };
}


/* =======================================================
   MAIN KEYBOARD
======================================================= */

function mainKeyboard() {

    return {
        reply_markup: {
            inline_keyboard: [

                [
                    {
                        text:
                            '🛒 View Wishlist',
                        callback_data:
                            'wishlist'
                    }
                ],

                [
                    {
                        text:
                            '🧹 Remove Cart Products',
                        callback_data:
                            'remove_cart'
                    }
                ],

                [
                    {
                        text:
                            '🏆 Complete Challenges',
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


/* =======================================================
   SHOW MAIN MENU
======================================================= */

async function showMainMenu(
    chatId
) {

    await bot.sendMessage(
        chatId,
        'Select an operation:',
        mainKeyboard()
    );
}


/* =======================================================
   OTP LOGIN
======================================================= */

async function beginOtpLogin(
    chatId
) {

    loginState.set(
        chatId,
        {
            type: 'otp',
            stage:
                'waiting_phone'
        }
    );


    await bot.sendMessage(
        chatId,
        'Send the login phone number.'
    );
}


/*
 * Opens the website and waits for the OTP.
 *
 * Login-page selectors have not been supplied,
 * so this part intentionally does not guess them.
 */
async function finishOtpLogin(
    chatId,
    phone
) {

    await startBrowser();


    await page.goto(
        CONFIG.baseUrl,
        {
            waitUntil:
                'domcontentloaded'
        }
    );


    loginState.set(
        chatId,
        {
            type: 'otp',
            stage:
                'waiting_otp',
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

    /*
     * OTP input/login selectors are not available yet.
     *
     * Do not guess a selector.
     */
    await telegramAlert(
        `OTP received for chat ${chatId}, but login-page selectors are not configured yet.`
    );


    await bot.sendMessage(
        chatId,
        'OTP received. Login-page selectors still need to be configured.'
    );
}


/* =======================================================
   JSON LOGIN
======================================================= */

async function beginJsonLogin(
    chatId
) {

    loginState.set(
        chatId,
        {
            type: 'json',
            stage:
                'waiting_json'
        }
    );


    await bot.sendMessage(
        chatId,
        '📎 Send the Playwright JSON session as a .json file.\n\nYou can also paste the JSON directly if it fits inside one Telegram message.'
    );
}


/* =======================================================
   VALIDATE PLAYWRIGHT STORAGE STATE
======================================================= */

function isPlaywrightStorageState(
    data
) {

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
    ) {
        return false;
    }


    /*
     * Playwright storage state normally has
     * cookies and/or origins.
     */
    return (
        Array.isArray(data.cookies) ||
        Array.isArray(data.origins)
    );
}


/* =======================================================
   WRITE SESSION
======================================================= */

async function installJsonSession(
    chatId,
    sessionData
) {

    if (
        !isPlaywrightStorageState(
            sessionData
        )
    ) {

        await bot.sendMessage(
            chatId,
            '❌ The JSON does not appear to be a Playwright storage-state file.\n\nExpected an object containing cookies and/or origins.'
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


    /*
     * Close existing browser before replacing
     * its session.
     */
    await closeBrowser();


    /*
     * Write validated session.
     */
    fs.writeFileSync(
        sessionPath,
        JSON.stringify(
            sessionData,
            null,
            2
        ),
        'utf8'
    );


    log(
        `New session written to ${sessionPath}`
    );


    /*
     * Start browser with the new session.
     */
    await startBrowser();


    loginState.delete(
        chatId
    );


    await bot.sendMessage(
        chatId,
        '✅ JSON login successful.'
    );


    await showMainMenu(
        chatId
    );


    return true;
}


/* =======================================================
   DIRECT JSON TEXT LOGIN
======================================================= */

async function useJsonText(
    chatId,
    jsonText
) {

    let parsed;


    try {

        parsed =
            JSON.parse(
                jsonText
            );

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
            err.stack ||
            err.message
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


/* =======================================================
   JSON FILE LOGIN
======================================================= */

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


    let downloadedPath =
        null;


    try {

        fs.mkdirSync(
            CONFIG.sessionDir,
            {
                recursive: true
            }
        );


        /*
         * Telegram downloads the attachment directly
         * to the Debian/Railway filesystem.
         *
         * This avoids Telegram's text-message limit.
         */
        downloadedPath =
            await bot.downloadFile(
                document.file_id,
                CONFIG.sessionDir
            );


        log(
            `JSON file downloaded: ${downloadedPath}`
        );


        /*
         * Read the entire file.
         */
        const rawJson =
            fs.readFileSync(
                downloadedPath,
                'utf8'
            );


        /*
         * Parse before touching the active session.
         */
        let sessionData;


        try {

            sessionData =
                JSON.parse(
                    rawJson
                );

        } catch (err) {

            await bot.sendMessage(
                chatId,
                '❌ The uploaded file is not valid JSON.'
            );

            return;
        }


        /*
         * Install only after successful validation.
         */
        await installJsonSession(
            chatId,
            sessionData
        );

    } catch (err) {

        error(
            'JSON file login failed:',
            err.stack ||
            err.message
        );


        await telegramAlert(
            `JSON file login failed:\n${err.message}`
        );


        await bot.sendMessage(
            chatId,
            `❌ Failed to import JSON file.\n\n${err.message}`
        );

    } finally {

        /*
         * Remove Telegram's temporary copy.
         *
         * The actual session remains at:
         *
         * session/storage-state.json
         */
        if (
            downloadedPath &&
            fs.existsSync(
                downloadedPath
            )
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


                /*
                 * Never delete the final session
                 * if Telegram happened to use the
                 * same path.
                 */
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


/* =======================================================
   DELETE LOGIN SESSION
======================================================= */

async function deleteLoginSession(
    chatId
) {

    /*
     * Close browser without preserving the
     * old session.
     */
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
        fs.existsSync(
            sessionPath
        )
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


    loginState.delete(
        chatId
    );


    await bot.sendMessage(
        chatId,
        '🗑️ Login session deleted.\n\nChoose a new login method:',
        loginKeyboard()
    );
}


/* =======================================================
   /START
======================================================= */

bot.onText(
    /^\/start$/,
    async msg => {

        const chatId =
            msg.chat.id;


        if (
            !isAllowed(
                chatId
            )
        ) {

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


/* =======================================================
   CALLBACK BUTTONS
======================================================= */

bot.on(
    'callback_query',
    async query => {

        const chatId =
            query.message.chat.id;

        const action =
            query.data;


        if (
            !isAllowed(
                chatId
            )
        ) {
            return;
        }


        await bot.answerCallbackQuery(
            query.id
        ).catch(() => {});


        try {

            switch (action) {

                /* ---------------------------------------
                   LOGIN
                --------------------------------------- */

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


                /* ---------------------------------------
                   WISHLIST
                --------------------------------------- */

                case 'wishlist':

                    await bot.sendMessage(
                        chatId,
                        '🛒 Wishlist module is waiting for the wishlist selectors.'
                    );

                    break;


                /* ---------------------------------------
                   CART
                --------------------------------------- */

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


                /* ---------------------------------------
                   CHALLENGES
                --------------------------------------- */

                case 'complete_challenges':

                    await bot.sendMessage(
                        chatId,
                        '🏆 Challenge module is waiting for the challenge/task/product selectors.'
                    );

                    break;


                /* ---------------------------------------
                   NEW ACCOUNT
                --------------------------------------- */

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
                err.stack ||
                err.message
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


/* =======================================================
   TEXT MESSAGES
======================================================= */

bot.on(
    'message',
    async msg => {

        const chatId =
            msg.chat.id;


        if (
            !isAllowed(
                chatId
            )
        ) {
            return;
        }


        /*
         * Ignore Telegram commands.
         */
        if (
            !msg.text ||
            msg.text.startsWith('/')
        ) {
            return;
        }


        const state =
            loginState.get(
                chatId
            );


        if (!state) {
            return;
        }


        try {

            /* -------------------------------------------
               OTP PHONE
            ------------------------------------------- */

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


            /* -------------------------------------------
               OTP CODE
            ------------------------------------------- */

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


            /* -------------------------------------------
               DIRECT JSON TEXT
            ------------------------------------------- */

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
                err.stack ||
                err.message
            );


            await telegramAlert(
                `Message handler error:\n${err.message}`
            );
        }
    }
);


/* =======================================================
   TELEGRAM DOCUMENT / FILE HANDLER
======================================================= */

/*
 * This is the important addition for large JSON files.
 *
 * Telegram sends the JSON as a document rather than
 * putting the entire JSON inside a message.
 */

bot.on(
    'document',
    async msg => {

        const chatId =
            msg.chat.id;


        if (
            !isAllowed(
                chatId
            )
        ) {
            return;
        }


        const state =
            loginState.get(
                chatId
            );


        /*
         * Only process documents while the bot is
         * waiting for JSON login.
         */
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
                err.stack ||
                err.message
            );


            await telegramAlert(
                `JSON document handler error:\n${err.message}`
            );


            await bot.sendMessage(
                chatId,
                '❌ JSON file processing failed.'
            );
        }
    }
);


/* =======================================================
   SHUTDOWN
======================================================= */

async function shutdown(
    signal
) {

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
    () =>
        shutdown(
            'SIGINT'
        )
);

process.once(
    'SIGTERM',
    () =>
        shutdown(
            'SIGTERM'
        )
);


/* =======================================================
   UNHANDLED ERRORS
======================================================= */

process.on(
    'unhandledRejection',
    async reason => {

        error(
            'Unhandled rejection:',
            reason
        );


        await telegramAlert(
            `Unhandled rejection:\n${
                reason?.stack ||
                reason
            }`
        );
    }
);


process.on(
    'uncaughtException',
    async err => {

        error(
            'Uncaught exception:',
            err.stack ||
            err.message
        );


        await telegramAlert(
            `Uncaught exception:\n${
                err.stack ||
                err.message
            }`
        );
    }
);


/* =======================================================
   START
======================================================= */

log(
    'Telegram bot started.'
);
