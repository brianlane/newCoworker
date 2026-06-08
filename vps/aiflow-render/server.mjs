/**
 * AiFlow render service (OPTIONAL, deferred per the Phase-0 spike).
 *
 * The default AiFlows browse backend is a static fetch performed inside the
 * ai-flow-worker. For JS-rendered (SPA) lead pages that a static fetch can't
 * read, deploy this small headless-Chromium service on the VPS Docker host and
 * point the worker at it with:
 *
 *   AIFLOW_RENDER_URL=http://aiflow-render:8080/render
 *
 * Contract (matches supabase/functions/_shared/ai_flows/browse.ts):
 *   POST /render { "url": "https://..." }  ->  { finalUrl, text, html }
 *
 * SSRF guard mirrors the worker's normalizeBrowseUrl: only http(s), no
 * localhost / private IPv4 / IPv6-literal / *.internal / metadata hosts.
 */
import express from "express";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 8080);
const NAV_TIMEOUT_MS = Number(process.env.AIFLOW_RENDER_TIMEOUT_MS ?? 20000);

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

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  return browserPromise;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  const safe = safeUrl(String(req.body?.url ?? ""));
  if (!safe) return res.status(400).json({ error: "invalid_or_unsafe_url" });
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ userAgent: "NewCoworker-AiFlow/1.0" });
    const page = await context.newPage();
    await page.goto(safe, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return res.json({ finalUrl: page.url(), text, html });
  } catch (e) {
    return res.status(502).json({ error: "render_failed", detail: String(e).slice(0, 300) });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`aiflow-render listening on :${PORT}`));
