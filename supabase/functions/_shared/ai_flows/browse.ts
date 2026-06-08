/**
 * AiFlows browse helpers: SSRF-safe URL normalization + the render-service
 * contract. PURE (no IO) so it is unit-tested; the ai-flow-worker performs the
 * actual fetch.
 *
 * Phase-0 spike decision: the default browse backend is a STATIC fetch of the
 * (public) lead page. The contract here also describes an optional external
 * render service (`AIFLOW_RENDER_URL`) so a heavier headless backend
 * (Playwright/Lightpanda on the VPS) can be swapped in later for SPA pages
 * WITHOUT touching the engine — the worker just POSTs `{ url }` and gets back
 * `{ finalUrl, text, html }`.
 *
 * Every URL the worker fetches (directly or via the render service) MUST pass
 * `normalizeBrowseUrl` first so a malicious lead link can't point the fetcher at
 * cloud metadata / LAN hosts.
 */

/** IPv4 dotted-quad classification: true = private/loopback/reserved (unsafe). */
function isPrivateIpv4Literal(host: string): boolean {
  // Caller gates on a 4-octet dotted-quad regex, so split always yields 4 parts.
  const parts = host.split(".").map((n) => Number(n));
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

/**
 * True when a hostname must NOT be fetched: loopback/localhost, cloud-metadata
 * names, `*.internal`, private IPv4 literals, and ALL IPv6 literals (blocked
 * conservatively — public browsing always has a DNS name).
 */
export function isUnsafeBrowseHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal" || h.endsWith(".internal")) {
    return true;
  }
  if (h.includes(":")) return true; // IPv6 literal (URL.hostname is bracketless)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isPrivateIpv4Literal(h);
  return false;
}

/**
 * Validate + normalize a URL for browsing. Returns the canonical string, or
 * null when the URL is unparseable, not http(s), or points at an unsafe host.
 */
export function normalizeBrowseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isUnsafeBrowseHost(url.hostname)) return null;
  return url.toString();
}

export type RenderResult = {
  finalUrl: string;
  text: string;
  html: string;
};

/**
 * Coerce an external render-service JSON body into a `RenderResult`, or null if
 * it doesn't match the contract. Lets the worker treat a malformed render
 * response as a recoverable step failure instead of throwing.
 */
export function parseRenderResponse(body: unknown, requestedUrl: string): RenderResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text : "";
  const html = typeof b.html === "string" ? b.html : "";
  if (!text && !html) return null;
  const finalUrl = typeof b.finalUrl === "string" && b.finalUrl ? b.finalUrl : requestedUrl;
  return { finalUrl, text, html };
}
