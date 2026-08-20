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
 * DEMONSTRATION mode (dashboard "teach it by doing it once"; engine in
 * ./demo.mjs, and like the dry run it is its own PATH so a box that predates
 * it answers 404 instead of misreading the request):
 *   POST /demo/start { businessId, url, auth? }       -> { demoId, finalUrl, html,
 *                                                        text, screenshotBase64,
 *                                                        loggedIn } (persistent page)
 *   POST /demo/act   { businessId, demoId, action,    -> { recorded, actionsCount,
 *                      confirm? }                        finalUrl, html, text,
 *                                                        screenshotBase64 }
 *                                                        The action EXECUTES for
 *                                                        real and is recorded as a
 *                                                        normal browse action; point
 *                                                        kinds (click_point/
 *                                                        fill_point) are resolved to
 *                                                        one first. Destructive
 *                                                        labels return needs_confirm
 *                                                        until confirm: true.
 *   POST /demo/stop  { businessId, demoId }           -> { ok: true } (idempotent)
 *   An unknown/expired demoId answers HTTP 200 { error: "unknown_demo" }, NEVER
 *   404: the app reads a demo-path 404 as "box not redeployed yet".
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
  capForEachList,
  condenseError,
  MAX_ACTIONS,
  NAV_TIMEOUT_MS,
  parseActions,
  performActions,
  waitForExpectedText,
  checkActions
} from "./actions.mjs";
// Same reasoning for the login form: see the Clever 2026-08-17 incident in
// login.mjs for why the submit control needs an enabled check and a blur, and
// the 2026-08-19 one for why a submitted login must be WAITED OUT before any
// re-navigation (waitForLoginToResolve).
import { looksLikeLogin, performLogin, waitForLoginToResolve } from "./login.mjs";
// DEMONSTRATION mode (persistent-page sessions, point-to-action derivation,
// the confirm gate) lives in ./demo.mjs so it can be unit-tested without a
// browser (tests/aiflow-render-demo.test.ts), same split as the two above.
import {
  createDemoStore,
  DEMO_SWEEP_INTERVAL_MS,
  DEMO_TEXT_MAX_CHARS,
  diagnosticsMarks,
  isConfirmRequired,
  parseDemoAction,
  resolveDemoPointAction,
  sliceDiagnostics
} from "./demo.mjs";
import { randomUUID } from "node:crypto";

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

/**
 * Align User-Agent CLIENT HINTS with the UA string, per page.
 *
 * The `userAgent` context option rewrites only the UA HEADER. Chromium keeps
 * broadcasting its true identity through Sec-CH-UA client hints, and in
 * headless mode the brand list literally says "HeadlessChrome". HomeLight's own
 * analytics beacon showed ours verbatim (`uafvl=...|HeadlessChrome...`), which
 * is how this was caught: the perfect UA string above was being contradicted on
 * every request by a channel we never controlled. A CDN that keys on client
 * hints answers script-chunk requests with an HTML challenge page, the document
 * still loads, and the page half-renders with `Unexpected token '<'` errors:
 * HomeLight's stage editor, exactly (docs/tenants/homelight-flow.md).
 *
 * Playwright has no first-class API for this, so it goes through CDP's
 * `Emulation.setUserAgentOverride`, whose `userAgentMetadata` is what Sec-CH-UA
 * is generated from. Brands and versions are DERIVED from the engine, same rule
 * as uaFor: no second copy of a number to forget.
 *
 * Best-effort on purpose: a CDP failure must degrade to today's behavior, not
 * break rendering.
 */
async function alignClientHints(page, browser) {
  try {
    const fullVersion = browser.version();
    const major = fullVersion.split(".")[0];
    const brands = [
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
      // The GREASE brand every real Chrome ships; its absence is a tell too.
      { brand: "Not=A?Brand", version: "99" }
    ];
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setUserAgentOverride", {
      userAgent: uaFor(browser),
      userAgentMetadata: {
        brands,
        fullVersionList: brands.map((b) => ({
          brand: b.brand,
          version: b.brand === "Not=A?Brand" ? "99.0.0.0" : fullVersion
        })),
        platform: "macOS",
        platformVersion: "10.15.7",
        architecture: "x86",
        model: "",
        mobile: false,
        fullVersion
      }
    });
  } catch (e) {
    console.error(`[render] client-hint alignment failed (continuing): ${String(e).slice(0, 200)}`);
  }
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
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        // Playwright leaves `navigator.webdriver = true`, the oldest bot tell
        // there is, and one that survived fixing the UA string (#1511) and the
        // Sec-CH-UA client hints (#1513): HomeLight's chunk CDN still answered
        // our script requests with an HTML challenge while the beacon showed a
        // clean fingerprint. This flag is Chromium's own switch for it; it
        // changes nothing else about the engine.
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }
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
  const diag = { consoleErrors: [], failedRequests: [], pageErrors: [], dataServedAsMarkup: [] };
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
      return;
    }
    // A SCRIPT that comes back as markup is always a bug, and it is invisible
    // to every check above: the status is 200, the request did not fail, and
    // the document keeps rendering. The app then dies on `Unexpected token
    // '<'` with nothing naming the file. That is a CDN challenge page, an
    // SPA rewrite swallowing a 404, or an auth redirect on a static asset.
    //
    // HomeLight's referral panel is exactly this: its lazily-imported chunk
    // returns HTML, the stage editor never mounts, and the page looks merely
    // "missing a control". Naming the URL is the difference between that dead
    // end and a fixable problem.
    try {
      // Scripts AND data calls. Restricting this to `script` missed the case
      // that actually bites: `Unexpected token '<'` is equally the signature of
      // JSON.parse() on an HTML body, so an XHR answered with a login page or a
      // challenge throws inside the app and the component that needed the data
      // never renders. HomeLight's referral drawer fails this way, and the
      // script-only version of this check came back empty while the page still
      // threw twice.
      const kind = res.request().resourceType();
      if (kind !== "script" && kind !== "fetch" && kind !== "xhr") return;
      const type = res.headers()["content-type"] ?? "";
      if (/javascript|ecmascript|json/i.test(type)) return;
      // Markup is the tell. A data call legitimately returning text/plain or an
      // image is not interesting; one returning a document is a redirect to
      // something the app never asked for.
      if (!/html|xml/i.test(type)) return;
      push(
        diag.dataServedAsMarkup,
        `${kind} ${res.status()} ${type || "no content-type"} ${res.url()}`
      );
    } catch {
      /* header access on a closed page must never break collection */
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

/**
 * Ensure the page's portal session is authenticated, driving the stored-
 * credential login form when the page looks login-shaped.
 *
 * Extracted from renderHandler and shared with /demo/start so the two paths
 * cannot drift (the same reason /check-actions reuses renderHandler): a demo
 * that logged in differently from the flows it teaches would prove nothing.
 *
 * The caller has already navigated to `url` and settled. On a performed login
 * this re-navigates to `url` and settles again. Credential lookup / login-form
 * failures are permanent SETUP errors (missing AIFLOW_PLATFORM_URL/token,
 * integration not found, wrong selectors), reported as `auth_config_error` so
 * the worker fails the run immediately instead of retrying as transient IO. A
 * navigation failure here THROWS, which callers report as render_failed,
 * exactly as before the extraction.
 *
 * Returns { ok: true }, or { ok: false, error, detail } with error
 * "auth_config_error" | "login_failed". Both failures poison the shared
 * session entry at the CALLER, which owns the refcount.
 */
async function ensureLoggedIn(page, { url, businessId, label, login }) {
  if (!(await looksLikeLogin(page, login))) return { ok: true };
  let loginDiagnostics = null;
  let loginResolve = null;
  try {
    const creds = await fetchCredentials(businessId, label);
    loginDiagnostics = await performLogin(page, creds, login);
    // Wait for the submitted login to actually RESOLVE before touching the
    // page again. The old wait here was waitForLoadState("networkidle"),
    // which is a NO-OP on a page that finished loading before the click
    // (load states are reached once per document), so the re-goto below
    // fired instantly and CANCELLED the in-flight authentication. Amy's
    // Clever login failed deterministically through this service, with
    // correct credentials and a landed click, for exactly that reason:
    // login.listwithclever.com hands the agents.listwithclever.com session
    // to a cross-subdomain redirect the re-goto kept aborting.
    loginResolve = await waitForLoginToResolve(page, login);
    // Let the post-login redirect chain and app boot finish before the
    // re-goto, so the target navigation starts from a settled session.
    await settlePage(page);
  } catch (e) {
    return { ok: false, error: "auth_config_error", detail: String(e).slice(0, 200) };
  }
  await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
  // Settle before the second login check, or a slow re-render reads as
  // "logged in" and the extractor gets the shell.
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
  if (stalledAdvance || (await looksLikeLogin(page, login))) {
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
        (loginDiagnostics.clickError ? ` clickError=${loginDiagnostics.clickError}` : "") +
        // How the post-submit wait ended. "timeout" with a landed click
        // usually means the portal rejected the credentials; "navigation"
        // followed by a login-shaped page means the session did not stick.
        (loginResolve ? ` resolve=${loginResolve.via}:${loginResolve.waitedMs}ms` : "")
      : "no login diagnostics";
    return { ok: false, error: "login_failed", detail };
  }
  return { ok: true };
}

/**
 * The login_failed response body, shared by /render and /demo/start: the page
 * itself is the only real explanation of a failed login, so both carry it.
 */
async function loginFailedBody(page, detail) {
  const screenshotBase64 = await captureScreenshot(page);
  const text = await readPageText(page).catch(() => "");
  return {
    error: "login_failed",
    detail,
    ...(summarizeDiagnostics(page.__diag) ? { diagnostics: summarizeDiagnostics(page.__diag) } : {}),
    finalUrl: page.url(),
    // Bounded: enough to spot "invalid password" / MFA / a bot challenge
    // without shipping a whole SPA back through the tunnel.
    pageTextExcerpt: String(text).slice(0, 600),
    ...(screenshotBase64 ? { screenshotBase64 } : {})
  };
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
      remaining: 0,
      actionsCompleted: 0,
      errors: [`forEachLink "${forEachLink}": ${String(e?.message ?? e)}`.slice(0, 200)]
    };
  }
  // Report the TRUE match count and surface any overflow as failures so the
  // worker never logs a misleading "updated N of N" while silently skipping
  // leads past the cap. (`items` stays the pre-slice total; the skipped tail
  // is counted inside `failed` with an explicit error for older workers, AND
  // reported separately as `remaining`, which is what tells a chaining-aware
  // worker to defer and come back for the next slice.)
  const totalMatched = hrefs.length;
  const cap = capForEachList(hrefs);
  hrefs = cap.kept;
  let succeeded = 0;
  let failed = cap.remaining;
  let actionsCompleted = 0;
  const errors = [];
  if (cap.capNote) errors.push(cap.capNote);
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
  return {
    items: totalMatched,
    succeeded,
    failed,
    remaining: cap.remaining,
    actionsCompleted,
    errors: errors.slice(0, 20)
  };
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
        remaining: fe.remaining,
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
      await alignClientHints(page, browser);
      pageDiagnostics = attachDiagnostics(page);
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
    await alignClientHints(page, await getBrowser());
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

    // The login itself lives in ensureLoggedIn (shared with /demo/start, so
    // the two paths cannot drift). Failures poison the session entry HERE,
    // where the refcount lives.
    const loginOutcome = await ensureLoggedIn(page, {
      url: safe,
      businessId,
      label,
      login: auth?.login
    });
    if (!loginOutcome.ok) {
      poisoned = true;
      if (loginOutcome.error === "auth_config_error") {
        console.error(`[render] auth_config_error for ${key}: ${loginOutcome.detail}`);
        return res
          .status(200)
          .json({ error: "auth_config_error", detail: loginOutcome.detail });
      }
      console.error(`[render] login_failed for ${key}: ${loginOutcome.detail}`);
      return res.status(200).json(await loginFailedBody(page, loginOutcome.detail));
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

/**
 * DEMONSTRATION mode (module doc up top; engine in ./demo.mjs).
 *
 * Its own PATHS, same rule as /check-actions: a box that predates this code
 * 404s, which the app reads as "not updated yet". Sessions hold a PERSISTENT
 * page between requests, which is the one deliberate exception to the
 * page-per-request rule above; every exit path funnels through the store's
 * exactly-once release so the auth-context refcount can never leak (evictStale
 * never touches inUse > 0, so a leaked hold would pin a context forever).
 */
const demoStore = createDemoStore();
const demoSweepTimer = setInterval(() => {
  demoStore.sweep().catch(() => {});
}, DEMO_SWEEP_INTERVAL_MS);
// The sweep must never hold the process open (or a test importing this).
demoSweepTimer.unref?.();

/**
 * The page-state fields every demo turn returns. No settle here: callers
 * settle exactly once per navigation-like event, same discipline as /render.
 */
async function demoPageState(page, marks) {
  const html = (await capturePageSource(page)) ?? "";
  const text = (await readPageText(page)).slice(0, DEMO_TEXT_MAX_CHARS);
  const screenshotBase64 = await captureScreenshot(page);
  const fresh = sliceDiagnostics(page.__diag, marks ?? {});
  return {
    finalUrl: page.url(),
    html,
    text,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
    ...(fresh ? { diagnostics: fresh } : {})
  };
}

/** The wire shape of a recorded action: value only where the kind carries one. */
function publicDemoAction(recorded) {
  const wantsValue =
    recorded.kind === "fill_selector" ||
    recorded.kind === "fill_placeholder" ||
    recorded.kind === "select_option" ||
    recorded.kind === "click_role";
  return {
    kind: recorded.kind,
    target: recorded.target,
    ...(wantsValue ? { value: recorded.value ?? "" } : {})
  };
}

app.post("/demo/start", async (req, res) => {
  demoStore.sweep().catch(() => {});
  const safe = safeUrl(String(req.body?.url ?? ""));
  if (!safe) return res.status(400).json({ error: "invalid_or_unsafe_url" });
  // Required even for a public page: the demoId is BOUND to the business at
  // creation, and act/stop answer a mismatch exactly like an unknown id.
  const businessId =
    typeof req.body?.businessId === "string" && req.body.businessId.length > 0
      ? req.body.businessId
      : null;
  if (!businessId) return res.status(400).json({ error: "missing_business" });
  const auth = req.body?.auth;
  const label = auth?.integrationLabel;
  if (auth && !label) return res.status(400).json({ error: "missing_business_or_label" });

  let key = null;
  let entry = null;
  let ownedContext = null;
  let page = null;
  let released = false;
  // Exactly-once teardown for every path out of this handler and, once the
  // session is registered, for the store's release too. Poisoning applies
  // only to the shared auth entry, same rule as renderHandler.
  const releaseResources = async (poisoned) => {
    if (released) return;
    released = true;
    if (page) await page.close().catch(() => {});
    if (entry) finishSession(key, entry, poisoned);
    else if (ownedContext) await ownedContext.close().catch(() => {});
  };

  let session = null;
  try {
    const browser = await getBrowser();
    let context;
    if (label) {
      key = `${businessId}:${label}`;
      entry = await acquireSession(key);
      context = entry.context;
    } else {
      ownedContext = await browser.newContext({ userAgent: uaFor(browser) });
      context = ownedContext;
    }
    page = await context.newPage();
    await attachSsrfGuard(page);
    await alignClientHints(page, browser);
    page.__diag = attachDiagnostics(page);
    await page.goto(safe, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
    await settlePage(page);
    if (label) {
      const loginOutcome = await ensureLoggedIn(page, {
        url: safe,
        businessId,
        label,
        login: auth?.login
      });
      if (!loginOutcome.ok) {
        if (loginOutcome.error === "auth_config_error") {
          console.error(`[render] demo auth_config_error for ${key}: ${loginOutcome.detail}`);
          await releaseResources(true);
          return res
            .status(200)
            .json({ error: "auth_config_error", detail: loginOutcome.detail });
        }
        console.error(`[render] demo login_failed for ${key}: ${loginOutcome.detail}`);
        const body = await loginFailedBody(page, loginOutcome.detail);
        await releaseResources(true);
        return res.status(200).json(body);
      }
    }
    const demoId = randomUUID();
    session = await demoStore.create({
      demoId,
      businessId,
      page,
      close: () => releaseResources(false)
    });
    if (!session) {
      await releaseResources(false);
      return res.status(200).json({ error: "demo_limit" });
    }
    console.log(`[render] demo ${demoId} started for ${businessId} on ${page.url()}`);
    const state = await demoPageState(page, {});
    return res.json({ demoId, loggedIn: Boolean(label), ...state });
  } catch (e) {
    console.error(`[render] demo start failed for ${businessId}: ${String(e).slice(0, 300)}`);
    if (session) await demoStore.release(session);
    else await releaseResources(true);
    return res.status(200).json({ error: "render_failed", detail: String(e).slice(0, 300) });
  }
});

app.post("/demo/act", async (req, res) => {
  demoStore.sweep().catch(() => {});
  const businessId = typeof req.body?.businessId === "string" ? req.body.businessId : "";
  const demoId = typeof req.body?.demoId === "string" ? req.body.demoId : "";
  if (!businessId || !demoId) return res.status(400).json({ error: "unknown_demo_request" });
  const action = parseDemoAction(req.body?.action);
  if (!action) return res.status(400).json({ error: "invalid_action" });
  const confirm = req.body?.confirm === true;
  const session = demoStore.get(demoId, businessId);
  // Unknown, expired, a restarted box, or another business's id: one answer,
  // HTTP 200. A 404 here would read app-side as "box not redeployed yet".
  if (!session) return res.status(200).json({ error: "unknown_demo" });
  if (session.actionsCount >= MAX_ACTIONS) return res.status(200).json({ error: "action_cap" });
  demoStore.touch(session);
  const page = session.page;
  const marks = diagnosticsMarks(page.__diag);
  try {
    let recorded;
    let label;
    if (action.kind === "click_point" || action.kind === "fill_point") {
      const resolved = await resolveDemoPointAction(page, action);
      if (!resolved.ok) {
        // Nothing executed, nothing recorded: the owner picks a different
        // spot or falls back to the control list.
        return res.status(200).json({
          error: "resolve_failed",
          reason: resolved.reason,
          ...(resolved.detail ? { detail: resolved.detail } : {}),
          ...(resolved.options ? { options: resolved.options } : {})
        });
      }
      recorded = resolved.action;
      label = resolved.label;
    } else {
      recorded = action;
      label = action.value ? `${action.target} -> ${action.value}` : action.target;
    }
    if (!confirm && isConfirmRequired(recorded)) {
      // Not executed, not recorded. The panel re-sends the RESOLVED action
      // with confirm: true once the owner says yes, so a point click only
      // pays the resolution once. Sidecar-side on purpose: no dashboard bug
      // can click a destructive-labeled control without a confirm.
      return res.status(200).json({
        error: "needs_confirm",
        resolved: publicDemoAction(recorded),
        label
      });
    }
    const acted = await performActions(page, [recorded]);
    if (acted.error) {
      console.error(`[render] demo action_failed (${demoId}): ${acted.error}`);
      await settlePage(page);
      const state = await demoPageState(page, marks);
      return res.status(200).json({ error: "action_failed", detail: acted.error, ...state });
    }
    session.actionsCount += 1;
    await settlePage(page);
    const state = await demoPageState(page, marks);
    return res.json({
      recorded: publicDemoAction(recorded),
      actionsCount: session.actionsCount,
      ...state
    });
  } catch (e) {
    // A dead page or context (browser crash, memory pressure) cannot be
    // recovered mid-demo. Release NOW so the auth-context refcount never
    // leaks behind a dead page; the recorded list lives client-side and
    // survives.
    console.error(`[render] demo ${demoId} died mid-act: ${String(e).slice(0, 300)}`);
    await demoStore.release(session);
    return res
      .status(200)
      .json({ error: "demo_gone", detail: condenseError(String(e?.message ?? e)) });
  }
});

app.post("/demo/stop", async (req, res) => {
  const businessId = typeof req.body?.businessId === "string" ? req.body.businessId : "";
  const demoId = typeof req.body?.demoId === "string" ? req.body.demoId : "";
  if (!businessId || !demoId) return res.status(400).json({ error: "unknown_demo_request" });
  const session = demoStore.get(demoId, businessId);
  // Idempotent: stopping an already-gone session is success, not an error.
  if (!session) return res.json({ ok: true });
  const actionsCount = session.actionsCount;
  await demoStore.release(session);
  console.log(`[render] demo ${demoId} stopped after ${actionsCount} action(s)`);
  return res.json({ ok: true, actionsCount });
});

app.listen(PORT, () => console.log(`aiflow-render listening on :${PORT}`));
