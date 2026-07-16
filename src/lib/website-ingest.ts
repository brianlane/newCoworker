/**
 * Website ingestion for onboarding and dashboard re-crawls.
 *
 * Fetches pages under a single origin, extracts readable text, then asks
 * Gemini to summarize it into a compact `website.md` block that gets shipped
 * to `/opt/rowboat/vault/website.md` on the VPS alongside `soul.md`,
 * `identity.md`, and `memory.md`.
 *
 * Two crawl profiles share this module:
 * - Shallow (default, `WEBSITE_INGEST_MAX_PAGES`): homepage + a handful of
 *   linked pages. Used by the unauthenticated onboarding preview where cost
 *   per request matters.
 * - Deep (`WEBSITE_INGEST_DEEP_MAX_PAGES` + `sitemapDiscovery`): seeds the
 *   queue from `/sitemap.xml` (following one level of sitemap-index nesting)
 *   and BFS-expands links from every crawled page, fetching small batches
 *   concurrently under an overall deadline. Used by the authenticated
 *   `/api/onboard/website-ingest` route so the vault summary reflects the
 *   whole site (parity with GHL-style "N pages crawled" crawlers).
 *
 * Design goals:
 * - Safe-ish: DNS allowlist + per-hop hostname re-check for redirects, robots
 *   respect, hard timeouts, streamed byte cap. See `fetchWithLimit` for the
 *   residual DNS-rebinding TOCTOU risk that sits above the fetch layer.
 * - Non-blocking: the onboarding flow calls this after checkout succeeds; a
 *   failure logs but does not stop the user from landing on the dashboard.
 */

import { promises as dns } from "node:dns";
import { GeminiEmptyError, geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";
import { isPrivateIpv4, isPrivateIpv6 } from "@/lib/net/ip-classification";
import { BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS } from "@/lib/vault/business-config-markdown-limits";

export const WEBSITE_INGEST_MAX_PAGES = 6;
/**
 * Hard ceiling for `options.maxPages`, and the value the authenticated ingest
 * route requests for its deep crawl. Sized so a sitemap-rich small-business
 * site (e.g. a Wix blog with ~67 pages) fits inside one crawl.
 */
export const WEBSITE_INGEST_DEEP_MAX_PAGES = 80;
export const WEBSITE_INGEST_PAGE_TIMEOUT_MS = 5000;
/**
 * Per-page streamed byte cap. Raised from 1 MB after a production Wix
 * homepage (trulyinsurance.ca) grew past 4 MB of served HTML — builder
 * platforms routinely inline several MB of CSS/JSON into the document, and
 * tripping `payload_too_large` on the homepage kills the whole crawl.
 */
export const WEBSITE_INGEST_MAX_BYTES_PER_PAGE = 8_000_000;
/**
 * Cumulative download budget across the whole crawl. A deep crawl of 80
 * pathological pages at the per-page cap would otherwise pull ~640 MB
 * through the route; the crawl stops (keeping what it has) once crossed.
 * Sized for real builder platforms: Wix serves ~4 MB of HTML per page, so
 * an 80-page Wix site needs ~320 MB of headroom. Only the extracted text is
 * retained — page bodies are transient (at most 4 in flight).
 */
export const WEBSITE_INGEST_MAX_TOTAL_BYTES = 400_000_000;
export const WEBSITE_INGEST_MAX_COMBINED_CHARS = 150_000;
/**
 * Per-page floor for the corpus slice. The actual per-page budget is
 * `max(this, MAX_COMBINED / pageCount)` so a single-page crawl can still use
 * the whole combined budget while an 80-page crawl gives every page a fair
 * share instead of letting one bloated page crowd out the rest.
 */
export const WEBSITE_INGEST_MAX_CHARS_PER_PAGE = 8_000;
/**
 * Low-signal floor: unless at least ONE crawled page carries this many
 * extracted chars, the crawl found nothing usable. Judged per-page (not on
 * the summed corpus) because a deep crawl of a JS-rendered SPA can stack
 * many shell pages whose only text is each page's <title> — the sum would
 * sneak past a corpus-wide floor and produce a titles-only garbage summary.
 */
export const WEBSITE_INGEST_MIN_CORPUS_CHARS = 200;
/** Parallel page fetches per crawl wave. */
export const WEBSITE_INGEST_CRAWL_CONCURRENCY = 4;
/**
 * Overall crawl deadline (fetch phase only — the summarizer has its own 20s
 * budget). 4-way concurrency over 80 pages at the 5s per-page timeout worst-
 * cases to ~100s, so 120s leaves the route's 300s `maxDuration` plenty of
 * room for the summary + post-response vault re-seed.
 */
export const WEBSITE_INGEST_CRAWL_DEADLINE_MS = 120_000;
/** Byte cap for a single sitemap XML document (same as robots.txt). */
export const WEBSITE_INGEST_SITEMAP_MAX_BYTES = 500_000;
/** How many child sitemaps of a sitemap index we follow (one nesting level). */
export const WEBSITE_INGEST_SITEMAP_MAX_CHILDREN = 5;
export const WEBSITE_INGEST_MAX_SUMMARY_CHARS = BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS;

/** Used when env omits `GEMINI_SUMMARY_MODEL`, or carries a Gemini id unsupported on `:generateContent`. */
const WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT = "gemini-3-flash-preview";

/**
 * Website summarization runs on the Next/Vercel host. Prefer a dedicated summary
 * model so `GEMINI_ROWBOAT_MODEL` (wired for the VPS Rowboat router) cannot
 * override with a stale value and break ingest.
 *
 * Strips optional `models/` prefix from env values (common when copying from
 * Google Cloud / AI Studio resource names). Retired Gemini ids (1.5 / 1.0
 * family, bare `gemini-pro`, gemini-3.1-era ids) coerce to
 * {@link WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT}.
 */
function stripGeminiModelsPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("models/")) return trimmed.slice("models/".length).trim();
  return trimmed;
}

/** Gemini ids that reliably 404 or have been superseded on the `:generateContent` route. */
function isStaleWebsiteSummaryGeminiId(id: string): boolean {
  return (
    /^gemini-1\.5/i.test(id) ||
    /^gemini-1\.0/i.test(id) ||
    /^gemini-pro$/i.test(id) ||
    /^gemini-3\.1/i.test(id)
  );
}

function resolveWebsiteSummaryGeminiModel(): string {
  const rawFromEnv =
    (process.env.GEMINI_SUMMARY_MODEL ?? "").trim() ||
    (process.env.GEMINI_ROWBOAT_MODEL ?? "").trim();
  let resolved = stripGeminiModelsPrefix(rawFromEnv || WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT);
  if (!resolved) {
    resolved = WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT;
  }

  if (isStaleWebsiteSummaryGeminiId(resolved)) {
    logger.info("website-ingest: coercing legacy Gemini model id for summarizer", {
      from: stripGeminiModelsPrefix(rawFromEnv),
      to: WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT
    });
    resolved = WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT;
  }

  return resolved;
}

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
  /** Every page that contributed text to the summary, in crawl order. */
  pages: Array<{ url: string; chars: number }>;
};

/**
 * Live crawl telemetry emitted through `WebsiteIngestOptions.onProgress`.
 * The ingest route streams these to the dashboard as NDJSON so owners can
 * watch each page get crawled (GHL-style "N pages crawled") instead of
 * staring at a spinner for a minute.
 */
export type WebsiteIngestProgressEvent =
  | { type: "sitemap_found"; count: number }
  | { type: "page_fetched"; url: string; bytes: number; index: number }
  | { type: "page_failed"; url: string }
  | { type: "summarizing"; pages: number };

export type WebsiteIngestFailure = {
  ok: false;
  error: WebsiteIngestError;
  detail?: string;
};

export type WebsiteIngestResult = WebsiteIngestSuccess | WebsiteIngestFailure;

type FetchImpl = typeof fetch;
type DnsLookup = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

type GeminiSummarizer = (prompt: string, meterBusinessId?: string) => Promise<string>;

export interface WebsiteIngestOptions {
  fetchImpl?: FetchImpl;
  lookup?: DnsLookup;
  summarize?: GeminiSummarizer;
  businessName?: string;
  businessType?: string;
  maxPages?: number;
  /**
   * When true, seed the crawl queue from the site's `/sitemap.xml` (following
   * one level of sitemap-index nesting) before BFS link expansion. This is
   * how full-site crawlers (GHL etc.) reach blog posts and deep pages the
   * homepage never links to. Sitemap fetches run through the same
   * SSRF-guarded `fetchWithLimit` and same-origin filter as page fetches;
   * a missing/broken sitemap degrades silently to link-only discovery.
   */
  sitemapDiscovery?: boolean;
  /** Overall crawl-phase deadline. Defaults to {@link WEBSITE_INGEST_CRAWL_DEADLINE_MS}. */
  crawlDeadlineMs?: number;
  /** Cumulative download budget. Defaults to {@link WEBSITE_INGEST_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number;
  /**
   * Live progress callback (see {@link WebsiteIngestProgressEvent}). Called
   * synchronously from the crawl loop — keep it cheap (the ingest route just
   * enqueues an NDJSON line).
   */
  onProgress?: (event: WebsiteIngestProgressEvent) => void;
  /**
   * When true, skip the robots.txt fetch and the per-page
   * `isPathAllowed` check. Intended ONLY for owner-consented contexts
   * — i.e. the onboarding flow where the business owner has
   * explicitly typed in their own site's URL and is asking us to
   * summarize it for their assistant. robots.txt is a directive to
   * third-party crawlers, not to first-party agents the site owner
   * has actively invoked, and many small-business sites ship a
   * default-deny `User-agent: * / Disallow: /` block that would
   * otherwise prevent the owner's own assistant from learning about
   * their own business.
   *
   * SSRF / DNS-rebinding / private-IP / size / timeout / redirect
   * defenses are all unaffected by this flag — only the robots.txt
   * preference layer is bypassed. Callers MUST NOT pass `true` for
   * URLs the user did not explicitly provide.
   */
  ignoreRobots?: boolean;
  /**
   * When set, the default Gemini summarizer meters its spend into this
   * business's shared AI budget (`owner_chat_model_spend`). The summary
   * runs on the gemini-3 tier with a large crawled-text prompt — left
   * unmetered it was the biggest gap between the billing page's "AI chat
   * budget" and Google's actual bill. Ignored when a custom `summarize`
   * is injected (tests).
   */
  meterBusinessId?: string;
  /**
   * When true, and the direct crawl recovers zero pages (e.g. the site
   * is behind Cloudflare bot mitigation returning HTTP 403 to every
   * non-browser client), fall back to the Jina Reader service
   * (`https://r.jina.ai/<url>`) to fetch a rendered, readable markdown
   * version of the homepage. Jina runs a real browser pool server-side,
   * so it clears active JS challenges that header/UA/TLS spoofing can't.
   *
   * This is far lighter than running a headless browser per VPS — it's a
   * single outbound HTTP GET that already returns summarization-ready
   * markdown. Tradeoff: it sends the (owner-provided, public) URL to a
   * third party and adds a few seconds of latency, so it's gated to the
   * owner-consented persist/preview paths and only fires when the direct
   * crawl fails. Set `JINA_API_KEY` to lift the free-tier rate limit.
   *
   * Default off; only the website-ingest / website-preview routes opt in.
   */
  readerFallback?: boolean;
}

/**
 * Map an internal fetch-failure message (from {@link fetchWithLimit}) to
 * a sentence the dashboard's `websiteIngestErrorMessage` can render as
 * `detail`. The mapping is intentionally conservative — we only special-
 * case the failure modes we've seen in production where the canned
 * "We couldn't reach any pages" copy was actively misleading.
 *
 * Crucially: `status_403` is the symptom of Cloudflare's bot mitigation
 * (`cf-mitigated: challenge`) intercepting the homepage fetch. Owners
 * whose own site is fronted by Cloudflare with bot fight mode on
 * couldn't tell their CDN was blocking us — they assumed our crawler
 * was broken.
 */
export function humanizeFetchError(message: string): string {
  if (message === "status_403" || message === "status_401") {
    return "Your site blocked our crawler (HTTP 403/401). This usually means a CDN like Cloudflare has bot protection enabled. Open your homepage, right-click → View Page Source, copy everything, and paste it below so we can summarize it for you.";
  }
  if (message === "status_429") {
    return "Your site rate-limited our crawler (HTTP 429). Wait a minute and click Re-crawl, or paste a manual summary below.";
  }
  if (message.startsWith("status_5")) {
    return `Your site returned a server error (HTTP ${message.slice(7)}). It may be temporarily down. Try again later, or paste a manual summary below.`;
  }
  if (message.startsWith("status_")) {
    return `Your site returned HTTP ${message.slice(7)}. Verify the URL or paste a manual summary below.`;
  }
  if (message === "non_html_content_type") {
    return "The URL points at a non-HTML resource (PDF, image, etc.). Use the canonical landing page or paste a manual summary below.";
  }
  if (message === "redirect_loop" || message === "too_many_redirects") {
    return "Your site redirected too many times. Use the final URL directly or paste a manual summary below.";
  }
  if (message === "private_address" || message === "dns_failure") {
    return "We couldn't resolve that domain. Double-check the URL.";
  }
  // Anything else (network resets, abort timeouts, malformed HTML) gets
  // a clean generic copy — the canned message in the dashboard
  // ("Check the URL, SSL, or firewall") already covers this case
  // adequately, but returning the raw message also helps support
  // diagnose oddball failures from the logs.
  return `Crawler error: ${message}.`;
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
    // `isPrivateIpv6` expects a lowercased literal because callers
    // typically already have one in scope; node's `dns.lookup` does
    // already return lowercase IPv6, but a custom `lookup` injected
    // for tests might not, so lowercase defensively.
    const blocked =
      family === 4
        ? isPrivateIpv4(address)
        : isPrivateIpv6(address.toLowerCase());
    if (blocked) {
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

/**
 * Same-origin + "looks like an HTML page" filter shared by link extraction
 * and sitemap discovery. Returns the normalized URL string (hash stripped)
 * or null when the candidate should be skipped.
 */
function normalizeCrawlableUrl(href: string, baseUrl: URL): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.origin !== baseUrl.origin) return null;
    if (!/\.(html?|aspx?|php)$/i.test(resolved.pathname) && /\.[a-z0-9]{2,4}$/i.test(resolved.pathname)) {
      return null; // skip images, pdfs, etc.
    }
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
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
    const normalized = normalizeCrawlableUrl(href, baseUrl);
    if (normalized) urls.add(normalized);
  }
  return Array.from(urls);
}

/**
 * Extract `<loc>` entries from a sitemap document. A `urlset` yields page
 * URLs; a `sitemapindex` yields child-sitemap URLs. Both kinds can appear in
 * the wild with junk whitespace/CDATA around the loc text, so the parser is a
 * tolerant regex pass rather than a full XML parse — sitemaps are flat enough
 * that this is robust in practice (and this module already parses HTML the
 * same way).
 */
export function parseSitemapLocs(xml: string): { pageUrls: string[]; childSitemaps: string[] } {
  const pageUrls: string[] = [];
  const childSitemaps: string[] = [];
  const blockRegex = /<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml))) {
    const kind = match[1].toLowerCase();
    const locMatch = /<loc\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i.exec(match[2]);
    const loc = locMatch?.[1]?.trim();
    if (!loc) continue;
    if (kind === "sitemap") childSitemaps.push(loc);
    else pageUrls.push(loc);
  }
  return { pageUrls, childSitemaps };
}

/**
 * Discover same-origin page URLs from `/sitemap.xml`, following one level of
 * sitemap-index nesting (Wix/Squarespace publish an index pointing at
 * pages/blog child sitemaps). Best-effort: any fetch or parse failure returns
 * what was collected so far — the crawl then proceeds on link discovery alone.
 */
async function discoverSitemapUrls(
  baseUrl: URL,
  fetchImpl: FetchImpl,
  lookup: DnsLookup,
  maxUrls: number
): Promise<string[]> {
  const collected: string[] = [];
  const seen = new Set<string>();

  const fetchSitemap = async (url: string): Promise<{ pageUrls: string[]; childSitemaps: string[] } | null> => {
    try {
      const { body } = await fetchWithLimit(
        url,
        fetchImpl,
        WEBSITE_INGEST_PAGE_TIMEOUT_MS,
        WEBSITE_INGEST_SITEMAP_MAX_BYTES,
        lookup,
        // Sitemaps ship as application/xml or text/xml; some hosts mislabel
        // them text/plain. HTML is excluded so a soft-404 page doesn't get
        // parsed as a sitemap.
        /application\/xml|text\/xml|text\/plain/i
      );
      return parseSitemapLocs(body);
    } catch (err) {
      logger.info("website-ingest: sitemap fetch failed (continuing without it)", {
        url,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  };

  const addPages = (pageUrls: string[]) => {
    for (const loc of pageUrls) {
      if (collected.length >= maxUrls) return;
      const normalized = normalizeCrawlableUrl(loc, baseUrl);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      collected.push(normalized);
    }
  };

  const root = await fetchSitemap(new URL("/sitemap.xml", baseUrl.origin).toString());
  if (!root) return collected;
  addPages(root.pageUrls);

  // One nesting level: fetch child sitemaps listed by a sitemap index. Child
  // URLs are same-origin-filtered so an index can't point the crawler at a
  // third-party host.
  const children = root.childSitemaps
    .map((loc) => {
      try {
        const resolved = new URL(loc, baseUrl);
        return resolved.origin === baseUrl.origin ? resolved.toString() : null;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => Boolean(u))
    .slice(0, WEBSITE_INGEST_SITEMAP_MAX_CHILDREN);

  for (const child of children) {
    if (collected.length >= maxUrls) break;
    const parsed = await fetchSitemap(child);
    if (parsed) addPages(parsed.pageUrls);
  }

  return collected;
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
  lookup: DnsLookup,
  contentTypePattern: RegExp = /text\/html|application\/xhtml\+xml|text\/plain/i
): Promise<{ body: string; contentType: string; finalUrl: string; bytes: number }> {
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
    if (!contentTypePattern.test(contentType)) {
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
    // `total` is the true number of bytes pulled off the wire (or buffered from
    // arrayBuffer in the no-stream fallback). We return it alongside the decoded
    // string because callers that report `bytesDownloaded` need real byte counts
    // — `body.length` is a UTF-16 code-unit count and under-reports non-ASCII
    // payloads by up to 4x.
    return { body, contentType, finalUrl: response.url || currentUrl.toString(), bytes: total };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect a bot-challenge / WAF-block page masquerading as content. Jina's
 * Reader returns HTTP 200 even when the *target* site answered with a
 * Cloudflare challenge — the markdown body then carries explicit markers:
 * a `Warning: Target URL returned error NNN` metadata line and/or a
 * challenge-page `Title:` ("Just a moment...", "Attention Required! |
 * Cloudflare", …). Without this check the fallback "succeeded" and we
 * summarized the challenge page into website.md — a garbage summary that
 * looked like a clean crawl to the owner.
 *
 * Only the head of the body is inspected: every marker Jina/Cloudflare emits
 * sits in the metadata preamble or above-the-fold copy, and scanning the
 * whole corpus would risk false positives on sites that merely *write about*
 * bot protection.
 */
export function looksLikeWafChallenge(text: string): boolean {
  const head = text.slice(0, 2000);
  if (/^Warning:\s*Target URL returned error\s+\d+/im.test(head)) return true;
  const title = /^Title:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? "";
  if (
    /^(just a moment|attention required|access denied|security check|verifying you are human|please wait)/i.test(
      title
    )
  ) {
    return true;
  }
  return /enable javascript and cookies to continue|checking your browser before accessing|verify you are human by completing/i.test(
    head
  );
}

/** Jina Reader endpoint: GET `https://r.jina.ai/<absolute url>` → readable markdown. */
export const JINA_READER_BASE = "https://r.jina.ai/";
/**
 * Reader fetches go through a server-side browser pool, so they're slower than
 * a raw fetch. Give them a generous standalone budget (the per-page 5s cap is
 * far too tight) — the route's `maxDuration` (300s) comfortably covers it.
 */
export const WEBSITE_INGEST_READER_TIMEOUT_MS = 25_000;

/**
 * Fetch a WAF-blocked page via the Jina Reader proxy. Returns the readable
 * markdown body (already extracted by Jina, so callers should NOT run it back
 * through {@link extractReadableText}). Throws on non-2xx or transport errors;
 * the caller treats any failure as "fallback unavailable" and keeps the
 * original crawl error.
 *
 * The embedded target URL has already passed `assertSafeHostname` upstream, so
 * we are not widening the SSRF surface — the only new outbound host is the
 * fixed, public `r.jina.ai`.
 */
async function fetchViaJinaReader(
  targetUrl: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  maxBytes: number
): Promise<{ text: string; bytes: number }> {
  const controller = new AbortController();
  /* c8 ignore next -- timer only fires on a real Jina hang; covered indirectly. */
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // URL-encode the target so its own query string / reserved chars aren't
    // parsed as part of the r.jina.ai request URL. normalizeWebsiteUrl keeps
    // query params, and an unencoded `?` would otherwise be swallowed as the
    // reader's query, fetching the wrong page. Jina decodes the encoded form.
    const readerUrl = `${JINA_READER_BASE}${encodeURIComponent(targetUrl)}`;
    const apiKey = process.env.JINA_API_KEY?.trim();
    const headers: Record<string, string> = {
      accept: "text/plain",
      // Ask Jina for markdown explicitly; default is already markdown-ish but
      // pinning the format keeps the corpus stable across Jina changes.
      "x-return-format": "markdown"
    };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const res = await fetchImpl(readerUrl, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`reader_status_${res.status}`);

    const buffer = await res.arrayBuffer();
    const capped = new Uint8Array(buffer).slice(0, maxBytes);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(capped);
    return { text, bytes: Math.min(buffer.byteLength, maxBytes) };
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

const WEBSITE_INGEST_SUMMARY_SYSTEM_PROMPT =
  "You compress small-business websites into concise, accurate markdown briefings.";

function remapGeminiEmptyToSummarizerEmpty(err: unknown): never {
  if (err instanceof Error && err.message === "gemini_empty") {
    throw new Error("summarizer_empty");
  }
  throw err;
}

async function defaultGeminiSummarize(
  prompt: string,
  meterBusinessId?: string
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("summarizer_unavailable");
  const resolvedModel = resolveWebsiteSummaryGeminiModel();

  const generateWithDeadline = async (model: string) => {
    const controller = new AbortController();
    /* c8 ignore next -- the 20s timer only fires when Gemini actually hangs;
       AbortError classification is covered by classifyGeminiError tests. */
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const { text, usage } = await geminiGenerateTextDetailed({
        apiKey,
        model,
        systemInstruction: WEBSITE_INGEST_SUMMARY_SYSTEM_PROMPT,
        userText: prompt,
        temperature: 0.2,
        // Gemini 3.x hidden thinking counts against maxOutputTokens. At this
        // 1500 cap with default (dynamic-high) thinking, gemini-3.5-flash —
        // reachable here via GEMINI_ROWBOAT_MODEL, which resolveWebsiteSummary
        // GeminiModel passes through (only 1.x/3.1-era ids are coerced) —
        // spent 1126 tokens thinking and truncated the summary at MAX_TOKENS
        // (probed 2026-07-16). `minimal` hands the whole budget to the
        // summary (probe: STOP, 0 thought tokens, fuller output, fastest) —
        // a structured summarization needs no chain-of-thought. Same guard
        // pattern as knowledge-tools (#658); 2.5-era models reject the field.
        maxOutputTokens: 1500,
        ...(/^gemini-3/i.test(model) ? { thinkingLevel: "minimal" as const } : {}),
        signal: controller.signal
      });
      if (meterBusinessId) {
        await meterGeminiSpendForBusiness({
          businessId: meterBusinessId,
          model,
          surface: "website_ingest",
          usage,
          inputChars: WEBSITE_INGEST_SUMMARY_SYSTEM_PROMPT.length + prompt.length,
          outputChars: text.length
        });
      }
      return text;
    } catch (err) {
      // Empty replies (e.g. thinking-only output) are still billed by
      // Google — meter them before the error is remapped upstream.
      if (err instanceof GeminiEmptyError && meterBusinessId) {
        await meterGeminiSpendForBusiness({
          businessId: meterBusinessId,
          model,
          surface: "website_ingest",
          usage: err.usage,
          inputChars: WEBSITE_INGEST_SUMMARY_SYSTEM_PROMPT.length + prompt.length,
          outputChars: 0
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await generateWithDeadline(resolvedModel);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    if (
      /^gemini_http_404(?::|$)/.test(detail) &&
      resolvedModel.trim() !== WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT
    ) {
      try {
        return await generateWithDeadline(WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT);
      } catch (errFallback) {
        remapGeminiEmptyToSummarizerEmpty(errFallback);
      }
    }
    remapGeminiEmptyToSummarizerEmpty(err);
  }
}

/**
 * Connectivity check against the same `:generateContent` route used by website
 * ingest. Unit-tested with mocked `fetch`; optional live run: `npm run test:gemini-live`.
 */
export async function smokeTestGeminiSummarizeConnectivity(): Promise<string> {
  return defaultGeminiSummarize(
    "You are a connectivity check only. Respond with exactly the single line: OK_GEMINI_SMOKE"
  );
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
  const maxPages = Math.max(
    1,
    Math.min(options.maxPages ?? WEBSITE_INGEST_MAX_PAGES, WEBSITE_INGEST_DEEP_MAX_PAGES)
  );

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

  // Owner-consented contexts (onboarding) skip robots entirely; see
  // the JSDoc on `WebsiteIngestOptions.ignoreRobots`. We log an
  // explicit audit marker so the bypass is greppable in production
  // logs — robots.txt expresses a third-party-crawler preference, not
  // a first-party-agent prohibition, but the bypass is still worth
  // recording so we have an audit trail per-URL.
  let disallows: string[] = [];
  if (options.ignoreRobots) {
    logger.info("website-ingest: skipping robots.txt (owner-consented bypass)", {
      url: normalized
    });
  } else {
    const robots = await fetchRobots(parsed.origin, fetchImpl, WEBSITE_INGEST_PAGE_TIMEOUT_MS, lookup);
    disallows = parseRobotsDisallows(robots);
    // WHATWG URL always exposes `pathname` as a non-empty string ("/" at the
    // minimum). The `|| "/"` guard is defensive against hypothetical polyfills
    // and is unreachable in the Node runtime we ship on.
    /* c8 ignore next */
    if (!isPathAllowed(parsed.pathname || "/", disallows)) {
      return { ok: false, error: "blocked_by_robots" };
    }
  }

  const visited = new Set<string>();
  const pages: Array<{ url: string; text: string }> = [];
  let bytesDownloaded = 0;
  // Capture the homepage failure so we can surface it as the user-visible
  // `detail` when EVERY page fails. Without this, owners whose site is
  // fronted by Cloudflare bot mitigation (which returns a 403 challenge to
  // any non-browser client) saw the generic "We couldn't reach any pages"
  // copy and had no idea their CDN was actively blocking us — they
  // concluded the platform was broken when in fact the site itself needed
  // a config tweak.
  let homepageErrorDetail: string | null = null;

  const crawlDeadlineAt = Date.now() + (options.crawlDeadlineMs ?? WEBSITE_INGEST_CRAWL_DEADLINE_MS);
  const maxTotalBytes = options.maxTotalBytes ?? WEBSITE_INGEST_MAX_TOTAL_BYTES;
  const onProgress = options.onProgress;
  let fetchedCount = 0;
  const queue: string[] = [];
  // The crawl budget counts fetch ATTEMPTS (every URL dequeued), not just
  // pages that yielded text. Budgeting on `pages.length` would let a site of
  // textless pages (or one that link-expands faster than it produces text)
  // keep fetching far past maxPages until the deadline/byte budget tripped.
  let attempted = 0;

  /** Queue a candidate URL unless it's already seen or the fetch budget is spoken for. */
  const enqueue = (url: string) => {
    if (queue.length + attempted >= maxPages) return;
    if (visited.has(url) || queue.includes(url)) return;
    queue.push(url);
  };

  /**
   * Fetch + extract one page. Returns null when the page yielded nothing
   * (failed fetch, robots-disallowed path, or no readable text); link
   * expansion into `queue` happens back on the caller so wave ordering
   * stays deterministic.
   */
  const crawlPage = async (
    next: string
  ): Promise<{ url: string; text: string; links: string[] } | null> => {
    const isHomepage = next === normalized;
    try {
      const nextUrl = new URL(next);
      // WHATWG URL always exposes `pathname` as non-empty; `|| "/"` is
      // defensive against hypothetical polyfills.
      /* c8 ignore next */
      if (!isPathAllowed(nextUrl.pathname || "/", disallows)) return null;
      const { body, finalUrl, bytes } = await fetchWithLimit(
        next,
        fetchImpl,
        WEBSITE_INGEST_PAGE_TIMEOUT_MS,
        WEBSITE_INGEST_MAX_BYTES_PER_PAGE,
        lookup
      );
      bytesDownloaded += bytes;
      fetchedCount += 1;
      onProgress?.({ type: "page_fetched", url: next, bytes, index: fetchedCount });
      const text = extractReadableText(body);
      // Extract links even when `text` is empty — JS-heavy pages often
      // render their copy through linked subpages, and keying off text
      // presence would silently drop those sites with `fetch_failed`.
      // Best-effort: a malformed `response.url` (finalUrl) must not throw
      // away a page whose content was already fetched successfully.
      let links: string[] = [];
      try {
        links = extractSameOriginLinks(body, new URL(finalUrl));
      } catch {
        links = [];
      }
      return { url: finalUrl, text, links };
    } catch (err) {
      // `fetchWithLimit` / assertSafeHostname always reject with `Error`
      // instances; the `String(err)` branch is a safety net for a hypothetical
      // non-Error throw and is unreachable on our stack.
      /* v8 ignore next */
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn("website-ingest: fetch failed", { url: next, error: errorMessage });
      onProgress?.({ type: "page_failed", url: next });
      // Only capture the homepage failure as the user-visible `detail`. A
      // failed sub-page is uninteresting noise — the homepage outcome is
      // what determines whether the crawl as a whole had any chance of
      // success, and surfacing a sub-page error would be actively
      // misleading.
      if (isHomepage) homepageErrorDetail = humanizeFetchError(errorMessage);
      return null;
    }
  };

  // The homepage is fetched alone (not in a wave): its result decides the
  // user-visible failure detail.
  visited.add(normalized);
  attempted += 1;
  const homepage = await crawlPage(normalized);

  // Sitemap URLs are seeded BEFORE homepage links: the sitemap is the
  // authoritative full-site map (blog posts, deep pages the nav never
  // links), while a nav-heavy homepage can carry enough links to fill the
  // whole fetch budget by itself and starve sitemap-only pages out of the
  // queue. Homepage links backfill whatever budget the sitemap left.
  if (options.sitemapDiscovery) {
    const sitemapUrls = await discoverSitemapUrls(parsed, fetchImpl, lookup, maxPages);
    if (sitemapUrls.length > 0) {
      logger.info("website-ingest: sitemap discovery", {
        url: normalized,
        discovered: sitemapUrls.length
      });
      onProgress?.({ type: "sitemap_found", count: sitemapUrls.length });
    }
    for (const url of sitemapUrls) enqueue(url);
  }

  if (homepage) {
    if (homepage.text.trim()) pages.push({ url: homepage.url, text: homepage.text });
    for (const link of homepage.links) enqueue(link);
  }

  while (
    queue.length > 0 &&
    attempted < maxPages &&
    Date.now() < crawlDeadlineAt &&
    bytesDownloaded < maxTotalBytes
  ) {
    // Batch size is capped at the remaining fetch budget, so a wave can never
    // push total attempts past maxPages even when every fetch in it succeeds.
    const batch = queue.splice(0, Math.min(WEBSITE_INGEST_CRAWL_CONCURRENCY, maxPages - attempted));
    attempted += batch.length;
    for (const url of batch) visited.add(url);
    const results = await Promise.all(batch.map((url) => crawlPage(url)));
    for (const result of results) {
      if (!result) continue;
      if (result.text.trim()) {
        pages.push({ url: result.url, text: result.text });
      }
      // BFS: expand links from every crawled page (not just the homepage) so
      // deep crawls can walk blog indexes and nav trees the homepage never
      // links to directly.
      for (const link of result.links) enqueue(link);
    }
  }

  // Judge signal on the RICHEST single page, not the summed corpus: a deep
  // crawl of a JS-rendered SPA yields many shell pages whose only text is
  // each page's <title>; enough of them sum past any corpus-wide floor while
  // still carrying zero real content.
  const richestPageChars = pages.reduce((max, page) => Math.max(max, page.text.length), 0);
  if (richestPageChars < WEBSITE_INGEST_MIN_CORPUS_CHARS && options.readerFallback) {
    // The direct crawl recovered nothing usable. Either every fetch failed
    // (almost always Cloudflare or a similar WAF returning a 403
    // JS-challenge to our non-browser fetch), or the pages "succeeded" but
    // carried no readable text — the JS-rendered-SPA case, where the server
    // returns an HTML shell (<div id="root">) whose only text is the
    // <title>. Header/UA/TLS spoofing can't clear a challenge and a raw
    // fetch can't run React, but the Jina Reader proxy runs a real browser
    // server-side and returns clean markdown. This is the light alternative
    // to a per-VPS headless browser.
    try {
      const { text, bytes } = await fetchViaJinaReader(
        normalized,
        fetchImpl,
        WEBSITE_INGEST_READER_TIMEOUT_MS,
        WEBSITE_INGEST_MAX_BYTES_PER_PAGE
      );
      const cleaned = text.trim();
      if (cleaned.length > 0 && looksLikeWafChallenge(cleaned)) {
        // Jina answered 200 but the body is the WAF's challenge page, not the
        // site. Summarizing it would persist garbage AND hide the real
        // failure — keep the honest homepage error (403 + paste-source hint)
        // instead.
        logger.warn("website-ingest: reader fallback returned a WAF challenge page; rejecting", {
          url: normalized
        });
      } else if (cleaned.length > 0) {
        bytesDownloaded += bytes;
        fetchedCount += 1;
        onProgress?.({ type: "page_fetched", url: normalized, bytes, index: fetchedCount });
        // Jina already returns extracted markdown — do NOT re-run
        // extractReadableText (it's an HTML stripper and would mangle
        // markdown links / headings). Feed it straight to the summarizer.
        // Any low-signal shell pages the direct crawl produced (e.g. a
        // 41-char SPA <title>) are dropped — the rendered markdown
        // supersedes them.
        pages.length = 0;
        pages.push({ url: normalized, text: cleaned });
        logger.info("website-ingest: recovered via Jina reader fallback", {
          url: normalized,
          chars: cleaned.length
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("website-ingest: reader fallback failed", {
        url: normalized,
        error: message
      });
    }
  }

  if (pages.length === 0) {
    // Surface the homepage failure so owners can act on it (e.g. allow our
    // crawler past their CDN). When `detail` is set, the dashboard's
    // `websiteIngestErrorMessage` helper prefers it over the canned copy.
    return homepageErrorDetail
      ? { ok: false, error: "fetch_failed", detail: homepageErrorDetail }
      : { ok: false, error: "fetch_failed" };
  }

  // Same per-page gate on the final result: without it, a titles-only crawl
  // would "succeed" with a garbage summary whenever the reader fallback is
  // unavailable (disabled, down, or itself blocked). When the homepage
  // itself failed with an actionable error (CDN/WAF 403 etc.), that detail
  // is the real story — a few low-signal shells recovered from sitemap
  // subpages must not mask it behind a generic empty_content.
  const finalRichestPageChars = pages.reduce((max, page) => Math.max(max, page.text.length), 0);
  if (finalRichestPageChars < WEBSITE_INGEST_MIN_CORPUS_CHARS) {
    return homepageErrorDetail
      ? { ok: false, error: "fetch_failed", detail: homepageErrorDetail }
      : { ok: false, error: "empty_content" };
  }

  // Per-page budget: a lone page (or Jina fallback) can use the whole
  // combined window, while a deep crawl gives every page a fair floor so a
  // single bloated page can't crowd the rest out of the summarizer prompt.
  const perPageChars = Math.max(
    WEBSITE_INGEST_MAX_CHARS_PER_PAGE,
    Math.floor(WEBSITE_INGEST_MAX_COMBINED_CHARS / pages.length)
  );
  const combined = pages
    .map((p) => `### ${p.url}\n${p.text.slice(0, perPageChars)}`)
    .join("\n\n")
    .slice(0, WEBSITE_INGEST_MAX_COMBINED_CHARS);

  onProgress?.({ type: "summarizing", pages: pages.length });
  const summarized = await summarizeCorpusToWebsiteMd({
    url: normalized,
    corpus: combined,
    businessName: options.businessName,
    businessType: options.businessType,
    summarize,
    meterBusinessId: options.meterBusinessId
  });
  if (!summarized.ok) return summarized;

  return {
    ok: true,
    websiteMd: summarized.websiteMd,
    pagesCrawled: pages.length,
    bytesDownloaded,
    finalUrl: pages[0].url,
    pages: pages.map((p) => ({ url: p.url, chars: p.text.length }))
  };
}

/**
 * Shared tail of both ingest paths: minimum-signal check → Gemini summary →
 * website.md assembly. Splitting it out keeps the crawl path and the
 * pasted-source path byte-identical in their output format and error
 * mapping, so the dashboard renders both through the same copy.
 */
async function summarizeCorpusToWebsiteMd(args: {
  url: string;
  corpus: string;
  businessName?: string;
  businessType?: string;
  summarize: GeminiSummarizer;
  meterBusinessId?: string;
}): Promise<{ ok: true; websiteMd: string } | WebsiteIngestFailure> {
  if (args.corpus.trim().length < WEBSITE_INGEST_MIN_CORPUS_CHARS) {
    return { ok: false, error: "empty_content" };
  }

  const prompt = buildSummarizationPrompt({
    url: args.url,
    businessName: args.businessName,
    businessType: args.businessType,
    corpus: args.corpus
  });

  let summary: string;
  try {
    summary = await args.summarize(prompt, args.meterBusinessId);
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
    `Source: ${args.url}`,
    `Ingested: ${new Date().toISOString()}`,
    "",
    trimmedSummary
  ].join("\n");

  return { ok: true, websiteMd };
}

/**
 * Hard cap on owner-pasted page source. Generous (real homepages are
 * usually < 500 KB of HTML) but bounded so a misbehaving client can't make
 * the route buffer tens of megabytes. The route ALSO enforces this via zod;
 * the slice here is defense-in-depth for non-route callers.
 */
export const WEBSITE_INGEST_MAX_PASTED_HTML_CHARS = 2_000_000;

/**
 * Build website.md from owner-pasted page source instead of a crawl.
 *
 * This is the manual escape hatch for WAF-blocked sites: when Cloudflare
 * (or similar) serves a JS challenge to every non-browser client, no
 * server-side fetch — direct, header-spoofed, or proxied through a
 * browser-pool reader — can see the real page. The owner's browser already
 * can, so we ask them to right-click → View Page Source and paste it. The
 * HTML runs through the exact same extraction + summarization pipeline as
 * a crawled page, so the resulting website.md is indistinguishable from a
 * successful crawl.
 *
 * No SSRF surface: nothing is fetched. The URL is only normalized for the
 * `Source:` header and the summarizer prompt.
 */
export async function ingestWebsiteFromHtml(
  rawUrl: string,
  html: string,
  options: Pick<
    WebsiteIngestOptions,
    "summarize" | "businessName" | "businessType" | "meterBusinessId"
  > = {}
): Promise<WebsiteIngestResult> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) return { ok: false, error: "invalid_url" };
  const summarize = options.summarize ?? defaultGeminiSummarize;

  const clipped =
    html.length > WEBSITE_INGEST_MAX_PASTED_HTML_CHARS
      ? html.slice(0, WEBSITE_INGEST_MAX_PASTED_HTML_CHARS)
      : html;
  const text = extractReadableText(clipped);
  const corpus = `### ${normalized}\n${text}`.slice(0, WEBSITE_INGEST_MAX_COMBINED_CHARS);

  const summarized = await summarizeCorpusToWebsiteMd({
    url: normalized,
    corpus,
    businessName: options.businessName,
    businessType: options.businessType,
    summarize,
    meterBusinessId: options.meterBusinessId
  });
  if (!summarized.ok) return summarized;

  return {
    ok: true,
    websiteMd: summarized.websiteMd,
    pagesCrawled: 1,
    bytesDownloaded: Buffer.byteLength(clipped, "utf8"),
    finalUrl: normalized,
    pages: [{ url: normalized, chars: text.length }]
  };
}
