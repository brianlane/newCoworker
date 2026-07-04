/**
 * AiFlow render service — headless-Chromium browse backend for AiFlows.
 *
 * The default AiFlows browse backend is a static fetch inside the ai-flow-worker.
 * For JS-rendered (SPA) pages a static fetch can't read, AND for LOGIN-GATED
 * pages a static fetch can't authenticate, this service is deployed PER-TENANT
 * (one sidecar per business VPS). The shared worker resolves it via:
 *
 *   AIFLOW_RENDER_URL_TEMPLATE=https://render-{businessId}.<zone>/render  (worker secret)
 *   AIFLOW_RENDER_TOKEN=<shared-bearer>                                   (worker + this service)
 *
 * Contract (matches supabase/functions/_shared/ai_flows/browse.ts):
 *   POST /render { url }                              -> { finalUrl, text, html }
 *   POST /render { url, businessId, auth }            -> { finalUrl, text, html }
 *   ... + { screenshot: true }                        -> adds screenshotBase64 (JPEG)
 *   ... + { debugScreenshots: true }                  -> before/after/failure shots
 *                                                        + paired pageSource /
 *                                                        pageSourceBefore (HTML) on
 *                                                        failure responses
 *   ... + { actions: [...] }                          -> ACTION mode (below)
 *
 * IMPORTANT — application-level failures (action_failed / login_failed /
 * auth_config_error / render_failed) are returned with HTTP **200** and an
 * `{ error, detail }` body, NOT a 5xx. This service runs behind a Cloudflare
 * Tunnel, and Cloudflare REPLACES the body of any origin 5xx with its own
 * "error code: 502" page — which would erase the structured error and make the
 * worker retry a permanent failure. The worker classifies on the `error` code
 * (see renderErrorKind) and treats a genuine non-2xx as a transport failure.
 * Only client errors (400/401) keep their status — Cloudflare passes 4xx through.
 *
 * When `auth` is present the service logs in first using the named custom
 * integration's stored credentials (fetched from the platform's gateway-guarded
 * /api/integrations/custom/credentials endpoint), reusing a per-tenant browser
 * context so the session cookie is cached across calls.
 *
 * EXTRACT mode (no `actions`) only READS the page — it fills + submits the
 * login form and never clicks lead-page buttons. ACTION mode (the worker's
 * browse_action step) performs an owner-authored ordered click/fill sequence —
 * e.g. posting a "still trying to contact" update on a lead timeline — and
 * returns { finalUrl, actionsCompleted, text, html } (+ screenshotBase64 when
 * asked) so the worker can extract fields in the same pass. Each action is
 * { kind: click_text | click_selector | fill_selector | fill_placeholder |
 * click_text_while_present, target, value? }; the FIRST failing action aborts
 * with { error: "action_failed", detail, actionsCompleted }.
 * `click_text_while_present` clicks `target` until it's gone (bounded) and
 * treats zero matches as success.
 *
 * SSRF guard mirrors the worker's normalizeBrowseUrl: only http(s), no
 * localhost / private IPv4 / IPv6-literal / *.internal / metadata hosts. Every
 * browser request (initial nav, redirects, subresources) is re-validated.
 *
 * Env:
 *   PORT                       default 8080
 *   AIFLOW_RENDER_TIMEOUT_MS   per-navigation timeout, default 30000
 *   AIFLOW_RENDER_TOKEN        if set, required as `Authorization: Bearer` on /render
 *   AIFLOW_PLATFORM_URL        platform base URL for credential lookups (auth mode)
 *   AIFLOW_GATEWAY_TOKEN       bearer for the platform credentials endpoint
 *   AIFLOW_SESSION_TTL_MS      idle context eviction, default 1800000 (30m)
 *   AIFLOW_MAX_SESSIONS        max cached contexts, default 50
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 8080);
const NAV_TIMEOUT_MS = Number(process.env.AIFLOW_RENDER_TIMEOUT_MS ?? 30000);
const RENDER_TOKEN = process.env.AIFLOW_RENDER_TOKEN ?? "";
const PLATFORM_URL = (process.env.AIFLOW_PLATFORM_URL ?? "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.AIFLOW_GATEWAY_TOKEN ?? "";
const SESSION_TTL_MS = Number(process.env.AIFLOW_SESSION_TTL_MS ?? 30 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.AIFLOW_MAX_SESSIONS ?? 50);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function safeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return null;
  if (h === "metadata" || h === "metadata.google.internal" || h.endsWith(".internal")) return null;
  if (h.includes(":")) return null;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) && isPrivateIpv4(h)) return null;
  return url.toString();
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// Rate-limit every request (before auth) so a leaked/guessed bearer can't be
// brute-forced and a single caller can't exhaust the headless-Chromium pool.
// Each render spins up a browser page, so the ceiling is deliberately modest.
const RATE_WINDOW_MS = Number(process.env.AIFLOW_RATE_WINDOW_MS ?? 60_000);
const RATE_MAX = Number(process.env.AIFLOW_RATE_MAX ?? 120);
app.use(
  rateLimit({
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false
  })
);

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  return browserPromise;
}

/**
 * Per-tenant browser contexts keyed by `${businessId}:${label}`, so a logged-in
 * session cookie is reused across calls instead of re-logging in every time.
 *
 * Each entry stores a context PROMISE (so concurrent first-callers dedupe to one
 * context instead of leaking duplicates) plus an `inUse` refcount. Only idle
 * entries (`inUse === 0`) are ever evicted/closed, so we never yank a context out
 * from under an in-flight request. Eviction is best-effort and never awaited.
 */
const sessions = new Map(); // key -> { ctx: Promise<BrowserContext>, lastUsed, inUse }

function closeEntry(s) {
  Promise.resolve(s.ctx)
    .then((c) => c.close())
    .catch(() => {});
}

function evictStale() {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.inUse === 0 && now - s.lastUsed > SESSION_TTL_MS) {
      sessions.delete(key);
      closeEntry(s);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const idle = [...sessions.entries()]
      .filter(([, s]) => s.inUse === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (sessions.size > MAX_SESSIONS && idle.length) {
      const [key, s] = idle.shift();
      sessions.delete(key);
      closeEntry(s);
    }
  }
}

/**
 * Acquire (creating if needed) the per-tenant session, bumping its refcount, and
 * return the entry itself (so release/finish operate on the shared object even
 * after a poisoned session is removed from the map).
 */
async function acquireSession(key) {
  let s = sessions.get(key);
  if (!s) {
    const browser = await getBrowser();
    s = { ctx: browser.newContext({ userAgent: UA }), lastUsed: Date.now(), inUse: 0, doomed: false };
    sessions.set(key, s);
  }
  s.inUse++;
  s.lastUsed = Date.now();
  evictStale();
  try {
    s.context = await s.ctx;
    return s;
  } catch (e) {
    // Context creation failed — drop the poisoned entry so we retry cleanly.
    s.inUse--;
    if (sessions.get(key) === s) sessions.delete(key);
    throw e;
  }
}

/**
 * Release a session after a request finishes. On `poisoned` (bad login / render
 * error) the entry is removed from the map so no NEW request reuses it, but the
 * underlying context is only closed once the LAST in-flight request releases it
 * (inUse === 0) — never yanked out from under a concurrent authed browse.
 */
function finishSession(key, s, poisoned) {
  s.inUse = Math.max(0, s.inUse - 1);
  s.lastUsed = Date.now();
  if (poisoned) {
    s.doomed = true;
    if (sessions.get(key) === s) sessions.delete(key);
  }
  if (s.doomed && s.inUse === 0) closeEntry(s);
}

function attachSsrfGuard(page) {
  return page.route("**/*", (route) => {
    if (safeUrl(route.request().url())) route.continue();
    else route.abort("blockedbyclient");
  });
}

/** Fetch decrypted credentials for a custom integration from the platform. */
async function fetchCredentials(businessId, label) {
  if (!PLATFORM_URL || !GATEWAY_TOKEN) throw new Error("credentials_endpoint_not_configured");
  const res = await fetch(
    `${PLATFORM_URL}/api/integrations/custom/credentials?businessId=${encodeURIComponent(businessId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ label })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok) throw new Error(`credentials_lookup_failed:${body?.detail ?? res.status}`);
  return { username: body.data?.username ?? "", password: body.data?.password ?? "" };
}

/** First selector in `candidates` that matches an element on the page, else null. */
async function firstSelector(page, candidates) {
  for (const sel of candidates) {
    if (!sel) continue;
    if (await page.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[name*="user" i]'
];

/**
 * True only when the page looks like an actual login FORM: a password field AND a
 * username/email field. Requiring both avoids treating an authenticated page that
 * merely embeds a stray password input (e.g. a "change password" widget) as a
 * logout, which would otherwise trigger a pointless re-login loop.
 */
async function looksLikeLogin(page, login) {
  const hasPass =
    (await page
      .locator(login?.passwordSelector ?? 'input[type="password"]')
      .count()
      .catch(() => 0)) > 0;
  if (!hasPass) return false;
  const userSel = login?.usernameSelector
    ? [login.usernameSelector]
    : USERNAME_SELECTORS;
  return (await firstSelector(page, userSel)) !== null;
}

async function performLogin(page, creds, login) {
  const userSel = await firstSelector(page, [
    login?.usernameSelector,
    ...USERNAME_SELECTORS,
    'input[type="text"]'
  ]);
  const passSel = await firstSelector(page, [login?.passwordSelector, 'input[type="password"]']);
  if (!userSel || !passSel) throw new Error("login_form_not_found");
  await page.fill(userSel, creds.username);
  await page.fill(passSel, creds.password);
  const submitSel = await firstSelector(page, [
    login?.submitSelector,
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Login")'
  ]);
  if (submitSel) await page.locator(submitSel).first().click().catch(() => {});
  else await page.locator(passSel).press("Enter");
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
}

app.use((req, res, next) => {
  if (!RENDER_TOKEN) return next();
  if (req.path === "/health") return next();
  const auth = req.headers.authorization ?? "";
  if (auth === `Bearer ${RENDER_TOKEN}`) return next();
  return res.status(401).json({ error: "unauthorized" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Full-page screenshots of long lead pages can run to many MB; cap the height
// so the JPEG stays small enough to store, sign, and email as an attachment.
const SCREENSHOT_MAX_HEIGHT = Number(process.env.AIFLOW_SCREENSHOT_MAX_HEIGHT ?? 4000);
const SCREENSHOT_QUALITY = Number(process.env.AIFLOW_SCREENSHOT_QUALITY ?? 60);

// Captured page-source (HTML) accompanies each debug screenshot so the dashboard
// can link the raw markup behind a failure. Bound it so a pathological page can't
// bloat the render JSON / storage object (the bucket itself caps at 10 MB).
const SOURCE_MAX_CHARS = Number(process.env.AIFLOW_SOURCE_MAX_CHARS ?? 4_000_000);

// ACTION mode: per-action click/fill timeout and a hard cap on sequence length
// (mirrors the worker-side schema cap so a hand-crafted request can't loop).
const ACTION_TIMEOUT_MS = Number(process.env.AIFLOW_ACTION_TIMEOUT_MS ?? 10_000);
const MAX_ACTIONS = 15;
// Upper bound on click_text_while_present iterations so a perpetually-present
// target (or a re-rendering label) can never spin forever.
const MAX_WHILE_PRESENT_CLICKS = Number(process.env.AIFLOW_MAX_WHILE_PRESENT_CLICKS ?? 10);
// Shorter per-probe timeout for the "is the target still there?" check: once
// the button is gone we want to fall through quickly, not wait the full
// ACTION_TIMEOUT_MS for a locator that will never resolve.
const WHILE_PRESENT_PROBE_MS = Number(process.env.AIFLOW_WHILE_PRESENT_PROBE_MS ?? 2_000);
// Hard cap on forEachLink list items so one request can't enumerate an unbounded
// page of links and run the action sequence hundreds of times.
const MAX_FOREACH_ITEMS = Number(process.env.AIFLOW_MAX_FOREACH_ITEMS ?? 25);
const ACTION_KINDS = new Set([
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder",
  "click_text_while_present",
  "click_role",
  "select_option"
]);

// Kinds whose `value` is REQUIRED (a fill string, an ARIA name, an option value).
// fill_placeholder is intentionally NOT here: clearing a field with "" is valid.
const ACTION_KINDS_REQUIRING_VALUE = new Set(["click_role", "select_option"]);

/** Normalize + validate the request's actions array, or null when malformed. */
function parseActions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACTIONS) return null;
  const out = [];
  for (const a of raw) {
    const kind = String(a?.kind ?? "");
    const target = String(a?.target ?? "");
    const value = String(a?.value ?? "");
    if (!ACTION_KINDS.has(kind) || !target) return null;
    if (ACTION_KINDS_REQUIRING_VALUE.has(kind) && !value) return null;
    out.push({ kind, target, value });
  }
  return out;
}

/**
 * Resolve a "click this text" target to an actual control. The whole point is to
 * stop the matcher from latching onto descriptive body copy that merely contains
 * the word — e.g. a "click Accept" action hitting the subtitle "…then accept or
 * reject." or a "Next" wizard loop hitting the sentence "…on the next screen…".
 * (That Accept case is real: an already-claimed Clever Offers page has no Accept
 * button but its description says "…then accept or reject", and a loose
 * substring match happily "clicked" that sentence, so the step succeeded and the
 * worker's skipWhenText already-claimed guard never ran.)
 *
 * Substring matches therefore ONLY ever resolve to a real INTERACTIVE control —
 * by substring accessible name or substring text scoped to interactive elements
 * — so labels with trailing glyphs ("Next →", "Accept ✓") still match while
 * prose (<p>/<span>) never does. Returns null when no control matches; callers
 * fail the action (single click) or treat it as "step done" (while-present).
 *
 * Two modes:
 *   - `allowExactTextAnywhere: true` (single `click_text`): an element whose
 *     ENTIRE text is exactly the target may match even when it isn't a semantic
 *     control (legacy: clickable divs whose handlers aren't visible in the DOM).
 *   - `allowExactTextAnywhere: false` (`click_text_while_present`): exact-text
 *     matches must also land on an interactive element.
 *
 * Returns a Locator (callers .click()/.waitFor() it) or null.
 */
async function resolveClickTarget(page, target, { allowExactTextAnywhere = true } = {}) {
  // 1) A real control whose ACCESSIBLE NAME is exactly the target.
  const byRoleExact = page
    .getByRole("button", { name: target, exact: true })
    .or(page.getByRole("link", { name: target, exact: true }));
  if ((await byRoleExact.count()) > 0) return byRoleExact.first();

  // Interactive controls: text matches must land on one of these (except the
  // legacy exact-text-anywhere case), so a static node reading "Next" can't
  // drive a loop and prose containing the word can't be "clicked".
  const interactive = page.locator(
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="button"], input[type="submit"], [onclick]',
  );

  // 2) Exact visible text: anywhere for a single click, controls-only for the
  //    while-present loop.
  const byExactText = page.getByText(target, { exact: true });
  const byExactAllowed = allowExactTextAnywhere ? byExactText : byExactText.and(interactive);
  if ((await byExactAllowed.count()) > 0) return byExactAllowed.first();

  // 3) Control whose label CONTAINS the target (e.g. "Next →", "Next Page"):
  //    substring accessible name, or any interactive element whose text contains
  //    the target. `interactive` keeps this off sentences like "…next screen…".
  const byRoleSubstr = page
    .getByRole("button", { name: target })
    .or(page.getByRole("link", { name: target }));
  if ((await byRoleSubstr.count()) > 0) return byRoleSubstr.first();
  const bySubstrControl = page.getByText(target, { exact: false }).and(interactive);
  if ((await bySubstrControl.count()) > 0) return bySubstrControl.first();

  return null;
}

/**
 * Run the ordered click/fill sequence. Stops at the FIRST failing action and
 * reports how far it got, so the worker can surface exactly which action broke
 * (a changed page is a permanent error, not a retry). After every action we
 * wait for network idle (best-effort) so a click that opens a dialog / posts a
 * form settles before the next action targets the new DOM.
 */
async function performActions(page, actions) {
  let completed = 0;
  for (const a of actions) {
    try {
      if (a.kind === "click_text") {
        // Prefer a real button/link (or exact-text element); substring matches
        // resolve ONLY to interactive controls so body copy that merely
        // contains the word (e.g. "…then accept or reject.") can never be
        // "clicked" into a phantom success.
        const loc = await resolveClickTarget(page, a.target, { allowExactTextAnywhere: true });
        if (!loc) throw new Error("no matching control on the page");
        await loc.click({ timeout: ACTION_TIMEOUT_MS });
      } else if (a.kind === "click_text_while_present") {
        // Wizard-style "Next" loop: click the control as long as it is visible,
        // bounded by MAX_WHILE_PRESENT_CLICKS. Resolves ONLY to real controls
        // (no substring fallback) so it can't latch onto prose that contains the
        // word (e.g. "…on the next screen…"). Zero matches is SUCCESS — the page
        // is already past the step.
        const isPresent = async () => {
          const loc = await resolveClickTarget(page, a.target, { allowExactTextAnywhere: false });
          if (!loc) return false;
          try {
            await loc.waitFor({ state: "visible", timeout: WHILE_PRESENT_PROBE_MS });
            return true;
          } catch {
            return false;
          }
        };
        let clicks = 0;
        while (clicks < MAX_WHILE_PRESENT_CLICKS && (await isPresent())) {
          const loc = await resolveClickTarget(page, a.target, { allowExactTextAnywhere: false });
          if (!loc) break;
          await loc.click({ timeout: ACTION_TIMEOUT_MS });
          await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
          clicks++;
        }
        // Hitting the cap WHILE the target is still on the page means the wizard
        // never finished — fail the action so the worker doesn't extract from a
        // half-completed page (a changed/looping page is a permanent error).
        if (clicks >= MAX_WHILE_PRESENT_CLICKS && (await isPresent())) {
          throw new Error(`still present after ${MAX_WHILE_PRESENT_CLICKS} clicks`);
        }
      } else if (a.kind === "click_selector") {
        await page.locator(a.target).first().click({ timeout: ACTION_TIMEOUT_MS });
      } else if (a.kind === "click_role") {
        // target = ARIA role, value = accessible name (e.g. a calendar day cell
        // "Choose Thursday, June 18th, 2026"). Name match is case-insensitive
        // substring so authors don't have to reproduce the exact label.
        await page
          .getByRole(a.target, { name: a.value, exact: false })
          .first()
          .click({ timeout: ACTION_TIMEOUT_MS });
      } else if (a.kind === "select_option") {
        // target = CSS selector for the <select>, value = option value OR label.
        await page
          .locator(a.target)
          .first()
          .selectOption({ label: a.value }, { timeout: ACTION_TIMEOUT_MS })
          .catch(() =>
            page.locator(a.target).first().selectOption(a.value, { timeout: ACTION_TIMEOUT_MS })
          );
      } else if (a.kind === "fill_selector") {
        await page.locator(a.target).first().fill(a.value, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page
          .getByPlaceholder(a.target, { exact: false })
          .first()
          .fill(a.value, { timeout: ACTION_TIMEOUT_MS });
      }
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      completed++;
    } catch (e) {
      return {
        completed,
        error: `${a.kind} "${a.target}": ${String(e?.message ?? e)}`.slice(0, 300)
      };
    }
  }
  return { completed };
}

// How long settlePage waits for a JS-rendered (SPA) page to actually paint
// content before we screenshot / read / act on it. networkidle alone fires on
// the empty app shell, which is why early captures came back blank-white and
// extraction returned empty fields.
const SETTLE_TIMEOUT_MS = Number(process.env.AIFLOW_SETTLE_TIMEOUT_MS ?? 8000);
const SETTLE_MIN_TEXT = Number(process.env.AIFLOW_SETTLE_MIN_TEXT ?? 40);
const SETTLE_POST_DELAY_MS = Number(process.env.AIFLOW_SETTLE_POST_DELAY_MS ?? 600);

/**
 * Wait for an SPA to finish painting before we capture/read/act. Best-effort
 * and bounded — a page that never fills in still proceeds after the timeout so
 * a slow render degrades to "maybe blank" rather than a hang. Steps:
 *   1) wait for the `load` event (subresources), then
 *   2) poll until the body has real visible text (> SETTLE_MIN_TEXT chars), then
 *   3) a short fixed delay so late layout/fonts settle before the shot.
 * Never throws.
 */
async function settlePage(page) {
  try {
    await page.waitForLoadState("load", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await page
      .waitForFunction(
        (min) => (document.body?.innerText?.trim().length ?? 0) > min,
        SETTLE_MIN_TEXT,
        { timeout: SETTLE_TIMEOUT_MS }
      )
      .catch(() => {});
    if (SETTLE_POST_DELAY_MS > 0) await page.waitForTimeout(SETTLE_POST_DELAY_MS);
  } catch {
    // A settle failure must never break the browse — proceed with whatever
    // rendered so text/screenshots still flow.
  }
}

/**
 * Read the page's visible text for extraction, with image ALT text inlined at
 * each image's position. Some lead pages render a key value ONLY as a logo
 * image (e.g. ReferralExchange's "Web Source" row shows
 * `<img alt="realestateagents">` with no text sibling), which
 * `document.body.innerText` drops entirely — so the worker's Gemini extraction
 * could never see it. A text node is inserted after each alt-bearing image,
 * innerText is read, then the markers are removed — all inside ONE evaluate
 * call, so no screenshot or page.content() capture can observe the mutation.
 * Best-effort: returns "" instead of throwing, like the reads it replaces.
 */
async function readPageText(page) {
  try {
    return await page.evaluate(() => {
      const marks = [];
      for (const img of Array.from(document.images)) {
        const alt = (img.getAttribute("alt") || "").trim();
        if (!alt) continue;
        const mark = document.createTextNode(` ${alt} `);
        img.after(mark);
        marks.push(mark);
      }
      const text = document.body?.innerText ?? "";
      for (const mark of marks) mark.remove();
      return text;
    });
  } catch {
    return "";
  }
}

/** Capture a height-capped full-width JPEG of the page as base64, or null. */
async function captureScreenshot(page) {
  try {
    const size = await page.evaluate(() => ({
      width: Math.min(document.documentElement.scrollWidth || 1280, 1920),
      height: document.documentElement.scrollHeight || 720
    }));
    const buf = await page.screenshot({
      type: "jpeg",
      quality: SCREENSHOT_QUALITY,
      clip: {
        x: 0,
        y: 0,
        width: Math.max(size.width, 320),
        height: Math.max(Math.min(size.height, SCREENSHOT_MAX_HEIGHT), 240)
      }
    });
    return buf.toString("base64");
  } catch {
    // A failed screenshot must not fail the browse — text/html still flow.
    return null;
  }
}

/**
 * Capture the page's current HTML source (length-capped), or null. Best-effort:
 * paired with a debug screenshot so the dashboard can link "View page source"
 * for the exact page state the shot was taken on. Never throws.
 */
async function capturePageSource(page) {
  try {
    const html = await page.content();
    return typeof html === "string" ? html.slice(0, SOURCE_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * Loop-over-list: collect every `forEachLink` row's href up front (the list
 * page is replaced as we navigate into each), then visit each href and run the
 * SAME action sequence. Per-item failures are recorded but DON'T abort the loop
 * — a weekly bulk update shouldn't stop because one lead's page changed.
 */
async function performForEach(page, forEachLink, actions, matchNames) {
  let hrefs = [];
  try {
    hrefs = await page.evaluate(
      ({ sel, names }) => {
        // `names` is an ARRAY when the caller requested a name filter (act only
        // on rows naming one of them) or NULL when no filter was requested (act
        // on every row). A filter that's present but empty therefore matches
        // NOTHING — we never silently fall back to acting on every row.
        const filtering = Array.isArray(names);
        const wanted = filtering
          ? names.map((n) => String(n).toLowerCase()).filter(Boolean)
          : [];
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll(sel)) {
          const a = el.matches("a[href]") ? el : el.closest("a[href]");
          const href = a && a.href ? a.href : null;
          if (!href || seen.has(href)) continue;
          if (filtering) {
            // Match against the row's text (the anchor when available, else the
            // matched element) so we only act on rows naming a requested lead.
            const text = ((a || el).textContent || "").toLowerCase();
            if (!wanted.some((n) => text.includes(n))) continue;
          }
          seen.add(href);
          out.push(href);
        }
        return out;
      },
      { sel: forEachLink, names: matchNames }
    );
  } catch (e) {
    return {
      items: 0,
      succeeded: 0,
      failed: 0,
      actionsCompleted: 0,
      errors: [`forEachLink "${forEachLink}": ${String(e?.message ?? e)}`.slice(0, 200)]
    };
  }
  // Report the TRUE match count and surface any overflow as failures so the
  // worker never logs a misleading "updated N of N" while silently skipping
  // leads past the cap. (`items` stays the pre-slice total; the skipped tail is
  // counted as failed with an explicit error.)
  const totalMatched = hrefs.length;
  hrefs = hrefs.slice(0, MAX_FOREACH_ITEMS);
  const skipped = totalMatched - hrefs.length;
  let succeeded = 0;
  let failed = skipped;
  let actionsCompleted = 0;
  const errors = [];
  if (skipped > 0) {
    errors.push(
      `forEachLink matched ${totalMatched} items; capped at ${MAX_FOREACH_ITEMS}, ${skipped} not processed`
    );
  }
  for (const href of hrefs) {
    try {
      await page.goto(href, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      await settlePage(page);
    } catch (e) {
      failed++;
      errors.push(`goto ${href}: ${String(e?.message ?? e)}`.slice(0, 200));
      continue;
    }
    const acted = await performActions(page, actions);
    actionsCompleted += acted.completed;
    if (acted.error) {
      failed++;
      errors.push(`${href}: ${acted.error}`.slice(0, 200));
    } else {
      succeeded++;
    }
  }
  return { items: totalMatched, succeeded, failed, actionsCompleted, errors: errors.slice(0, 20) };
}

/**
 * Respond for ACTION mode: run the sequence and reply with how far it got.
 * Returns true (response sent). An action failure is reported as
 * `action_failed` so the worker fails the run permanently instead of retrying
 * a selector that no longer matches. When `forEachLink` is set, loops the
 * sequence over every matching list row instead.
 */
async function respondWithActions(
  page,
  res,
  actions,
  wantScreenshot,
  forEachLink,
  wantDebug,
  forEachMatch
) {
  if (forEachLink) {
    const fe = await performForEach(page, forEachLink, actions, forEachMatch);
    return res.json({
      finalUrl: page.url(),
      actionsCompleted: fe.actionsCompleted,
      forEach: {
        items: fe.items,
        succeeded: fe.succeeded,
        failed: fe.failed,
        errors: fe.errors
      },
      text: "",
      html: ""
    });
  }
  // When debug capture is on, snapshot the page as it loaded, BEFORE the action
  // sequence runs. On a failure this "what did we land on" shot pairs with the
  // "where did we get stuck" shot below. Skipped entirely when debug is off so
  // flows that don't opt in pay no extra capture latency.
  const beforeBase64 = wantDebug ? await captureScreenshot(page) : null;
  // Page source paired with the before-shot, so the dashboard can link the exact
  // markup the automation was about to act on. Debug-only, like the before-shot.
  const beforeSource = wantDebug ? await capturePageSource(page) : null;
  const acted = await performActions(page, actions);
  if (acted.error) {
    console.error(`[render] action_failed after ${acted.completed} actions: ${acted.error}`);
    // ALWAYS grab a diagnostic screenshot + source of the stuck page on an action
    // failure (the rare path), regardless of the screenshot/debug opt-in: the
    // owner needs to see WHERE the automation broke (e.g. a wizard "Next" that
    // never advanced), and the worker matches this source against a step's
    // skipWhenText to recognize terminal pages (e.g. a lead already claimed) and
    // end the run gracefully. The before-shot above stays debug-only to bound
    // cost on the happy path. Best effort — a capture failure must not mask
    // action_failed.
    await settlePage(page);
    const screenshotBase64 = await captureScreenshot(page);
    const pageSource = await capturePageSource(page);
    return res.status(200).json({
      error: "action_failed",
      detail: acted.error,
      actionsCompleted: acted.completed,
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(pageSource ? { pageSource } : {}),
      ...(beforeBase64 ? { screenshotBeforeBase64: beforeBase64 } : {}),
      ...(beforeSource ? { pageSourceBefore: beforeSource } : {})
    });
  }
  // Return the post-action page text/html alongside the count so the worker can
  // extract lead fields in the SAME credentialed pass that accepted the lead
  // (no second navigation). Best-effort: a read failure still reports success.
  let text = "";
  let html = "";
  await settlePage(page);
  try {
    html = await page.content();
    text = await readPageText(page);
  } catch {
    text = "";
    html = "";
  }
  const screenshotBase64 =
    wantScreenshot || wantDebug ? await captureScreenshot(page) : null;
  return res.json({
    finalUrl: page.url(),
    actionsCompleted: acted.completed,
    text,
    html,
    ...(screenshotBase64 ? { screenshotBase64 } : {})
  });
}

app.post("/render", async (req, res) => {
  const safe = safeUrl(String(req.body?.url ?? ""));
  if (!safe) return res.status(400).json({ error: "invalid_or_unsafe_url" });
  const auth = req.body?.auth;
  const businessId = req.body?.businessId;
  const wantScreenshot = req.body?.screenshot === true;
  // Per-flow visibility opt-in: capture before/after/failure shots for the
  // dashboard "investigate" view. Off by default so most flows pay nothing.
  const wantDebug = req.body?.debugScreenshots === true;
  const rawActions = req.body?.actions;
  const actions = rawActions === undefined ? null : parseActions(rawActions);
  if (rawActions !== undefined && !actions) {
    return res.status(400).json({ error: "invalid_actions" });
  }
  // forEachLink loops `actions` over every matching list row; it therefore
  // REQUIRES an actions array. Bound the selector length defensively.
  const forEachRaw = req.body?.forEachLink;
  const forEachLink =
    typeof forEachRaw === "string" && forEachRaw.trim() && forEachRaw.length <= 200
      ? forEachRaw.trim()
      : null;
  if (forEachRaw !== undefined && !forEachLink) {
    return res.status(400).json({ error: "invalid_for_each_link" });
  }
  if (forEachLink && !actions) {
    return res.status(400).json({ error: "invalid_actions" });
  }
  // Optional name filter for the forEachLink loop: a list of strings; rows whose
  // text contains one of them are acted on. An ABSENT filter (undefined) means
  // "act on every row" (the weekly bulk update); a PRESENT-but-empty array means
  // the caller asked to filter and nothing matched, so we must act on NOTHING.
  // We therefore keep `forEachMatch` as null (no filter) vs an array (filter,
  // possibly empty). Each name is trimmed/capped defensively; the list is bounded.
  const forEachMatchRaw = req.body?.forEachMatch;
  let forEachMatch = null;
  if (Array.isArray(forEachMatchRaw)) {
    forEachMatch = forEachMatchRaw
      .filter((n) => typeof n === "string")
      .map((n) => n.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 100);
  } else if (forEachMatchRaw !== undefined) {
    return res.status(400).json({ error: "invalid_for_each_match" });
  }
  if (forEachMatch && !forEachLink) {
    return res.status(400).json({ error: "invalid_for_each_match" });
  }

  // --- Unauthenticated render: stateless context, no session reuse. ---
  if (!auth) {
    let context;
    let page = null;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({ userAgent: UA });
      page = await context.newPage();
      await attachSsrfGuard(page);
      await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      await settlePage(page);
      if (actions)
        return await respondWithActions(
          page,
          res,
          actions,
          wantScreenshot,
          forEachLink,
          wantDebug,
          forEachMatch
        );
      const html = await page.content();
      const text = await readPageText(page);
      const screenshotBase64 =
        wantScreenshot || wantDebug ? await captureScreenshot(page) : null;
      return res.json({
        finalUrl: page.url(),
        text,
        html,
        ...(screenshotBase64 ? { screenshotBase64 } : {})
      });
    } catch (e) {
      console.error(`[render] render_failed (unauthenticated) for ${safe}: ${String(e).slice(0, 300)}`);
      const screenshotBase64 = page && (wantScreenshot || wantDebug) ? await captureScreenshot(page) : null;
      const pageSource = page && (wantScreenshot || wantDebug) ? await capturePageSource(page) : null;
      return res.status(200).json({
        error: "render_failed",
        detail: String(e).slice(0, 300),
        ...(screenshotBase64 ? { screenshotBase64 } : {}),
        ...(pageSource ? { pageSource } : {})
      });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // --- Authenticated render: per-tenant session, login on demand. ---
  const label = auth?.integrationLabel;
  if (!businessId || !label) return res.status(400).json({ error: "missing_business_or_label" });
  const key = `${businessId}:${label}`;

  let session;
  try {
    session = await acquireSession(key);
  } catch (e) {
    console.error(`[render] session acquire failed for ${key}: ${String(e).slice(0, 300)}`);
    return res.status(200).json({ error: "render_failed", detail: String(e).slice(0, 300) });
  }

  let page;
  let poisoned = false;
  try {
    page = await session.context.newPage();
    await attachSsrfGuard(page);
    await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });

    if (await looksLikeLogin(page, auth?.login)) {
      // Credential lookup / login-form failures are permanent SETUP errors
      // (missing AIFLOW_PLATFORM_URL/token, integration not found, wrong
      // selectors). Report them as `auth_config_error` so the worker fails the
      // run immediately instead of retrying as transient IO.
      let creds;
      try {
        creds = await fetchCredentials(businessId, label);
        await performLogin(page, creds, auth?.login);
      } catch (e) {
        poisoned = true;
        console.error(`[render] auth_config_error for ${key}: ${String(e).slice(0, 200)}`);
        return res
          .status(200)
          .json({ error: "auth_config_error", detail: String(e).slice(0, 200) });
      }
      await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      // Login can still fail (bad creds / MFA / captcha). Surface it AND drop the
      // logged-out session so the next call doesn't reuse a poisoned context and
      // hand the extractor a login page.
      if (await looksLikeLogin(page, auth?.login)) {
        poisoned = true;
        console.error(`[render] login_failed for ${key}`);
        return res.status(200).json({ error: "login_failed" });
      }
    }

    // Let the (post-login) SPA paint before we screenshot / read / act, so the
    // lead page's fields and buttons (e.g. "Provide Update") are present and the
    // debug screenshots aren't blank. Covers both the no-login and post-login
    // navigations, which converge here.
    await settlePage(page);

    // ACTION mode runs after any login. An action failure does NOT poison the
    // session — the login is still good; only the page/selectors disagreed.
    if (actions)
      return await respondWithActions(
        page,
        res,
        actions,
        wantScreenshot,
        forEachLink,
        wantDebug,
        forEachMatch
      );

    const html = await page.content();
    const text = await readPageText(page);
    const screenshotBase64 =
      wantScreenshot || wantDebug ? await captureScreenshot(page) : null;
    return res.json({
      finalUrl: page.url(),
      text,
      html,
      ...(screenshotBase64 ? { screenshotBase64 } : {})
    });
  } catch (e) {
    poisoned = true;
    console.error(`[render] render_failed (authenticated ${key}) for ${safe}: ${String(e).slice(0, 300)}`);
    // Best-effort diagnostic screenshot of whatever the page got stuck on so the
    // owner can see the failure state (a timeout, an unexpected interstitial).
    const screenshotBase64 = page && (wantScreenshot || wantDebug) ? await captureScreenshot(page) : null;
    const pageSource = page && (wantScreenshot || wantDebug) ? await capturePageSource(page) : null;
    return res.status(200).json({
      error: "render_failed",
      detail: String(e).slice(0, 300),
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(pageSource ? { pageSource } : {})
    });
  } finally {
    if (page) await page.close().catch(() => {});
    finishSession(key, session, poisoned);
  }
});

app.listen(PORT, () => console.log(`aiflow-render listening on :${PORT}`));
