'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { Telegraf, Markup } = require('telegraf');
const { chromium, devices } = require('playwright');
const selectors = require('./selectors');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN || TOKEN.includes('PUT_')) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env before starting.');
  process.exit(1);
}

const ALLOWED_IDS = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

const BASE_URL = process.env.BASE_URL || 'https://www.flipkart.com';
const WISHLIST_URL = process.env.WISHLIST_URL || `${BASE_URL}/wishlist`;
const CART_URL = process.env.CART_URL || 'https://www.flipkart.com/viewcart';
const CHALLENGE_URL = process.env.CHALLENGE_URL ||
  'https://www.flipkart.com/loyalty/challenges?challengeId=CH-D0CDF9&pageUID=16386328RULES';

const HEADLESS = !['false', '0', 'no'].includes(
  String(process.env.HEADLESS || 'true').toLowerCase()
);
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT_MS || 12000);
const NAV_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT_MS || 30000);

const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'playwright-storage-state.json');
const RAW_JSON_PATH = path.join(DATA_DIR, 'source-cookie-json.json');

const bot = new Telegraf(TOKEN);
const sessions = new Map(); // per-chat transient conversation state
let browser;
let context;
let page;
let busy = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function alertAdmin(ctx, message, error) {
  const detail = error ? `\n\nError: ${String(error.message || error).slice(0, 1200)}` : '';
  const text = `⚠️ Automation alert\n${message}${detail}`;
  log(text.replace(/\n/g, ' | '));
  try {
    await ctx.reply(text);
  } catch (e) {
    log(`Could not send Telegram alert: ${e.message}`);
  }
}

function isAuthorized(ctx) {
  // Fail closed: no configured IDs means nobody can operate the bot.
  return ALLOWED_IDS.size > 0 && ALLOWED_IDS.has(String(ctx.from?.id));
}

function guard(ctx) {
  if (!isAuthorized(ctx)) {
    ctx.reply('Access denied. Configure your Telegram numeric ID in ALLOWED_TELEGRAM_IDS.');
    return false;
  }
  return true;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function closeBrowser() {
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  context = undefined;
  browser = undefined;
  page = undefined;
}

async function launchBrowser() {
  await closeBrowser();
  browser = await chromium.launch({ headless: HEADLESS });
  // Android Chrome-like viewport and user agent, rather than desktop layout.
  // Playwright emulates Android mobile behavior; it is not a separately installed Android OS.
  const device = devices['Pixel 7'];
  context = await browser.newContext({
    ...device,
    isMobile: true,
    hasTouch: true,
    viewport: { width: 412, height: 915 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata'
  });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.on('pageerror', err => log(`Page error: ${err.message}`));
  page.on('crash', () => log('Browser page crashed.'));
  return page;
}

/**
 * Resolve selectors in order. A fallback is used only when the previous selector
 * has zero matches. Multiple matches are treated as ambiguous and are not clicked.
 * If a selector matches several elements, a unique visible match may be used.
 */
async function findUniqueLocator(targetPage, primary, fallbacks = [], label = 'element') {
  const candidates = [primary, ...fallbacks].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i];
    let locator;
    try {
      locator = targetPage.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;

      const visible = [];
      for (let n = 0; n < count; n++) {
        const item = locator.nth(n);
        try {
          if (await item.isVisible()) visible.push(item);
        } catch {}
      }

      if (visible.length === 1) {
        if (i > 0) log(`WARNING: fallback ${i} used for ${label}: ${selector}`);
        return visible[0];
      }

      if (visible.length > 1) {
        // A repeated "Remove" selector can legitimately appear once per cart item.
        // The caller handles this as a collection only when explicitly requested.
        if (i > 0) log(`WARNING: fallback ${i} matched multiple ${label} elements.`);
        return { locator, multiple: true, selector, count: visible.length };
      }
    } catch (err) {
      log(`Selector error for ${label} (${selector}): ${err.message}`);
    }
  }
  return null;
}

async function clickUnique(targetPage, primary, fallbacks, label) {
  const found = await findUniqueLocator(targetPage, primary, fallbacks, label);
  if (!found) {
    throw new Error(`No selector matched ${label}; no click performed.`);
  }
  if (found.multiple) {
    throw new Error(`Ambiguous selector for ${label}: ${found.count} visible matches; no click performed.`);
  }
  await found.click();
  return true;
}

async function readJsonFromMessage(ctx, raw) {
  // Supports a Firefox cookie-export array and common {cookies, origins} storage-state shapes.
  const parsed = JSON.parse(raw);
  let cookies = [];
  let origins = [];

  if (Array.isArray(parsed)) {
    cookies = parsed;
  } else if (parsed && Array.isArray(parsed.cookies)) {
    cookies = parsed.cookies;
    origins = Array.isArray(parsed.origins) ? parsed.origins : [];
  } else if (parsed && Array.isArray(parsed.logins)) {
    throw new Error('This looks like a Firefox saved-password export, not a cookie export. Export cookies for the signed-in site instead.');
  } else {
    throw new Error('Unsupported JSON shape. Send a Firefox cookie JSON array or an object containing a cookies array.');
  }

  const normalized = [];
  for (const c of cookies) {
    const domain = c.domain || c.host || c.hostname;
    const name = c.name;
    const value = c.value;
    if (!domain || !name || value === undefined || value === null) continue;

    let sameSite = c.sameSite;
    if (typeof sameSite === 'number') {
      sameSite = ({ 0: 'None', 1: 'Lax', 2: 'Strict' })[sameSite];
    }
    if (!['Strict', 'Lax', 'None'].includes(sameSite)) sameSite = 'Lax';

    const cookie = {
      name: String(name),
      value: String(value),
      domain: String(domain).startsWith('.') ? String(domain) : `.${String(domain)}`,
      path: c.path || '/',
      expires: Number(c.expirationDate ?? c.expires ?? -1),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite
    };
    if (!Number.isFinite(cookie.expires) || cookie.expires < 0) delete cookie.expires;
    normalized.push(cookie);
  }

  if (!normalized.length) {
    throw new Error('No usable cookies found in the JSON. Make sure it is a cookie export for the target website.');
  }

  await ensureDataDir();
  await fs.writeFile(RAW_JSON_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  await fs.writeFile(STATE_PATH, JSON.stringify({ cookies: normalized, origins }, null, 2), { mode: 0o600 });
  return normalized.length;
}

async function loadSavedSession() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    await launchBrowser();
    await context.addCookies(state.cookies || []);
    // Seed localStorage entries from an existing Playwright state, if supplied.
    for (const origin of state.origins || []) {
      if (!origin.origin || !Array.isArray(origin.localStorage)) continue;
      const seedPage = await context.newPage();
      try {
        await seedPage.goto(origin.origin, { waitUntil: 'domcontentloaded' });
        await seedPage.evaluate(entries => {
          for (const entry of entries) localStorage.setItem(entry.name, entry.value);
        }, origin.localStorage);
      } finally {
        await seedPage.close();
      }
    }
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    return true;
  } catch (err) {
    await closeBrowser();
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function saveCurrentSession() {
  if (!context) throw new Error('Browser session is not active.');
  await ensureDataDir();
  const state = await context.storageState();
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('1 · Remove all wishlist products', 'wishlist_clear')],
    [Markup.button.callback('2 · Remove all cart products', 'cart_clear')],
    [Markup.button.callback('3 · Complete all challenges', 'challenges_run')],
    [Markup.button.callback('4 · Delete session / new account', 'session_reset')]
  ]);
}

function loginKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('OTP login', 'login_otp')],
    [Markup.button.callback('JSON cookie login', 'login_json')]
  ]);
}

async function requirePage(ctx) {
  if (!page || !context) {
    const loaded = await loadSavedSession();
    if (!loaded) {
      await ctx.reply('No saved login session. Choose a login method first.', loginKeyboard());
      return false;
    }
  }
  return true;
}

async function loginOtpStart(ctx) {
  sessions.set(ctx.chat.id, { mode: 'otp_identifier' });
  await ctx.reply(
    'OTP login selected. Send the phone number/email used on the site. Login selectors in .env must be filled with verified selectors before this flow can operate.'
  );
}

async function handleOtpIdentifier(ctx, identifier) {
  const required = [
    ['LOGIN_OPEN_SELECTOR', process.env.LOGIN_OPEN_SELECTOR],
    ['LOGIN_IDENTIFIER_SELECTOR', process.env.LOGIN_IDENTIFIER_SELECTOR],
    ['LOGIN_SEND_OTP_SELECTOR', process.env.LOGIN_SEND_OTP_SELECTOR]
  ];
  const missing = required.filter(([, v]) => !v);
  if (missing.length) {
    sessions.delete(ctx.chat.id);
    await ctx.reply(`OTP login is not configured yet. Fill these .env values: ${missing.map(x => x[0]).join(', ')}. No action was taken.`);
    return;
  }

  await launchBrowser();
  await page.goto(process.env.LOGIN_URL || BASE_URL, { waitUntil: 'domcontentloaded' });

  await clickUnique(page, process.env.LOGIN_OPEN_SELECTOR, [], 'login opener');
  const input = await findUniqueLocator(page, process.env.LOGIN_IDENTIFIER_SELECTOR, [], 'login identifier input');
  if (!input || input.multiple) throw new Error('Login identifier selector is missing or ambiguous.');
  await input.fill(identifier);
  await clickUnique(page, process.env.LOGIN_SEND_OTP_SELECTOR, [], 'send OTP button');

  sessions.set(ctx.chat.id, { mode: 'otp_code' });
  await ctx.reply('OTP request sent if the site accepted it. Send the OTP here. It will be entered into the configured OTP field.');
}

async function handleOtpCode(ctx, otp) {
  const inputSelector = process.env.LOGIN_OTP_INPUT_SELECTOR;
  const verifySelector = process.env.LOGIN_VERIFY_OTP_SELECTOR;
  if (!inputSelector || !verifySelector) {
    sessions.delete(ctx.chat.id);
    await ctx.reply('OTP input/verify selectors are missing in .env. No verification action was taken.');
    return;
  }
  const input = await findUniqueLocator(page, inputSelector, [], 'OTP input');
  if (!input || input.multiple) throw new Error('OTP input selector is missing or ambiguous.');
  await input.fill(otp.trim());
  await clickUnique(page, verifySelector, [], 'verify OTP button');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await saveCurrentSession();
  sessions.delete(ctx.chat.id);
  await ctx.reply('Login flow finished and session saved. Verify the account is signed in, then use the menu.', mainKeyboard());
}

async function clearCart(ctx) {
  if (!(await requirePage(ctx))) return;
  await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
  let removed = 0;
  let unchangedPasses = 0;

  for (let iteration = 0; iteration < 100; iteration++) {
    const primary = selectors.cart.removePrimary;
    const fallbacks = selectors.cart.removeFallbacks;
    const found = await findUniqueLocator(page, primary, fallbacks, 'cart Remove control');

    if (!found) {
      // Verify whether the cart is empty rather than silently claiming success.
      await ctx.reply(`Cart cleanup stopped: no Remove control found after ${removed} removal(s). Check the cart page manually; this may mean the cart is empty or selectors changed.`);
      return;
    }

    let target;
    if (found.multiple) {
      // Repeated remove controls are expected: choose the first visible control and re-check after each removal.
      // The exact supplied selector is retained; only the matching collection is indexed.
      target = found.locator.filter({ visible: true }).first();
      if (found.selector !== primary) {
        log(`WARNING: fallback selector used for cart removal: ${found.selector}`);
      }
    } else {
      target = found;
    }

    const beforeUrl = page.url();
    const beforeCount = await page.locator(primary).count().catch(() => -1);
    try {
      await target.click();
    } catch (err) {
      await alertAdmin(ctx, 'Could not click the cart Remove control. Selector may have changed; no further clicks will be attempted.', err);
      return;
    }

    // Sites often show a confirmation dialog. Do not guess a confirmation selector.
    await page.waitForTimeout(900);
    const afterCount = await page.locator(primary).count().catch(() => -1);
    const afterUrl = page.url();

    if (afterCount < beforeCount || afterUrl !== beforeUrl) {
      removed++;
      unchangedPasses = 0;
    } else {
      unchangedPasses++;
      if (unchangedPasses >= 2) {
        await alertAdmin(ctx, 'Cart Remove was clicked but the page did not visibly change twice. Stopping to avoid repeated accidental clicks.');
        return;
      }
    }
    await page.waitForTimeout(350);
  }

  await alertAdmin(ctx, 'Cart cleanup reached the 100-iteration safety limit. Check the cart manually.');
}

async function clearWishlist(ctx) {
  if (!(await requirePage(ctx))) return;
  const itemSelector = process.env.WISHLIST_ITEM_SELECTOR;
  const removeSelector = process.env.WISHLIST_REMOVE_SELECTOR;
  if (!itemSelector || !removeSelector) {
    await ctx.reply('Wishlist cleanup is not configured: WISHLIST_ITEM_SELECTOR and WISHLIST_REMOVE_SELECTOR are blank in .env. Send the selectors and they can be added without guessing.');
    return;
  }

  await page.goto(WISHLIST_URL, { waitUntil: 'domcontentloaded' });
  let removed = 0;
  for (let i = 0; i < 100; i++) {
    const items = page.locator(itemSelector);
    const itemCount = await items.count();
    if (itemCount === 0) {
      await ctx.reply(`Wishlist appears empty. Removed ${removed} product(s).`);
      return;
    }

    const firstItem = items.first();
    const remove = firstItem.locator(removeSelector);
    const count = await remove.count();
    if (count !== 1) {
      await alertAdmin(ctx, `Wishlist remove selector must match exactly one control inside the first item; found ${count}. No click performed.`);
      return;
    }

    const before = await items.count();
    await remove.click();
    await page.waitForTimeout(900);
    const after = await items.count();
    if (after < before) {
      removed++;
    } else {
      await alertAdmin(ctx, 'Wishlist removal did not reduce the item count. Stopping instead of repeatedly clicking an unverified control.');
      return;
    }
  }
  await alertAdmin(ctx, 'Wishlist cleanup reached the 100-iteration safety limit.');
}

async function runChallenges(ctx) {
  if (!(await requirePage(ctx))) return;
  const c = selectors.challenges;
  const missing = Object.entries(c).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    await ctx.reply(
      `Challenge automation is deliberately paused until the remaining selectors are supplied. Missing selectors: ${missing.join(', ')}.\n\nNo challenge actions were taken. Once you provide the challenge/task/product selectors, this handler can be completed using the same primary → fallback strategy.`
    );
    return;
  }

  // Guard against accidentally guessing site behavior. This is the integration point
  // for the challenge traversal once actual selectors and completion-state signals exist.
  await page.goto(CHALLENGE_URL, { waitUntil: 'domcontentloaded' });
  await alertAdmin(ctx, 'Challenge selectors exist, but task completion-state selectors and page transitions must also be configured before enabling automatic challenge actions.');
}

async function resetSession(ctx) {
  await closeBrowser();
  for (const file of [STATE_PATH, RAW_JSON_PATH]) {
    try { await fs.unlink(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  sessions.delete(ctx.chat.id);
  await ctx.reply('Saved login session and imported cookie JSON deleted. Choose how to log into the next account.', loginKeyboard());
}

bot.use(async (ctx, next) => {
  if (!guard(ctx)) return;
  return next();
});

bot.start(async ctx => {
  const loaded = await loadSavedSession().catch(async err => {
    await alertAdmin(ctx, 'Could not load saved session.', err);
    return false;
  });
  if (loaded) {
    await ctx.reply('Saved session found. Choose an action.', mainKeyboard());
  } else {
    await ctx.reply('Choose a login method.', loginKeyboard());
  }
});

bot.action('login_otp', async ctx => {
  await ctx.answerCbQuery();
  await loginOtpStart(ctx);
});

bot.action('login_json', async ctx => {
  await ctx.answerCbQuery();
  sessions.set(ctx.chat.id, { mode: 'json_input' });
  await ctx.reply('Send the Firefox cookie JSON as a message, or attach it as a .json document. Do not send account passwords.');
});

bot.action('wishlist_clear', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await clearWishlist(ctx); }
  catch (err) { await alertAdmin(ctx, 'Wishlist cleanup failed.', err); }
  finally { busy = false; }
});

bot.action('cart_clear', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await clearCart(ctx); }
  catch (err) { await alertAdmin(ctx, 'Cart cleanup failed.', err); }
  finally { busy = false; }
});

bot.action('challenges_run', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await runChallenges(ctx); }
  catch (err) { await alertAdmin(ctx, 'Challenge run failed.', err); }
  finally { busy = false; }
});

bot.action('session_reset', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Wait for the current action to finish before resetting the session.');
  try { await resetSession(ctx); }
  catch (err) { await alertAdmin(ctx, 'Could not reset session.', err); }
});

bot.on('document', async ctx => {
  const state = sessions.get(ctx.chat.id);
  if (!state || state.mode !== 'json_input') return;
  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith('.json')) {
    await ctx.reply('Please attach a .json file.');
    return;
  }
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    const raw = await response.text();
    const count = await readJsonFromMessage(ctx, raw);
    sessions.delete(ctx.chat.id);
    await loadSavedSession();
    await ctx.reply(`Imported ${count} cookies and created Playwright storage state. Check the account is signed in, then use the menu.`, mainKeyboard());
  } catch (err) {
    await alertAdmin(ctx, 'Could not import cookie JSON file.', err);
  }
});

bot.on('text', async ctx => {
  const state = sessions.get(ctx.chat.id);
  if (!state) return;

  try {
    if (state.mode === 'json_input') {
      const raw = ctx.message.text.trim();
      const count = await readJsonFromMessage(ctx, raw);
      sessions.delete(ctx.chat.id);
      await loadSavedSession();
      await ctx.reply(`Imported ${count} cookies and created Playwright storage state. Check the account is signed in, then use the menu.`, mainKeyboard());
      return;
    }
    if (state.mode === 'otp_identifier') {
      await handleOtpIdentifier(ctx, ctx.message.text.trim());
      return;
    }
    if (state.mode === 'otp_code') {
      await handleOtpCode(ctx, ctx.message.text.trim());
      return;
    }
  } catch (err) {
    sessions.delete(ctx.chat.id);
    await alertAdmin(ctx, 'Login flow failed.', err);
  }
});

bot.catch(async (err, ctx) => {
  log(`Telegram bot error: ${err.message}`);
  if (ctx) await alertAdmin(ctx, 'Unexpected Telegram bot error.', err);
});

process.once('SIGINT', async () => {
  await closeBrowser();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  await closeBrowser();
  bot.stop('SIGTERM');
});

bot.launch().then(() => log('Telegram bot started.')).catch(err => {
  console.error('Bot failed to start:', err);
  process.exit(1);
});
