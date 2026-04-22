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
 * - Safe: SSRF guard, robots.txt respect, hard timeouts, bounded bytes.
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
  | "unsupported_scheme"
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
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const decoded = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10000 ? String.fromCodePoint(n) : " ";
    });

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
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:") || href.toLowerCase().startsWith("mailto:") || href.toLowerCase().startsWith("tel:")) {
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

async function fetchWithLimit(
  url: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  maxBytes: number
): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: {
        "user-agent": "newcoworker-bot/1.0 (+https://newcoworker.ai)",
        accept: "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`status_${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new Error("non_html_content_type");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("payload_too_large");
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return { body, contentType, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRobots(
  origin: string,
  fetchImpl: FetchImpl,
  timeoutMs: number
): Promise<string> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const { body } = await fetchWithLimit(robotsUrl, fetchImpl, timeoutMs, 500_000);
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

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "unsupported_scheme" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? (dns.lookup as unknown as DnsLookup);
  const summarize = options.summarize ?? defaultGeminiSummarize;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? WEBSITE_INGEST_MAX_PAGES, 10));

  try {
    await assertSafeHostname(parsed.hostname, lookup);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const code: WebsiteIngestError = message === "dns_failure" ? "dns_failure" : "private_address";
    return { ok: false, error: code };
  }

  const robots = await fetchRobots(parsed.origin, fetchImpl, WEBSITE_INGEST_PAGE_TIMEOUT_MS);
  const disallows = parseRobotsDisallows(robots);
  if (!isPathAllowed(parsed.pathname || "/", disallows)) {
    return { ok: false, error: "blocked_by_robots" };
  }

  const visited = new Set<string>();
  const pages: Array<{ url: string; text: string }> = [];
  let bytesDownloaded = 0;

  const queue: string[] = [normalized];

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    try {
      const nextUrl = new URL(next);
      if (!isPathAllowed(nextUrl.pathname || "/", disallows)) continue;
      const { body, finalUrl } = await fetchWithLimit(
        next,
        fetchImpl,
        WEBSITE_INGEST_PAGE_TIMEOUT_MS,
        WEBSITE_INGEST_MAX_BYTES_PER_PAGE
      );
      bytesDownloaded += body.length;
      const text = extractReadableText(body);
      if (text.trim()) {
        pages.push({ url: finalUrl, text });
      }
      if (pages.length === 1) {
        // Only expand the queue from the homepage to keep "shallow" semantics.
        const links = extractSameOriginLinks(body, new URL(finalUrl));
        for (const link of links) {
          if (queue.length + pages.length >= maxPages) break;
          if (!visited.has(link)) queue.push(link);
        }
      }
    } catch (err) {
      logger.warn("website-ingest: fetch failed", {
        url: next,
        error: err instanceof Error ? err.message : String(err)
      });
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
