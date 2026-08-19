/**
 * AiFlow render service, headless-Chromium browse backend for AiFlows.
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
 *   POST /pdf    { html }                             -> { pdfBase64 } (print a
 *                                                        self-contained HTML doc;
 *                                                        no JS, all network denied)
 *   ... + { screenshot: true }                        -> adds screenshotBase64 (JPEG)
 *   ... + { debugScreenshots: true }                  -> before/after/failure shots
 *                                                        + paired pageSource /
 *                                                        pageSourceBefore (HTML) on
 *                                                        failure responses
 *   ... + { actions: [...] }                          -> ACTION mode (below)
 *
 * IMPORTANT, application-level failures (action_failed / login_failed /
 * auth_config_error / render_failed) are returned with HTTP **200** and an
 * `{ error, detail }` body, NOT a 5xx. This service runs behind a Cloudflare
 * Tunnel, and Cloudflare REPLACES the body of any origin 5xx with its own
 * "error code: 502" page, which would erase the structured error and make the
 * worker retry a permanent failure. The worker classifies on the `error` code
 * (see renderErrorKind) and treats a genuine non-2xx as a transport failure.
 * Only client errors (400/401) keep their status, Cloudflare passes 4xx through.
 *
 * When `auth` is present the service logs in first using the named custom
 * integration's stored credentials (fetched from the platform's gateway-guarded
 * /api/integrations/custom/credentials endpoint), reusing a per-tenant browser
 * context so the session cookie is cached across calls.
 *
 * EXTRACT mode (no `actions`) only READS the page, it fills + submits the
 * login form and never clicks lead-page buttons. ACTION mode (the worker's
 * browse_action step) performs an owner-authored ordered click/fill sequence,
 * e.g. posting a "still trying to contact" update on a lead timeline, and
 * returns { finalUrl, actionsCompleted, text, html } (+ screenshotBase64 when
 * asked) so the worker can extract fields in the same pass. Each action is
 * { kind: click_text | click_selector | fill_selector | fill_placeholder |
 * click_text_while_present, target, value? }; the FIRST failing action aborts
 * with { error: "action_failed", detail, actionsCompleted }.
 * `click_text_while_present` clicks `target` while it can still TAKE a click
 * (bounded) and treats zero matches as success. The action engine itself lives
 * in ./actions.mjs so it can be unit-tested without a browser.
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
 *   AIFLOW_SETTLE_IDLE_TIMEOUT_MS  best-effort network-quiet wait, default 6000
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
// ACTION mode lives in its own module so it can be unit-tested against a stub
// page (tests/aiflow-render-actions.test.ts) without booting Express or Chromium.
import {
  condenseError,
  MAX_FOREACH_ITEMS,
  NAV_TIMEOUT_MS,
  parseActions,
  performActions,
  waitForExpectedText,
  checkActions
} from "./actions.mjs";
// Same reasoning for the login form: see the Clever 2026-08-17 incident in
// login.mjs for why the submit control needs an enabled check and a blur.
import { looksLikeLogin, performLogin } from "./login.mjs";

const PORT = Number(process.env.PORT ?? 8080);
/**
 * What `page.goto` waits for before returning.
 *
 * NOT "networkidle", which is what it used to be, because on a page that polls
 * (websockets, analytics beacons, an SPA that long-polls) the network never
 * goes quiet for 500ms and goto THROWS at NAV_TIMEOUT_MS. That is a hard
 * `render_failed` for a page that was perfectly readable: HomeLight's portal
 * timed out this way repeatedly on lead reads, retried, and the runs then
 * completed fine.
 *
 * Raising the timeout cannot fix it (a page that never idles never idles, and
 * three navigations x 30s already sits against a 120s worker abort and a ~100s
 * Cloudflare 524 ceiling). Instead the network-quiet wait moved into
 * settlePage() as a best-effort, non-throwing step, so a page that DOES idle
 * behaves exactly as before and one that never does proceeds with whatever
 * rendered. settlePage runs immediately after every navigation below, and its
 * innerText poll was always the real "is this SPA painted" signal anyway.
 */
const NAV_WAIT_UNTIL = "domcontentloaded";
const RENDER_TOKEN = process.env.AIFLOW_RENDER_TOKEN ?? "";
const PLATFORM_URL = (process.env.AIFLOW_PLATFORM_URL ?? "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.AIFLOW_GATEWAY_TOKEN ?? "";
const SESSION_TTL_MS = Number(process.env.AIFLOW_SESSION_TTL_MS ?? 30 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.AIFLOW_MAX_SESSIONS ?? 50);
/**
 * User agent for every context this service opens.
 *
 * The override exists because headless Chromium's default UA says
 * "HeadlessChrome", which is a bot signal on its own. But the override used to
 * pin major version 124 while the bundled engine moved on with every Playwright
 * bump, and a UA whose claimed version disagrees with the engine's real
 * fingerprint is ALSO a bot signal, the quieter kind that gets your lazy-loaded
 * script chunks answered with an HTML challenge page instead of JavaScript.
 * HomeLight's stage editor died exactly that way: `Unexpected token '<'`, two
 * skeletons forever (see docs/tenants/homelight-flow.md).
 *
 * So the version is DERIVED from the running browser instead of written down:
 * `browser.version()` returns the real Chromium version (e.g. "141.0.7390.37"),
 * and the UA carries it verbatim. It can never drift again, on any future
 * Playwright bump, because there is no second copy of the number to forget.
 */
function uaFor(browser) {
  return (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`
  );
}

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
    s = {
      ctx: browser.newContext({ userAgent: uaFor(browser) }),
      lastUsed: Date.now(),
      inUse: 0,
      doomed: false
    };
    sessions.set(key, s);
  }
  s.inUse++;
  s.lastUsed = Date.now();
  evictStale();
  try {
    s.context = await s.ctx;
    return s;
  } catch (e) {
    // Context creation failed, drop the poisoned entry so we retry cleanly.
    s.inUse--;
    if (sessions.get(key) === s) sessions.delete(key);
    throw e;
  }
}

/**
 * Release a session after a request finishes. On `poisoned` (bad login / render
 * error) the entry is removed from the map so no NEW request reuses it, but the
 * underlying context is only closed once the LAST in-flight request releases it
 * (inUse === 0), never yanked out from under a concurrent authed browse.
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

/**
 * Record why a page did not finish loading itself.
 *
 * Nothing here listened to the page before, which made every hydration failure
 * indistinguishable from "the control does not exist". HomeLight's referral
 * panel is the case that forced this: in a real browser it paints its stage
 * editor, and through this service the same click leaves two `--skeleton`
 * placeholders forever. With no console and no failed-request capture there was
 * no way to tell a blocked XHR from a wrong selector from a slow render, so the
 * only tool left was guessing, and guessed selectors have broken this account
 * twice.
 *
 * Attached always (the listeners are cheap and passive); the collected arrays
 * are only RETURNED when the caller asks for diagnostics, so ordinary responses
 * keep their shape and size.
 *
 * Bounded on purpose: a page in a retry loop can emit thousands of these, and
 * this is diagnostic colour, not a log sink.
 */
const DIAG_MAX = 25;
const DIAG_TEXT_MAX = 300;

function attachDiagnostics(page) {
  const diag = { consoleErrors: [], failedRequests: [], pageErrors: [] };
  const push = (arr, value) => {
    if (arr.length < DIAG_MAX) arr.push(String(value ?? "").slice(0, DIAG_TEXT_MAX));
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") push(diag.consoleErrors, msg.text());
  });
  page.on("pageerror", (err) => push(diag.pageErrors, err?.message ?? err));
  page.on("requestfailed", (req) => {
    // `blockedbyclient` is OUR ssrf guard refusing the request, and saying so
    // by name is the difference between "the portal is broken" and "we broke
    // it". Everything else is the network or the origin.
    const why = req.failure()?.errorText ?? "unknown";
    push(diag.failedRequests, `${why} ${req.method()} ${req.url()}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      push(diag.failedRequests, `HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  return diag;
}

/** Drop empty arrays so an untroubled page adds nothing to the response. */
function summarizeDiagnostics(diag) {
  if (!diag) return null;
  const out = {};
  for (const [k, v] of Object.entries(diag)) if (v.length > 0) out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
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

// looksLikeLogin / performLogin live in login.mjs so they can be unit-tested
// against a stub page (see tests/aiflow-render-login.test.ts), the same split
// ACTION mode already uses.

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


// How long settlePage waits for a JS-rendered (SPA) page to actually paint
// content before we screenshot / read / act on it. networkidle alone fires on
// the empty app shell, which is why early captures came back blank-white and
// extraction returned empty fields.
const SETTLE_TIMEOUT_MS = Number(process.env.AIFLOW_SETTLE_TIMEOUT_MS ?? 8000);
const SETTLE_MIN_TEXT = Number(process.env.AIFLOW_SETTLE_MIN_TEXT ?? 40);
const SETTLE_POST_DELAY_MS = Number(process.env.AIFLOW_SETTLE_POST_DELAY_MS ?? 600);
// The network-quiet wait, moved OFF page.goto and in here. Same signal, but
// best-effort: see the note on NAV_WAIT_UNTIL. Its own (smaller) budget so
// three navigations plus three settles still fit inside the caller's ceiling.
const SETTLE_IDLE_TIMEOUT_MS = Number(process.env.AIFLOW_SETTLE_IDLE_TIMEOUT_MS ?? 6000);

/**
 * Wait for an SPA to finish painting before we capture/read/act. Best-effort
 * and bounded: a page that never fills in still proceeds after the timeout so
 * a slow render degrades to "maybe blank" rather than a hang. Steps:
 *   0) wait for the network to go quiet (what page.goto used to require), then
 *   1) wait for the `load` event (subresources), then
 *   2) poll until the body has real visible text (> SETTLE_MIN_TEXT chars), then
 *   3) a short fixed delay so late layout/fonts settle before the shot.
 * Never throws.
 */
async function settlePage(page) {
  try {
    await page
      .waitForLoadState("networkidle", { timeout: SETTLE_IDLE_TIMEOUT_MS })
      .catch(() => {});
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
    // A settle failure must never break the browse, proceed with whatever
    // rendered so text/screenshots still flow.
  }
}

/**
 * Read the page's visible text for extraction, with image ALT text inlined at
 * each image's position. Some lead pages render a key value ONLY as a logo
 * image (e.g. ReferralExchange's "Web Source" row shows
 * `<img alt="realestateagents">` with no text sibling), which
 * `document.body.innerText` drops entirely, so the worker's Gemini extraction
 * could never see it. A text node is inserted after each alt-bearing image,
 * innerText is read, then the markers are removed, all inside ONE evaluate
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
    // A failed screenshot must not fail the browse, text/html still flow.
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
 * SAME action sequence. Per-item failures are recorded but DON'T abort the loop,
 * a weekly bulk update shouldn't stop because one lead's page changed.
 */
async function performForEach(page, forEachLink, actions, matchNames) {
  let hrefs = [];
  try {
    hrefs = await page.evaluate(
      ({ sel, names }) => {
        // `names` is an ARRAY when the caller requested a name filter (act only
        // on rows naming one of them) or NULL when no filter was requested (act
        // on every row). A filter that's present but empty therefore matches
        // NOTHING, we never silently fall back to acting on every row.
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
      await page.goto(href, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
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
 * DRY RUN responder: report whether each action would find something to act
 * on, and change nothing.
 *
 * Deliberately a SEPARATE function from respondWithActions rather than a flag
 * threaded through it. The two differ in the only way that matters (one acts,
 * one does not), so they must not share a body where a future edit could let
 * a check fall through into a click. Nothing here calls performActions,
 * performForEach or waitForExpectedText.
 */
async function respondWithActionChecks(page, res, actions, wantShot) {
  const checks = await checkActions(page, actions);
  const screenshotBase64 = wantShot ? await captureScreenshot(page) : null;
  return res.json({
    ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
    finalUrl: page.url(),
    checks,
    ...(screenshotBase64 ? { screenshotBase64 } : {})
  });
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
  forEachMatch,
  expectText
) {
  if (forEachLink) {
    const fe = await performForEach(page, forEachLink, actions, forEachMatch);
    return res.json({
      ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
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
  let acted = await performActions(page, actions);
  // The actions all completed; now hold the step to its declared postcondition.
  // A miss is reported exactly like an action failure so the worker's existing
  // classification (permanent fail, page-marker skip/continue, failure shots)
  // applies unchanged.
  if (!acted.error && expectText && !(await waitForExpectedText(page, expectText))) {
    acted = {
      completed: acted.completed,
      error: condenseError(
        `expect_text "${expectText}": the page never showed it after the actions completed`
      )
    };
  }
  if (acted.error) {
    console.error(`[render] action_failed after ${acted.completed} actions: ${acted.error}`);
    // ALWAYS grab a diagnostic screenshot + source of the stuck page on an action
    // failure (the rare path), regardless of the screenshot/debug opt-in: the
    // owner needs to see WHERE the automation broke (e.g. a wizard "Next" that
    // never advanced), and the worker matches this source against a step's
    // skipWhenText to recognize terminal pages (e.g. a lead already claimed) and
    // end the run gracefully. The before-shot above stays debug-only to bound
    // cost on the happy path. Best effort, a capture failure must not mask
    // action_failed.
    await settlePage(page);
    const screenshotBase64 = await captureScreenshot(page);
    const pageSource = await capturePageSource(page);
    return res.status(200).json({
      error: "action_failed",
      detail: acted.error,
      actionsCompleted: acted.completed,
      // Why the page did not do what was asked, when we know: a blocked or
      // failing request explains a control that never appeared far better than
      // "no matching control on the page" does.
      ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
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
    // Present even on a 200: a page that loaded but whose data requests failed
    // returns REAL html with MISSING controls, which is indistinguishable from
    // a page that simply does not have them. The owner-facing page picker and
    // the worker both need to be able to tell those apart.
    ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
    finalUrl: page.url(),
    actionsCompleted: acted.completed,
    text,
    html,
    ...(screenshotBase64 ? { screenshotBase64 } : {})
  });
}

/**
 * POST /pdf { html } -> { pdfBase64 }
 *
 * Print a SELF-CONTAINED HTML document (the platform's re-typeset agent
 * artifact) to PDF. Same bearer auth and rate limit as /render. The page is
 * hermetic by construction: content arrives via setContent (no navigation),
 * JavaScript is disabled at the context level, and EVERY network request is
 * aborted, tenant-influenced HTML can't probe the box's loopback services
 * or fetch external resources (inline data: URIs still render). Failures
 * return HTTP 200 with { error, detail } like /render (Cloudflare replaces
 * origin 5xx bodies, see the module doc).
 */
const PDF_HTML_MAX_CHARS = Number(process.env.AIFLOW_PDF_HTML_MAX_CHARS ?? 200_000);
app.post("/pdf", async (req, res) => {
  const html = typeof req.body?.html === "string" ? req.body.html : "";
  if (!html.trim()) return res.status(400).json({ error: "missing_html" });
  if (html.length > PDF_HTML_MAX_CHARS) return res.status(400).json({ error: "html_too_large" });
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" }
    });
    res.json({ pdfBase64: pdf.toString("base64") });
  } catch (err) {
    res.json({
      error: "render_failed",
      detail: String(err?.message ?? err).slice(0, 300)
    });
  } finally {
    if (context) context.close().catch(() => {});
  }
});

/**
 * The dry run gets its OWN PATH, not just a flag on /render.
 *
 * The app deploys on merge; this sidecar only updates on a manual per-tenant
 * redeploy, so there is always a window where the dashboard is new and a box
 * is old. An old box does not know `checkOnly`, and its `if (actions)` branch
 * would fall straight through to performActions: the button that promises to
 * change nothing would CLICK THE CLAIM BUTTON on a live referral. A path an
 * old box has never heard of returns 404 instead, which is a safe answer.
 *
 * Registered against the same handler rather than a copy, so the page load,
 * the login and the SSRF guard cannot drift between the two modes.
 */
const renderHandler = async (req, res) => {
  const safe = safeUrl(String(req.body?.url ?? ""));
  if (!safe) return res.status(400).json({ error: "invalid_or_unsafe_url" });
  const auth = req.body?.auth;
  const businessId = req.body?.businessId;
  const wantScreenshot = req.body?.screenshot === true;
  // Per-flow visibility opt-in: capture before/after/failure shots for the
  // dashboard "investigate" view. Off by default so most flows pay nothing.
  // Collected passively on every request; returned only under debugScreenshots.
  let pageDiagnostics = null;
  const wantDebug = req.body?.debugScreenshots === true;
  const rawActions = req.body?.actions;
  const actions = rawActions === undefined ? null : parseActions(rawActions);
  if (rawActions !== undefined && !actions) {
    return res.status(400).json({ error: "invalid_actions" });
  }
  // DRY RUN: locate every action's target and report, without performing any
  // of them. Requires actions (there is nothing to check otherwise) and
  // refuses forEachLink: a dry run over a list would multiply the cost of the
  // one mode that already lives inside a single ~100s response, and the answer
  // for row 1 is the answer for every row.
  const checkOnly = req.body?.checkOnly === true;
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
  if (checkOnly && (!actions || forEachLink)) {
    return res.status(400).json({ error: "invalid_check_only" });
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
  // Post-action expectation (browse_action.expectText): after every action
  // completed, the page's VISIBLE text must contain this marker within
  // EXPECT_TEXT_TIMEOUT_MS or the step reports action_failed with the standard
  // failure captures. It asserts the page's AFTER state because a dispatched
  // click is not an applied click on a hydrating SPA (HomeLight claim,
  // 2026-08-16). Requires actions, and is meaningless per-row, so it cannot
  // combine with forEachLink (the authoring schema forbids both; this guards
  // hand-crafted requests).
  const expectRaw = req.body?.expectText;
  const expectText =
    typeof expectRaw === "string" && expectRaw.trim() && expectRaw.length <= 200
      ? expectRaw.trim()
      : null;
  if (expectRaw !== undefined && !expectText) {
    return res.status(400).json({ error: "invalid_expect_text" });
  }
  if (expectText && (forEachLink || !actions)) {
    return res.status(400).json({ error: "invalid_expect_text" });
  }

  // --- Unauthenticated render: stateless context, no session reuse. ---
  if (!auth) {
    let context;
    let page = null;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({ userAgent: uaFor(browser) });
      page = await context.newPage();
      await attachSsrfGuard(page);
      pageDiagnostics = attachDiagnostics(page);
    page.__diag = pageDiagnostics;
      page.__diag = pageDiagnostics;
      await page.goto(safe, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
      await settlePage(page);
      if (actions)
        return checkOnly
          ? await respondWithActionChecks(page, res, actions, wantScreenshot || wantDebug)
          : await respondWithActions(
              page,
              res,
              actions,
              wantScreenshot,
              forEachLink,
              wantDebug,
              forEachMatch,
              expectText
            );
      const html = await page.content();
      const text = await readPageText(page);
      const screenshotBase64 =
        wantScreenshot || wantDebug ? await captureScreenshot(page) : null;
      return res.json({
        ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
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
        ...(page && summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
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
    pageDiagnostics = attachDiagnostics(page);
    page.__diag = pageDiagnostics;
    await page.goto(safe, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
    // Settle BEFORE judging whether this is a login page. looksLikeLogin takes
    // an instant locator count with no auto-wait, and goto now returns at
    // domcontentloaded, so on a login-gated SPA whose form renders client-side
    // it would see no password field, skip authentication, and hand the
    // extractor a logged-out shell. Under the old waitUntil: "networkidle" the
    // page had already painted by this line; settling here is what restores it.
    await settlePage(page);

    if (await looksLikeLogin(page, auth?.login)) {
      // Credential lookup / login-form failures are permanent SETUP errors
      // (missing AIFLOW_PLATFORM_URL/token, integration not found, wrong
      // selectors). Report them as `auth_config_error` so the worker fails the
      // run immediately instead of retrying as transient IO.
      let creds;
      let loginDiagnostics = null;
      try {
        creds = await fetchCredentials(businessId, label);
        loginDiagnostics = await performLogin(page, creds, auth?.login);
        await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      } catch (e) {
        poisoned = true;
        console.error(`[render] auth_config_error for ${key}: ${String(e).slice(0, 200)}`);
        return res
          .status(200)
          .json({ error: "auth_config_error", detail: String(e).slice(0, 200) });
      }
      await page.goto(safe, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
      // Same reason as above: settle before the second login check, or a slow
      // re-render reads as "logged in" and the extractor gets the shell.
      await settlePage(page);
      // An email-first login that never reached its password step did NOT
      // authenticate, and the re-check below cannot be trusted to notice: a
      // logged-out portal often redirects to a marketing page that is not
      // login-shaped at all (HomeLight sends you to the /referrals signup
      // funnel). Without this, a stalled advance falls through as success and
      // the funnel goes to the extractor, which is precisely the silent-success
      // bug the email-first support exists to close. We KNOW we did not log in,
      // so say so rather than asking the page.
      const stalledAdvance = loginDiagnostics?.passwordStepReached === false;
      if (stalledAdvance || (await looksLikeLogin(page, auth?.login))) {
        poisoned = true;
        // Say WHY. A bare `login_failed` sent someone reading portal markup by
        // hand for a day (Clever, 2026-08-17) to discover that the submit
        // control was `type="button"` and shipped `disabled`. Action failures
        // already persist a screenshot and page source; login failures used to
        // persist nothing, and that asymmetry was the actual bug.
        const detail = loginDiagnostics
          ? (loginDiagnostics.steps === 2
              ? `steps=2 advance=${loginDiagnostics.selectors.advance ?? "none"} ` +
                `passwordStep=${loginDiagnostics.passwordStepReached} `
              : "") +
            `submit=${loginDiagnostics.selectors.submit ?? "none"} ` +
            `enabled=${loginDiagnostics.submitEnabled} blurred=${loginDiagnostics.blurred}` +
            (loginDiagnostics.clickError ? ` clickError=${loginDiagnostics.clickError}` : "")
          : "no login diagnostics";
        console.error(`[render] login_failed for ${key}: ${detail}`);
        const screenshotBase64 = await captureScreenshot(page);
        const text = await readPageText(page).catch(() => "");
        return res.status(200).json({
          error: "login_failed",
          detail,
          ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
          finalUrl: page.url(),
          // Bounded: enough to spot "invalid password" / MFA / a bot challenge
          // without shipping a whole SPA back through the tunnel.
          pageTextExcerpt: String(text).slice(0, 600),
          ...(screenshotBase64 ? { screenshotBase64 } : {})
        });
      }
    }

    // The SPA has already been settled: every path to this line settles right
    // after its own navigation (that is what makes the login check reliable),
    // so the lead page's fields and buttons (e.g. "Provide Update") are present
    // and the debug screenshots aren't blank. Don't re-settle here, it would
    // just pay the network-quiet wait a third time on a page that never idles.

    // ACTION mode runs after any login. An action failure does NOT poison the
    // session, the login is still good; only the page/selectors disagreed.
    if (actions)
      return checkOnly
        ? await respondWithActionChecks(page, res, actions, wantScreenshot || wantDebug)
        : await respondWithActions(
            page,
            res,
            actions,
            wantScreenshot,
            forEachLink,
            wantDebug,
            forEachMatch,
            expectText
          );

    const html = await page.content();
    const text = await readPageText(page);
    const screenshotBase64 =
      wantScreenshot || wantDebug ? await captureScreenshot(page) : null;
    return res.json({
      // The authenticated path is the one that matters most: every credentialed
      // tenant browse and the owner-facing page picker come through here, and a
      // logged-in portal is exactly where a half-rendered page looks healthy.
      ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
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
      ...(page && summarizeDiagnostics(page.__diag)
        ? { diagnostics: summarizeDiagnostics(page.__diag) }
        : {}),
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      ...(pageSource ? { pageSource } : {})
    });
  } finally {
    if (page) await page.close().catch(() => {});
    finishSession(key, session, poisoned);
  }
};

app.post("/render", renderHandler);

// Forced, not merely defaulted: the mode is a property of the path, so a
// request that arrives here cannot perform actions however it was shaped.
app.post("/check-actions", (req, res) => {
  req.body = { ...(req.body ?? {}), checkOnly: true };
  return renderHandler(req, res);
});

app.listen(PORT, () => console.log(`aiflow-render listening on :${PORT}`));
