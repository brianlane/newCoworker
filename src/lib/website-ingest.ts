/**
 * One-shot shallow website ingestion for onboarding.
 *
 * Fetches a small sample of pages under a single origin, extracts readable
 * text, then asks Gemini to summarize it into a compact `website.md` block
 * that gets shipped to `/opt/rowboat/vault/website.md` on the VPS alongside
 * `soul.md`, `identity.md`, and `memory.md`.
 *
 * Design goals:
 * - Cheap: one request up front, at most ~6 follow-up pages.
 * - Safe-ish: DNS allowlist + per-hop hostname re-check for redirects, robots
 *   respect, hard timeouts, streamed byte cap. See `fetchWithLimit` for the
 *   residual DNS-rebinding TOCTOU risk that sits above the fetch layer.
 * - Non-blocking: the onboarding flow calls this after checkout succeeds; a
 *   failure logs but does not stop the user from landing on the dashboard.
 */

import { promises as dns } from "node:dns";
import { logger } from "@/lib/logger";

export const WEBSITE_INGEST_MAX_PAGES = 6;
export const WEBSITE_INGEST_PAGE_TIMEOUT_MS = 5000;
export const WEBSITE_INGEST_MAX_BYTES_PER_PAGE = 1_000_000;
export const WEBSITE_INGEST_MAX_COMBINED_CHARS = 40_000;
export const WEBSITE_INGEST_MAX_SUMMARY_CHARS = 8_000;

export type WebsiteIngestError =
  | "invalid_url"
  | "private_address"
  | "dns_failure"
  | "blocked_by_robots"
  | "fetch_failed"
  | "empty_content"
  | "summarizer_unavailable"
  | "summarizer_failed";

export type WebsiteIngestSuccess = {
  ok: true;
  websiteMd: string;
  pagesCrawled: number;
  bytesDownloaded: number;
  finalUrl: string;
};

export type WebsiteIngestFailure = {
  ok: false;
  error: WebsiteIngestError;
  detail?: string;
};

export type WebsiteIngestResult = WebsiteIngestSuccess | WebsiteIngestFailure;

type FetchImpl = typeof fetch;
type DnsLookup = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

type GeminiSummarizer = (prompt: string) => Promise<string>;

export interface WebsiteIngestOptions {
  fetchImpl?: FetchImpl;
  lookup?: DnsLookup;
  summarize?: GeminiSummarizer;
  businessName?: string;
  businessType?: string;
  maxPages?: number;
}

export function normalizeWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("::ffff:")) {
    const ipv4 = normalized.slice("::ffff:".length);
    return isPrivateIpv4(ipv4);
  }
  return false;
}

export async function assertSafeHostname(
  hostname: string,
  lookup: DnsLookup = dns.lookup
): Promise<void> {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("private_address");
  }
  // Reject bare IP literals outright — legitimate public sites use hostnames.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    throw new Error("private_address");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error("dns_failure");
  }
  if (!addresses.length) throw new Error("dns_failure");

  for (const { address, family } of addresses) {
    if (family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address)) {
      throw new Error("private_address");
    }
  }
}

export function parseRobotsDisallows(robots: string, userAgent = "newcoworker-bot"): string[] {
  const lines = robots.split(/\r?\n/);
  const groups: { agents: string[]; disallows: string[] }[] = [];
  let current: { agents: string[]; disallows: string[] } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!current || current.disallows.length > 0) {
        current = { agents: [value.toLowerCase()], disallows: [] };
        groups.push(current);
      } else {
        current.agents.push(value.toLowerCase());
      }
    } else if (field === "disallow" && current) {
      current.disallows.push(value);
    }
  }

  const ua = userAgent.toLowerCase();
  const matched = groups.filter((g) => g.agents.includes(ua));
  const fallback = groups.filter((g) => g.agents.includes("*"));
  const active = matched.length > 0 ? matched : fallback;
  return active.flatMap((g) => g.disallows).filter(Boolean);
}

export function isPathAllowed(pathname: string, disallows: string[]): boolean {
  for (const rule of disallows) {
    if (!rule) continue; // Empty Disallow means allow everything.
    if (pathname.startsWith(rule)) return false;
  }
  return true;
}

export function extractReadableText(html: string): string {
  // CodeQL (js/bad-tag-filter): HTML parsers accept arbitrary junk between the
  // tag name and `>` on a closing tag — `</script >`, `</script\t\nfoo>`, and
  // `</style bar="baz">` all legally close the element. Our strip pass has to
  // swallow anything up to the next `>` after the tag name (`\b[^>]*>`) so
  // those malformed closers can't leak inline JS/CSS into the text corpus.
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\b[^>]*>/gi, " ")
    // Drop any remaining unterminated script/style openers so a malformed
    // document can't smuggle their bodies into the text pipeline.
    .replace(/<script\b[\s\S]*$/gi, " ")
    .replace(/<style\b[\s\S]*$/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // CodeQL (js/double-escaping): decode `&amp;` LAST. If we decoded it first,
  // an input like `&amp;lt;` would turn into `<` after subsequent passes, which
  // flips structural HTML. Decoding it last leaves intermediate entities in
  // their literal form until all sibling entities have been resolved.
  const decoded = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10000 ? String.fromCodePoint(n) : " ";
    })
    .replace(/&amp;/g, "&");

  return decoded
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractSameOriginLinks(html: string, baseUrl: URL): string[] {
  const urls = new Set<string>();
  const regex = /<a\s+[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    // `match[1] ?? match[2] ?? match[3]` covers the three alternation arms
    // (double / single / unquoted). The final `?? ""` is defensive against a
    // runtime that invents an empty match object — it's unreachable given the
    // regex always captures one group when it matches.
    /* c8 ignore next */
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const lower = href.toLowerCase();
    // Skip XSS-shaped schemes and non-HTTP nav targets. CodeQL flags incomplete
    // allowlists here; we also exclude `data:` and `vbscript:` to match the
    // DOM-XSS sanitizer guidance even though we never eval these hrefs — the
    // origin check below would reject most of them, but enumerating schemes
    // gives a clear audit trail and short-circuits pathological inputs.
    if (
      !href ||
      href.startsWith("#") ||
      lower.startsWith("javascript:") ||
      lower.startsWith("data:") ||
      lower.startsWith("vbscript:") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("tel:")
    ) {
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== baseUrl.origin) continue;
      if (!/\.(html?|aspx?|php)$/i.test(resolved.pathname) && /\.[a-z0-9]{2,4}$/i.test(resolved.pathname)) {
        continue; // skip images, pdfs, etc.
      }
      resolved.hash = "";
      urls.add(resolved.toString());
    } catch {
      continue;
    }
  }
  return Array.from(urls);
}

const MAX_REDIRECTS = 5;

/**
 * Fetches `url` with four guardrails layered in priority order:
 *
 *  1. Single-host SSRF guard on the initial hostname (caller must also have
 *     called `assertSafeHostname` before the first hop — we re-validate here
 *     so `fetchRobots` / redirect hops cannot smuggle in a private host).
 *  2. Manual redirect handling. We never let the runtime auto-follow a
 *     `Location:` header into a private IP; each hop is re-validated against
 *     the same DNS allowlist used for the original URL.
 *  3. Streaming body reader. We pull chunks from `response.body` and trip
 *     `payload_too_large` the moment we cross `maxBytes`, instead of letting
 *     `arrayBuffer()` buffer an unbounded response before the size check.
 *  4. A single overall timeout shared by all hops + the streaming read.
 *
 * Residual risk: DNS rebinding between `assertSafeHostname` and the socket
 * connect remains possible because Node's `fetch` does its own resolution. We
 * keep the language honest in docs + logs ("SSRF-checked" not "SSRF-proof").
 * Fully closing that gap requires pinning the resolved IP on the socket,
 * which means bypassing `fetch` for a custom agent — tracked separately.
 */
async function fetchWithLimit(
  url: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  maxBytes: number,
  lookup: DnsLookup
): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const controller = new AbortController();
  /* c8 ignore next -- timer callback fires only on real-world timeouts; the
     AbortError path it produces is exercised via AbortError-returning mocks. */
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = new URL(url);
    await assertSafeHostname(currentUrl.hostname, lookup);

    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hopResponse = await fetchImpl(currentUrl.toString(), {
        redirect: "manual",
        headers: {
          "user-agent": "newcoworker-bot/1.0 (+https://newcoworker.ai)",
          accept: "text/html,application/xhtml+xml"
        },
        signal: controller.signal
      });

      if (hopResponse.status >= 300 && hopResponse.status < 400) {
        const location = hopResponse.headers.get("location");
        // Drain the redirect body so the underlying socket can be reused /
        // released. `cancel()` returns a promise we swallow — failures here
        // are benign (already-closed streams).
        if (hopResponse.body) {
          /* c8 ignore next -- the `.catch(() => {})` is a swallow-and-move-on
             no-op for already-closed streams; cancel() resolves in normal runs. */
          await hopResponse.body.cancel().catch(() => {});
        }
        if (!location) throw new Error("redirect_without_location");
        if (hop === MAX_REDIRECTS) throw new Error("too_many_redirects");

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error("invalid_redirect_target");
        }
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new Error("unsupported_redirect_scheme");
        }
        await assertSafeHostname(nextUrl.hostname, lookup);
        currentUrl = nextUrl;
        continue;
      }

      response = hopResponse;
      break;
    }

    /* c8 ignore next 4 -- defensive: the loop either assigns response or
       throws on every path, but TS can't see that through the redirect
       branch. This guard exists purely so we never deref `response!`. */
    if (!response) {
      throw new Error("no_response");
    }
    if (!response.ok) {
      throw new Error(`status_${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new Error("non_html_content_type");
    }

    // Belt-and-suspenders: if the runtime silently followed a redirect behind
    // our back (some polyfills ignore `redirect: "manual"`), re-validate the
    // final URL's hostname before we read any bytes.
    try {
      const finalHost = new URL(response.url || currentUrl.toString()).hostname;
      if (finalHost && finalHost !== currentUrl.hostname) {
        await assertSafeHostname(finalHost, lookup);
      }
    } catch (err) {
      if (err instanceof Error && (err.message === "private_address" || err.message === "dns_failure")) {
        throw err;
      }
      // URL parse failures fall through — `response.url` is best-effort.
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          /* c8 ignore next -- the streams spec guarantees `value` is present
             when `done === false`, but the property is typed as optional so
             we keep the null-guard to stay honest with TS. */
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            /* c8 ignore next -- swallow-and-move-on no-op for stream readers
               whose cancel() rejects; standard ReadableStream resolves. */
            await reader.cancel().catch(() => {});
            throw new Error("payload_too_large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // No streaming body (mocked Responses / very old runtimes). Fall back to
      // arrayBuffer but still enforce the cap immediately after buffering.
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw new Error("payload_too_large");
      chunks.push(new Uint8Array(buffer));
      total = buffer.byteLength;
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(merged);
    return { body, contentType, finalUrl: response.url || currentUrl.toString() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRobots(
  origin: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  lookup: DnsLookup
): Promise<string> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const { body } = await fetchWithLimit(robotsUrl, fetchImpl, timeoutMs, 500_000, lookup);
    return body;
  } catch {
    return "";
  }
}

function buildSummarizationPrompt(args: {
  url: string;
  businessName?: string;
  businessType?: string;
  corpus: string;
}): string {
  const header = [
    `You are condensing the public website of ${args.businessName ?? "a small business"}${
      args.businessType ? ` (${args.businessType})` : ""
    } into a vault file called website.md.`,
    `Source URL: ${args.url}`,
    "",
    "Write ~400–600 words of clean markdown with these sections (omit a section only if nothing on the site applies):",
    "## Summary",
    "## Services",
    "## Service Area",
    "## Pricing & Offers",
    "## Hours & Contact",
    "## Tone & Positioning",
    "## Frequently Asked Topics",
    "",
    "Rules:",
    "- Only include facts that appear in the crawled text. Do not invent phone numbers, prices, or guarantees.",
    "- Prefer concise bullet points over marketing prose.",
    "- If the site is mostly empty or under construction, output a single section ## Summary explaining that and stop.",
    "- Never include HTML, base64, scripts, or links to tracking pixels.",
    "",
    "Crawled text (may be truncated):",
    "---",
    args.corpus,
    "---"
  ];
  return header.join("\n");
}

async function defaultGeminiSummarize(prompt: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("summarizer_unavailable");
  const model = process.env.GEMINI_ROWBOAT_MODEL ?? process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3.1-flash";

  const controller = new AbortController();
  /* c8 ignore next -- the 20s timer only fires when Gemini actually hangs;
     AbortError classification is covered by classifyGeminiError tests. */
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 1500,
          messages: [
            {
              role: "system",
              content: "You compress small-business websites into concise, accurate markdown briefings."
            },
            { role: "user", content: prompt }
          ]
        })
      }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`gemini_http_${response.status}:${text.slice(0, 200)}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("summarizer_empty");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function ingestWebsite(
  rawUrl: string,
  options: WebsiteIngestOptions = {}
): Promise<WebsiteIngestResult> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) return { ok: false, error: "invalid_url" };
  // `normalizeWebsiteUrl` guarantees a well-formed http/https URL, so we can
  // parse without re-checking scheme or wrapping in a try/catch. Keeping the
  // defensive re-parse would leave unreachable branches hurting coverage
  // without adding real safety.
  const parsed = new URL(normalized);

  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? (dns.lookup as unknown as DnsLookup);
  const summarize = options.summarize ?? defaultGeminiSummarize;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? WEBSITE_INGEST_MAX_PAGES, 10));

  try {
    await assertSafeHostname(parsed.hostname, lookup);
  } catch (err) {
    // `assertSafeHostname` only throws `Error("private_address" | "dns_failure")`.
    // The `: ""` fallback is kept so TS doesn't have to trust that invariant,
    // but it's defensively unreachable — hence the ignore marker.
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : "";
    const code: WebsiteIngestError = message === "dns_failure" ? "dns_failure" : "private_address";
    return { ok: false, error: code };
  }

  const robots = await fetchRobots(parsed.origin, fetchImpl, WEBSITE_INGEST_PAGE_TIMEOUT_MS, lookup);
  const disallows = parseRobotsDisallows(robots);
  // WHATWG URL always exposes `pathname` as a non-empty string ("/" at the
  // minimum). The `|| "/"` guard is defensive against hypothetical polyfills
  // and is unreachable in the Node runtime we ship on.
  /* c8 ignore next */
  if (!isPathAllowed(parsed.pathname || "/", disallows)) {
    return { ok: false, error: "blocked_by_robots" };
  }

  const visited = new Set<string>();
  const pages: Array<{ url: string; text: string }> = [];
  let bytesDownloaded = 0;

  const queue: string[] = [normalized];

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift();
    /* c8 ignore next -- `queue.length > 0` in the while guards against `!next`,
       and `visited.has` is defensive because we always check before queueing. */
    if (!next || visited.has(next)) continue;
    visited.add(next);
    try {
      const nextUrl = new URL(next);
      // Same defensive `|| "/"` as above — unreachable on our supported runtimes.
      /* c8 ignore next */
      if (!isPathAllowed(nextUrl.pathname || "/", disallows)) continue;
      const isHomepage = next === normalized;
      const { body, finalUrl } = await fetchWithLimit(
        next,
        fetchImpl,
        WEBSITE_INGEST_PAGE_TIMEOUT_MS,
        WEBSITE_INGEST_MAX_BYTES_PER_PAGE,
        lookup
      );
      bytesDownloaded += body.length;
      const text = extractReadableText(body);
      if (text.trim()) {
        pages.push({ url: finalUrl, text });
      }
      if (isHomepage) {
        // Expand the queue from the homepage to keep "shallow" semantics. We
        // do this even when `text` is empty — JS-heavy homepages often render
        // their copy through linked subpages, and keying off `pages.length`
        // would silently drop those sites with `fetch_failed`.
        const links = extractSameOriginLinks(body, new URL(finalUrl));
        for (const link of links) {
          if (queue.length + pages.length >= maxPages) break;
          if (!visited.has(link)) queue.push(link);
        }
      }
    } catch (err) {
      // `fetchWithLimit` / assertSafeHostname always reject with `Error`
      // instances; the `String(err)` branch is a safety net for a hypothetical
      // non-Error throw and is unreachable on our stack.
      /* v8 ignore next */
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn("website-ingest: fetch failed", { url: next, error: errorMessage });
      continue;
    }
  }

  if (pages.length === 0) {
    return { ok: false, error: "fetch_failed" };
  }

  const combined = pages
    .map((p) => `### ${p.url}\n${p.text}`)
    .join("\n\n")
    .slice(0, WEBSITE_INGEST_MAX_COMBINED_CHARS);

  if (combined.trim().length < 200) {
    return { ok: false, error: "empty_content" };
  }

  const prompt = buildSummarizationPrompt({
    url: normalized,
    businessName: options.businessName,
    businessType: options.businessType,
    corpus: combined
  });

  let summary: string;
  try {
    summary = await summarize(prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (message === "summarizer_unavailable") {
      return { ok: false, error: "summarizer_unavailable" };
    }
    logger.warn("website-ingest: summarize failed", { error: message });
    return { ok: false, error: "summarizer_failed", detail: message };
  }

  const trimmedSummary = summary.trim().slice(0, WEBSITE_INGEST_MAX_SUMMARY_CHARS);
  const websiteMd = [
    `# website.md`,
    `Source: ${normalized}`,
    `Ingested: ${new Date().toISOString()}`,
    "",
    trimmedSummary
  ].join("\n");

  return {
    ok: true,
    websiteMd,
    pagesCrawled: pages.length,
    bytesDownloaded,
    finalUrl: pages[0].url
  };
}
