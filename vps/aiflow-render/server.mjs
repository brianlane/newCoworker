/**
 * AiFlow render service — headless-Chromium browse backend for AiFlows.
 *
 * The default AiFlows browse backend is a static fetch inside the ai-flow-worker.
 * For JS-rendered (SPA) pages a static fetch can't read, AND for LOGIN-GATED
 * pages a static fetch can't authenticate, deploy this service on the VPS and
 * point the worker at it with:
 *
 *   AIFLOW_RENDER_URL=https://<vps-host>/render      (worker secret)
 *   AIFLOW_RENDER_TOKEN=<shared-bearer>              (worker + this service)
 *
 * Contract (matches supabase/functions/_shared/ai_flows/browse.ts):
 *   POST /render { url }                              -> { finalUrl, text, html }
 *   POST /render { url, businessId, auth }            -> { finalUrl, text, html }
 *
 * When `auth` is present the service logs in first using the named custom
 * integration's stored credentials (fetched from the platform's gateway-guarded
 * /api/integrations/custom/credentials endpoint), reusing a per-tenant browser
 * context so the session cookie is cached across calls. It only READS the page —
 * it fills + submits the login form and never clicks lead-page action buttons
 * (accept/call/email), which can create binding agreements.
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
 * Idle contexts are evicted by TTL; the map is capped at MAX_SESSIONS.
 */
const sessions = new Map(); // key -> { context, lastUsed }

async function evictStale() {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      sessions.delete(key);
      await s.context.close().catch(() => {});
    }
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
    await oldest[1].context.close().catch(() => {});
  }
}

async function getSessionContext(key) {
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.context;
  }
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA });
  sessions.set(key, { context, lastUsed: Date.now() });
  await evictStale();
  return context;
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

/** True when the current page looks like a login form (a password field exists). */
async function looksLikeLogin(page) {
  return (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
}

async function performLogin(page, creds, login) {
  const userSel = await firstSelector(page, [
    login?.usernameSelector,
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[name*="user" i]',
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

app.post("/render", async (req, res) => {
  const safe = safeUrl(String(req.body?.url ?? ""));
  if (!safe) return res.status(400).json({ error: "invalid_or_unsafe_url" });
  const auth = req.body?.auth;
  const businessId = req.body?.businessId;

  // --- Unauthenticated render: stateless context, no session reuse. ---
  if (!auth) {
    let context;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({ userAgent: UA });
      const page = await context.newPage();
      await attachSsrfGuard(page);
      await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return res.json({ finalUrl: page.url(), text, html });
    } catch (e) {
      return res.status(502).json({ error: "render_failed", detail: String(e).slice(0, 300) });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // --- Authenticated render: per-tenant session, login on demand. ---
  const label = auth?.integrationLabel;
  if (!businessId || !label) return res.status(400).json({ error: "missing_business_or_label" });
  const key = `${businessId}:${label}`;
  let page;
  try {
    const context = await getSessionContext(key);
    page = await context.newPage();
    await attachSsrfGuard(page);
    await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });

    if (await looksLikeLogin(page)) {
      const creds = await fetchCredentials(businessId, label);
      await performLogin(page, creds, auth?.login);
      await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      // Login can fail (bad creds / MFA / captcha) — surface it instead of
      // returning a useless login page the extractor would silently mis-read.
      if (await looksLikeLogin(page)) {
        return res.status(502).json({ error: "login_failed" });
      }
    }

    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return res.json({ finalUrl: page.url(), text, html });
  } catch (e) {
    // Drop a poisoned session so the next call starts clean.
    const s = sessions.get(key);
    if (s) {
      sessions.delete(key);
      await s.context.close().catch(() => {});
    }
    return res.status(502).json({ error: "render_failed", detail: String(e).slice(0, 300) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`aiflow-render listening on :${PORT}`));
