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
    .map(value => value.trim())
    .filter(Boolean)
);

const BASE_URL = process.env.BASE_URL || 'https://www.gulok.com';
const WISHLIST_URL = process.env.WISHLIST_URL || `${BASE_URL}/wishlist`;
const CART_URL = process.env.CART_URL || 'https://www.flipkart.com/viewcart';
const CHALLENGE_URL = process.env.CHALLENGE_URL ||
  'https://www.gulok.com/loyalty/challenges?challengeId=CH-D0CDF9&pageUID=16386328RULES';

const HEADLESS = !['false', '0', 'no'].includes(
  String(process.env.HEADLESS || 'true').toLowerCase()
);
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT_MS || 12000);
const NAV_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT_MS || 30000);
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'playwright-storage-state.json');
const RAW_JSON_PATH = path.join(DATA_DIR, 'source-cookie-json.json');

const bot = new Telegraf(TOKEN);
const sessions = new Map();
let browser;
let context;
let page;
let busy = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function alertAdmin(ctx, message, error) {
  const detail = error
    ? `\n\nError: ${String(error.message || error).slice(0, 1200)}`
    : '';
  const output = `⚠️ Automation alert\n${message}${detail}`;
  log(output.replace(/\n/g, ' | '));
  try {
    await ctx.reply(output);
  } catch (sendError) {
    log(`Could not send Telegram alert: ${sendError.message}`);
  }
}

function isAuthorized(ctx) {
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
  page.on('pageerror', error => log(`Page error: ${error.message}`));
  page.on('crash', () => log('Browser page crashed.'));
  return page;
}

async function findUniqueLocator(targetPage, primary, fallbacks = [], label = 'element') {
  const candidates = [primary, ...fallbacks].filter(Boolean);

  for (let index = 0; index < candidates.length; index++) {
    const selector = candidates[index];

    try {
      const locator = targetPage.locator(selector);
      const count = await locator.count();
      if (!count) continue;

      const visible = [];
      for (let itemIndex = 0; itemIndex < count; itemIndex++) {
        const item = locator.nth(itemIndex);
        try {
          if (await item.isVisible()) visible.push(item);
        } catch {}
      }

      if (visible.length === 1) {
        if (index > 0) {
          log(`WARNING: fallback ${index} used for ${label}: ${selector}`);
        }
        return { locator: visible[0], selector, fallbackIndex: index, count: 1 };
      }

      if (visible.length > 1) {
        if (index > 0) {
          log(`WARNING: fallback ${index} used for ${label}: ${selector}`);
        }
        return {
          locator,
          selector,
          fallbackIndex: index,
          count: visible.length,
          multiple: true
        };
      }
    } catch (error) {
      log(`Selector error for ${label} (${selector}): ${error.message}`);
    }
  }

  return null;
}

async function clickUnique(targetPage, primary, fallbacks, label) {
  const found = await findUniqueLocator(targetPage, primary, fallbacks, label);
  if (!found) throw new Error(`No selector matched ${label}; no click performed.`);
  if (found.multiple) {
    throw new Error(`Ambiguous selector for ${label}: ${found.count} visible matches.`);
  }
  await found.locator.click();
}

async function readJsonFromMessage(raw) {
  const parsed = JSON.parse(raw);
  let cookies = [];
  let origins = [];

  if (Array.isArray(parsed)) {
    cookies = parsed;
  } else if (parsed && Array.isArray(parsed.cookies)) {
    cookies = parsed.cookies;
    origins = Array.isArray(parsed.origins) ? parsed.origins : [];
  } else {
    throw new Error('Unsupported JSON shape. Send a cookie export array or an object with a cookies array.');
  }

  const normalized = [];
  for (const cookie of cookies) {
    const domain = cookie.domain || cookie.host || cookie.hostname;
    if (!domain || !cookie.name || cookie.value === undefined || cookie.value === null) continue;

    let sameSite = cookie.sameSite;
    if (typeof sameSite === 'number') {
      sameSite = ({ 0: 'None', 1: 'Lax', 2: 'Strict' })[sameSite];
    }
    if (!['Strict', 'Lax', 'None'].includes(sameSite)) sameSite = 'Lax';

    const item = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(domain).startsWith('.') ? String(domain) : `.${domain}`,
      path: cookie.path || '/',
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite
    };

    const expiry = Number(cookie.expirationDate ?? cookie.expires ?? -1);
    if (Number.isFinite(expiry) && expiry >= 0) item.expires = expiry;
    normalized.push(item);
  }

  if (!normalized.length) {
    throw new Error('No usable cookies found. Export cookies for the website where you are already logged in.');
  }

  await ensureDataDir();
  await fs.writeFile(RAW_JSON_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  await fs.writeFile(STATE_PATH, JSON.stringify({ cookies: normalized, origins }, null, 2), { mode: 0o600 });
  return normalized.length;
}

async function loadSavedSession() {
  await ensureDataDir();

  let raw;
  try {
    raw = await fs.readFile(STATE_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  const state = JSON.parse(raw);
  await launchBrowser();
  await context.addCookies(state.cookies || []);

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
}

async function saveCurrentSession() {
  if (!context) throw new Error('Browser session is not active.');
  await ensureDataDir();
  await fs.writeFile(STATE_PATH, JSON.stringify(await context.storageState(), null, 2), { mode: 0o600 });
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
  await ctx.reply('Send the account phone number/email. OTP login requires verified login selectors in .env.');
}

async function handleOtpIdentifier(ctx, identifier) {
  const required = [
    ['LOGIN_OPEN_SELECTOR', process.env.LOGIN_OPEN_SELECTOR],
    ['LOGIN_IDENTIFIER_SELECTOR', process.env.LOGIN_IDENTIFIER_SELECTOR],
    ['LOGIN_SEND_OTP_SELECTOR', process.env.LOGIN_SEND_OTP_SELECTOR]
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    sessions.delete(ctx.chat.id);
    await ctx.reply(`OTP login is not configured. Fill: ${missing.join(', ')}. No login action was taken.`);
    return;
  }

  await launchBrowser();
  await page.goto(process.env.LOGIN_URL || BASE_URL, { waitUntil: 'domcontentloaded' });
  await clickUnique(page, process.env.LOGIN_OPEN_SELECTOR, [], 'login opener');

  const input = await findUniqueLocator(page, process.env.LOGIN_IDENTIFIER_SELECTOR, [], 'login identifier');
  if (!input || input.multiple) throw new Error('Login identifier selector is missing or ambiguous.');
  await input.locator.fill(identifier);
  await clickUnique(page, process.env.LOGIN_SEND_OTP_SELECTOR, [], 'send OTP');

  sessions.set(ctx.chat.id, { mode: 'otp_code' });
  await ctx.reply('Send the OTP received from the website.');
}

async function handleOtpCode(ctx, otp) {
  const inputSelector = process.env.LOGIN_OTP_INPUT_SELECTOR;
  const verifySelector = process.env.LOGIN_VERIFY_OTP_SELECTOR;
  if (!inputSelector || !verifySelector) {
    sessions.delete(ctx.chat.id);
    await ctx.reply('LOGIN_OTP_INPUT_SELECTOR and LOGIN_VERIFY_OTP_SELECTOR must be set in .env.');
    return;
  }

  const input = await findUniqueLocator(page, inputSelector, [], 'OTP input');
  if (!input || input.multiple) throw new Error('OTP input selector is missing or ambiguous.');
  await input.locator.fill(otp.trim());
  await clickUnique(page, verifySelector, [], 'verify OTP');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await saveCurrentSession();
  sessions.delete(ctx.chat.id);
  await ctx.reply('OTP login flow finished and session saved. Verify the account is signed in.', mainKeyboard());
}

async function waitForCartToSettle() {
  // domcontentloaded is not sufficient for a client-rendered cart.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1800);
}

/*
 * Count visible matching controls across primary and fallback selectors.
 * Repeated matches are expected here because every cart item can have a Remove control.
 */
async function getVisibleRemoveControls() {
  const candidates = [
    { selector: selectors.cart.removePrimary, fallbackIndex: 0 },
    ...(selectors.cart.removeFallbacks || []).map((selector, index) => ({
      selector,
      fallbackIndex: index + 1
    }))
  ];

  for (const candidate of candidates) {
    if (!candidate.selector) continue;

    try {
      const locator = page.locator(candidate.selector);
      const count = await locator.count();
      const visible = [];

      for (let index = 0; index < count; index++) {
        const element = locator.nth(index);
        try {
          if (await element.isVisible()) visible.push(element);
        } catch {}
      }

      if (visible.length > 0) {
        if (candidate.fallbackIndex > 0) {
          log(`WARNING: fallback ${candidate.fallbackIndex} used for cart Remove controls: ${candidate.selector}`);
        }
        return {
          selector: candidate.selector,
          fallbackIndex: candidate.fallbackIndex,
          controls: visible
        };
      }
    } catch (error) {
      log(`Cart selector error (${candidate.selector}): ${error.message}`);
    }
  }

  return null;
}

async function collectCartDiagnostics() {
  return {
    url: page.url(),
    title: await page.title().catch(() => 'Unavailable'),
    readyState: await page.evaluate(() => document.readyState).catch(() => 'Unavailable'),
    bodyText: await page.locator('body').innerText().then(text => text.slice(0, 2200)).catch(() => 'Unavailable')
  };
}

async function clearCart(ctx) {
  if (!(await requirePage(ctx))) return;

  await ctx.reply('Opening cart. Waiting for products and checking the Remove controls...');
  await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await waitForCartToSettle();

  log(`Cart requested: ${CART_URL}`);
  log(`Cart loaded: ${page.url()}`);

  let removed = 0;
  let noProgress = 0;
  const maxIterations = 100;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let matches = null;

    // Re-check for a short period on every iteration because cart content may render late.
    for (let attempt = 0; attempt < 4; attempt++) {
      matches = await getVisibleRemoveControls();
      if (matches) break;
      await page.waitForTimeout(1000);
    }

    if (!matches) {
      const diagnostic = await collectCartDiagnostics();
      log(`Cart diagnostics: ${JSON.stringify(diagnostic, null, 2)}`);

      if (removed > 0) {
        await ctx.reply(
          `No visible Remove controls remain after ${removed} removal(s). ` +
          `This may mean the cart is empty. Current page: ${diagnostic.url}`
        );
      } else {
        await alertAdmin(
          ctx,
          `No visible Remove control found after waiting and retrying. ` +
          `URL: ${diagnostic.url}\nTitle: ${diagnostic.title}\n` +
          `Ready state: ${diagnostic.readyState}\n` +
          `Page text: ${diagnostic.bodyText}`
        );
      }
      return;
    }

    const beforeCount = matches.controls.length;
    const target = matches.controls[0];

    try {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: ACTION_TIMEOUT });
    } catch (error) {
      await alertAdmin(
        ctx,
        `Could not click a visible Remove control using selector: ${matches.selector}. Stopping without retry-clicking.`,
        error
      );
      return;
    }

    // Give React/Vue/server updates time to update the cart after the click.
    await page.waitForTimeout(900);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(700);

    let afterMatches = await getVisibleRemoveControls();
    let afterCount = afterMatches ? afterMatches.controls.length : 0;

    // If the count did not change immediately, allow a longer update window and re-check.
    if (afterCount >= beforeCount) {
      await page.waitForTimeout(1800);
      afterMatches = await getVisibleRemoveControls();
      afterCount = afterMatches ? afterMatches.controls.length : 0;
    }

    if (afterCount < beforeCount) {
      removed++;
      noProgress = 0;
      log(`Cart removal ${removed} confirmed by visible control count: ${beforeCount} -> ${afterCount}`);
      await ctx.reply(`Removed ${removed} item(s). Checking the next product...`);
    } else {
      noProgress++;
      log(`Cart removal progress not confirmed (${noProgress}/2). Visible Remove controls: ${beforeCount} -> ${afterCount}`);

      if (noProgress >= 2) {
        const diagnostic = await collectCartDiagnostics();
        await alertAdmin(
          ctx,
          `Clicked Remove, but the visible Remove-control count did not decrease twice. ` +
          `Stopped to avoid repeatedly clicking without confirmation.\n` +
          `URL: ${diagnostic.url}\nPage text: ${diagnostic.bodyText}`
        );
        return;
      }
    }
  }

  await alertAdmin(ctx, `Cart cleanup reached the safety limit of ${maxIterations} iterations. ${removed} item(s) were confirmed removed.`);
}

async function clearWishlist(ctx) {
  if (!(await requirePage(ctx))) return;

  const itemSelector = process.env.WISHLIST_ITEM_SELECTOR;
  const removeSelector = process.env.WISHLIST_REMOVE_SELECTOR;
  if (!itemSelector || !removeSelector) {
    await ctx.reply('Wishlist selectors are not configured yet. Set WISHLIST_ITEM_SELECTOR and WISHLIST_REMOVE_SELECTOR in .env.');
    return;
  }

  await page.goto(WISHLIST_URL, { waitUntil: 'domcontentloaded' });
  await waitForCartToSettle();

  let removed = 0;
  for (let iteration = 0; iteration < 100; iteration++) {
    const items = page.locator(itemSelector);
    const count = await items.count();

    if (count === 0) {
      await ctx.reply(`Wishlist appears empty. Confirmed removed: ${removed}.`);
      return;
    }

    const remove = items.first().locator(removeSelector);
    const removeCount = await remove.count();
    if (removeCount !== 1) {
      await alertAdmin(ctx, `Wishlist remove selector matched ${removeCount} controls inside the first item. No click performed.`);
      return;
    }

    await remove.click();
    await page.waitForTimeout(1000);

    const after = await items.count();
    if (after < count) {
      removed++;
    } else {
      await alertAdmin(ctx, 'Wishlist item count did not decrease after clicking Remove. Stopping.');
      return;
    }
  }

  await alertAdmin(ctx, 'Wishlist cleanup reached the 100-iteration safety limit.');
}

async function runChallenges(ctx) {
  if (!(await requirePage(ctx))) return;

  const missing = Object.entries(selectors.challenges)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    await ctx.reply(
      `Challenge automation is paused until selectors are supplied: ${missing.join(', ')}. ` +
      `No challenge actions were taken.`
    );
    return;
  }

  await page.goto(CHALLENGE_URL, { waitUntil: 'domcontentloaded' });
  await alertAdmin(ctx, 'Challenge selectors are present, but task completion-state signals and page transitions still need to be configured before automatic actions are enabled.');
}

async function resetSession(ctx) {
  await closeBrowser();
  for (const file of [STATE_PATH, RAW_JSON_PATH]) {
    try { await fs.unlink(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  sessions.delete(ctx.chat.id);
  await ctx.reply('Saved session deleted. Choose a login method for the next account.', loginKeyboard());
}

bot.use(async (ctx, next) => {
  if (!guard(ctx)) return;
  return next();
});

bot.start(async ctx => {
  try {
    const loaded = await loadSavedSession();
    await ctx.reply(loaded ? 'Saved session found. Choose an action.' : 'Choose a login method.', loaded ? mainKeyboard() : loginKeyboard());
  } catch (error) {
    await alertAdmin(ctx, 'Could not load saved session.', error);
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
  await ctx.reply('Send the cookie JSON as a text message or attach a .json file. Do not send account passwords.');
});

bot.action('wishlist_clear', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await clearWishlist(ctx); }
  catch (error) { await alertAdmin(ctx, 'Wishlist cleanup failed.', error); }
  finally { busy = false; }
});

bot.action('cart_clear', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await clearCart(ctx); }
  catch (error) { await alertAdmin(ctx, 'Cart cleanup failed.', error); }
  finally { busy = false; }
});

bot.action('challenges_run', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Another task is running. Try again after it finishes.');
  busy = true;
  try { await runChallenges(ctx); }
  catch (error) { await alertAdmin(ctx, 'Challenge run failed.', error); }
  finally { busy = false; }
});

bot.action('session_reset', async ctx => {
  await ctx.answerCbQuery();
  if (busy) return ctx.reply('Wait for the current action to finish before resetting the session.');
  try { await resetSession(ctx); }
  catch (error) { await alertAdmin(ctx, 'Could not reset session.', error); }
});

bot.on('document', async ctx => {
  const state = sessions.get(ctx.chat.id);
  if (!state || state.mode !== 'json_input') return;

  const document = ctx.message.document;
  if (!document.file_name?.toLowerCase().endsWith('.json')) {
    await ctx.reply('Please attach a .json file.');
    return;
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(document.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    const count = await readJsonFromMessage(await response.text());
    sessions.delete(ctx.chat.id);
    await loadSavedSession();
    await ctx.reply(`Imported ${count} cookies and created the Playwright session. Confirm the site is logged in, then choose an action.`, mainKeyboard());
  } catch (error) {
    await alertAdmin(ctx, 'Could not import cookie JSON file.', error);
  }
});

bot.on('text', async ctx => {
  const state = sessions.get(ctx.chat.id);
  if (!state) return;

  try {
    if (state.mode === 'json_input') {
      const count = await readJsonFromMessage(ctx.message.text.trim());
      sessions.delete(ctx.chat.id);
      await loadSavedSession();
      await ctx.reply(`Imported ${count} cookies and created the Playwright session. Confirm the site is logged in, then choose an action.`, mainKeyboard());
    } else if (state.mode === 'otp_identifier') {
      await handleOtpIdentifier(ctx, ctx.message.text.trim());
    } else if (state.mode === 'otp_code') {
      await handleOtpCode(ctx, ctx.message.text.trim());
    }
  } catch (error) {
    sessions.delete(ctx.chat.id);
    await alertAdmin(ctx, 'Login flow failed.', error);
  }
});

bot.catch(async (error, ctx) => {
  log(`Telegram bot error: ${error.message}`);
  if (ctx) await alertAdmin(ctx, 'Unexpected Telegram bot error.', error);
});

process.once('SIGINT', async () => {
  await closeBrowser();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  await closeBrowser();
  bot.stop('SIGTERM');
});

bot.launch()
  .then(() => log('Telegram bot started.'))
  .catch(error => {
    console.error('Bot failed to start:', error);
    process.exit(1);
  });
