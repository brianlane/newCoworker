/**
 * Website SEO insights — BizBlasts' Seo::AnalysisService scoring rubric
 * ported to newCoworker's world: we don't HOST the tenant's website, we
 * audit the site they already have (the same site the onboarding ingest
 * crawls). One SSRF-guarded homepage fetch → deterministic factor scores →
 * rule-based suggestions, plus optional AI-written recommendations layered
 * on top (best-effort; the report never depends on the model).
 *
 * Honest scope: heuristic on-page/local signals only — no live Google
 * ranking data (that would require Search Console OAuth, deliberately
 * deferred). The card copy must not oversell this.
 */

import {
  assertSafeHostname,
  extractReadableText,
  extractSameOriginLinks,
  normalizeWebsiteUrl
} from "@/lib/website-ingest";
import { logger } from "@/lib/logger";

export const SEO_FETCH_TIMEOUT_MS = 10_000;
export const SEO_MAX_BYTES = 1_000_000;
export const SEO_MAX_REDIRECTS = 3;

/** Factor weights, ported from BizBlasts' SCORE_WEIGHTS (linking folded in). */
export const SEO_SCORE_WEIGHTS = {
  title: 15,
  description: 10,
  content: 15,
  localSeo: 20,
  technical: 15,
  images: 10,
  linking: 5,
  mobile: 10
} as const;

export type SeoFactor = keyof typeof SEO_SCORE_WEIGHTS;

/**
 * Industry keyword templates (ported set, keyed by a loose business-type
 * match). Used for the keyword-presence signal only — no rank estimation.
 */
export const INDUSTRY_KEYWORDS: Array<{ match: RegExp; keywords: string[] }> = [
  // Word-boundary anchored so substrings can't cross-match ("student" must
  // not pick dentist keywords, "repair" must not read as "air", "carpet"
  // is not "car").
  { match: /\bhair\b|\bsalon\b|\bbarber/i, keywords: ["haircut", "hair styling", "hair color", "salon"] },
  { match: /\bmassage\b|\bspa\b|\bwellness\b/i, keywords: ["massage", "relaxation", "spa", "wellness"] },
  { match: /\bauto\b|\bmechanic\b|\bcar\b/i, keywords: ["auto repair", "mechanic", "brake repair", "oil change"] },
  { match: /\bdent(al|ist)?\b/i, keywords: ["dentist", "dental care", "teeth cleaning"] },
  { match: /\blandscap|\blawn\b|\bgarden/i, keywords: ["landscaping", "lawn care", "yard maintenance"] },
  { match: /\bclean(ing|er|ers)?\b/i, keywords: ["cleaning service", "house cleaning", "deep cleaning"] },
  { match: /\bfitness\b|\btrainer?\b|\btraining\b|\bgym\b/i, keywords: ["personal trainer", "fitness", "workout"] },
  { match: /\bphoto/i, keywords: ["photographer", "photography", "portrait"] },
  { match: /\bplumb/i, keywords: ["plumber", "plumbing", "drain cleaning", "pipe repair"] },
  {
    match: /\bhvac\b|\bheating\b|\bcooling\b|\bair\s*condition/i,
    keywords: ["hvac", "air conditioning", "heating", "ac repair"]
  }
];

export function industryKeywordsFor(businessType: string | null | undefined): string[] {
  const type = (businessType ?? "").trim();
  if (!type) return [];
  for (const entry of INDUSTRY_KEYWORDS) {
    if (entry.match.test(type)) return entry.keywords;
  }
  return [];
}

export type SeoSignals = {
  https: boolean;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  imageCount: number;
  imagesWithAlt: number;
  wordCount: number;
  hasViewport: boolean;
  hasLangAttribute: boolean;
  sameOriginLinks: number;
  hasPhone: boolean;
  hasAddressHint: boolean;
  keywordHits: string[];
};

function firstMatch(html: string, re: RegExp): string | null {
  const m = html.match(re);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

/** Deterministic on-page signal extraction from raw homepage HTML. */
export function extractSeoSignals(
  html: string,
  finalUrl: string,
  industryKeywords: string[]
): SeoSignals {
  const text = extractReadableText(html);
  const lowerText = text.toLowerCase();

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const imagesWithAlt = images.filter((tag) => /\balt\s*=\s*("[^"]+"|'[^']+')/i.test(tag)).length;

  const url = new URL(finalUrl);
  return {
    https: url.protocol === "https:",
    title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription: firstMatch(
      html,
      /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i
    ) ?? firstMatch(html, /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i),
    h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
    imageCount: images.length,
    imagesWithAlt,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasLangAttribute: /<html[^>]+lang=/i.test(html),
    sameOriginLinks: extractSameOriginLinks(html, url).length,
    hasPhone: /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text),
    hasAddressHint:
      /\b\d{1,5}\s+[A-Za-z][A-Za-z .]+\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|suite|ste)\b/i.test(
        text
      ),
    keywordHits: industryKeywords.filter((k) => lowerText.includes(k.toLowerCase()))
  };
}

export type SeoScoreBreakdown = Record<SeoFactor, number>;

/** 0-100 per factor, weights applied by overallSeoScore. */
export function scoreSeoSignals(signals: SeoSignals): SeoScoreBreakdown {
  const titleLen = signals.title?.length ?? 0;
  const descLen = signals.metaDescription?.length ?? 0;
  return {
    title: signals.title ? 50 + (titleLen >= 20 && titleLen <= 65 ? 50 : 20) : 0,
    description: signals.metaDescription ? 60 + (descLen >= 50 && descLen <= 165 ? 40 : 10) : 0,
    content: Math.min(100, Math.round((signals.wordCount / 300) * 100)),
    localSeo:
      (signals.hasPhone ? 40 : 0) +
      (signals.hasAddressHint ? 30 : 0) +
      (signals.keywordHits.length > 0 ? 30 : 0),
    technical:
      (signals.https ? 50 : 0) +
      (signals.hasLangAttribute ? 25 : 0) +
      (signals.h1Count === 1 ? 25 : signals.h1Count > 1 ? 10 : 0),
    images:
      signals.imageCount === 0
        ? 100
        : Math.round((signals.imagesWithAlt / signals.imageCount) * 100),
    linking: Math.min(100, signals.sameOriginLinks * 20),
    mobile: signals.hasViewport ? 100 : 0
  };
}

/** Weighted 0-100 overall score (BizBlasts calculate_overall_score). */
export function overallSeoScore(breakdown: SeoScoreBreakdown): number {
  let sum = 0;
  for (const factor of Object.keys(SEO_SCORE_WEIGHTS) as SeoFactor[]) {
    sum += (breakdown[factor] * SEO_SCORE_WEIGHTS[factor]) / 100;
  }
  return Math.round(sum);
}

/** Deterministic, prioritized fixes (BizBlasts generate_suggestions port). */
export function ruleBasedSuggestions(signals: SeoSignals): string[] {
  const suggestions: string[] = [];
  if (!signals.title) {
    suggestions.push("Add a <title> tag — it is the single strongest on-page signal.");
  } else if (signals.title.length > 65 || signals.title.length < 20) {
    suggestions.push("Rewrite the page title to 20–65 characters (what searchers see).");
  }
  if (!signals.metaDescription) {
    suggestions.push("Add a meta description (50–165 characters) — it becomes your search snippet.");
  }
  if (!signals.hasPhone) {
    suggestions.push("Show your phone number in the page text — core local-SEO (NAP) signal.");
  }
  if (!signals.hasAddressHint) {
    suggestions.push("Show your street address (or service area) on the homepage.");
  }
  if (signals.keywordHits.length === 0) {
    suggestions.push("Mention the services people actually search for in your homepage copy.");
  }
  if (signals.wordCount < 300) {
    suggestions.push("Add more descriptive text — thin pages (under ~300 words) rank poorly.");
  }
  if (!signals.hasViewport) {
    suggestions.push('Add <meta name="viewport"> — Google indexes the mobile experience first.');
  }
  if (!signals.https) {
    suggestions.push("Serve the site over HTTPS — browsers and Google both penalize plain HTTP.");
  }
  if (signals.imageCount > 0 && signals.imagesWithAlt < signals.imageCount) {
    suggestions.push("Add alt text to images — accessibility plus image-search visibility.");
  }
  if (signals.h1Count !== 1) {
    suggestions.push(
      signals.h1Count === 0
        ? "Add exactly one <h1> heading naming your main service and area."
        : "Use exactly one <h1> heading; demote the extras to <h2>."
    );
  }
  return suggestions;
}

export type SeoReport = {
  url: string;
  analyzedAt: string;
  overall: number;
  breakdown: SeoScoreBreakdown;
  signals: SeoSignals;
  suggestions: string[];
  /** Model-written prioritized advice; empty when the model was unavailable. */
  aiRecommendations: string[];
};

export type SeoAnalyzeFailure = {
  ok: false;
  error: "invalid_url" | "private_address" | "fetch_failed" | "empty_page";
  detail?: string;
};

export type SeoAnalyzeResult = { ok: true; report: SeoReport } | SeoAnalyzeFailure;

type DnsLookup = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

export type SeoAnalyzeOptions = {
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  /** AI advice generator; injected in tests, metered Gemini in the route. */
  generate?: (prompt: string) => Promise<string>;
  businessType?: string | null;
  now?: Date;
};

/**
 * Read at most SEO_MAX_BYTES of the body, cancelling the stream once the
 * cap is hit so a giant page never buffers fully (Bugbot: `.text()` +
 * slice capped the RESULT, not the download). Streamless responses (test
 * fakes, some polyfills) fall back to text() + slice.
 */
export async function readBodyBounded(res: Response): Promise<string> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== "function") {
    return (await res.text()).slice(0, SEO_MAX_BYTES);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  // Cap on RAW bytes received, not decoded string length — multibyte HTML
  // must not stretch the download budget.
  let bytesRead = 0;
  while (bytesRead < SEO_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    // Already-closed streams reject cancel; the bytes are read either way.
  }
  return out.slice(0, SEO_MAX_BYTES);
}

/**
 * Bounded, SSRF-guarded homepage fetch: DNS allowlist on every redirect hop
 * (same posture as the ingest crawler), manual redirects, byte cap enforced
 * while streaming.
 */
async function fetchHomepage(
  startUrl: string,
  fetchImpl: typeof fetch,
  lookup?: DnsLookup
): Promise<{ html: string; finalUrl: string } | SeoAnalyzeFailure> {
  let current = startUrl;
  for (let hop = 0; hop <= SEO_MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    try {
      // Throws Error("private_address") / Error("dns_failure") — the ingest
      // crawler contract, always an Error instance.
      await assertSafeHostname(parsed.hostname, lookup);
    } catch (err) {
      const message = (err as Error).message;
      return {
        ok: false,
        error: message === "dns_failure" ? "fetch_failed" : "private_address",
        detail: message
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEO_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "newcoworker-bot/1.0 (seo-insights)" }
      });
    } catch (err) {
      return {
        ok: false,
        error: "fetch_failed",
        detail: err instanceof Error ? err.message : String(err)
      };
    } finally {
      clearTimeout(timeout);
    }
    if (res.status >= 300 && res.status < 400) {
      // Drain/cancel the redirect body so chained hops don't pin
      // connections for the whole audit.
      try {
        await (res as { body?: { cancel?: () => Promise<void> } }).body?.cancel?.();
      } catch {
        // Best-effort; a stubborn body just gets GC'd.
      }
      const location = res.headers.get("location");
      if (!location || hop === SEO_MAX_REDIRECTS) {
        return { ok: false, error: "fetch_failed", detail: `redirect loop (${res.status})` };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, error: "fetch_failed", detail: "malformed redirect location" };
      }
      // Same scheme posture as the ingest crawler: a redirect onto a
      // non-web scheme (file:, gopher:, …) must not reach the next hop's
      // hostname check, let alone a fetch.
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { ok: false, error: "fetch_failed", detail: "non-http redirect" };
      }
      current = next.toString();
      continue;
    }
    if (!res.ok) {
      return { ok: false, error: "fetch_failed", detail: `status ${res.status}` };
    }
    // Belt-and-braces: if the runtime followed a redirect despite
    // redirect:"manual" (some fetch polyfills do), re-validate the host the
    // bytes actually came from before reading the body.
    const landedUrl = (res as { url?: string }).url || current;
    if (landedUrl !== current) {
      try {
        await assertSafeHostname(new URL(landedUrl).hostname, lookup);
      } catch (err) {
        return {
          ok: false,
          error: "private_address",
          detail: (err as Error).message
        };
      }
    }
    const html = await readBodyBounded(res);
    return { html, finalUrl: landedUrl };
  }
  /* c8 ignore next 2 -- unreachable: the loop always returns */
  return { ok: false, error: "fetch_failed", detail: "redirect loop" };
}

/** Parse the model's advice into clean bullet lines (max 5). */
export function parseAiRecommendations(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 10)
    .slice(0, 5);
}

/** Full audit: fetch → signals → scores → suggestions (+ best-effort AI). */
export async function analyzeWebsiteSeo(
  rawUrl: string,
  opts: SeoAnalyzeOptions = {}
): Promise<SeoAnalyzeResult> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) return { ok: false, error: "invalid_url" };

  const fetched = await fetchHomepage(normalized, opts.fetchImpl ?? fetch, opts.lookup);
  if ("ok" in fetched) return fetched;
  if (!fetched.html.trim()) return { ok: false, error: "empty_page" };

  const signals = extractSeoSignals(
    fetched.html,
    fetched.finalUrl,
    industryKeywordsFor(opts.businessType)
  );
  const breakdown = scoreSeoSignals(signals);
  const suggestions = ruleBasedSuggestions(signals);

  let aiRecommendations: string[] = [];
  if (opts.generate) {
    try {
      const prompt =
        "You are an SEO consultant for a small local business. Based on this " +
        "homepage audit, write the 3 most impactful improvements as short " +
        "imperative bullet points (one per line, no preamble).\n\n" +
        `Overall score: ${overallSeoScore(breakdown)}/100\n` +
        `Factor scores: ${JSON.stringify(breakdown)}\n` +
        `Signals: ${JSON.stringify({ ...signals, keywordHits: signals.keywordHits })}\n` +
        `Detected issues: ${suggestions.join(" | ") || "none"}`;
      aiRecommendations = parseAiRecommendations(await opts.generate(prompt));
    } catch (err) {
      logger.warn("seo-analyze: AI recommendations unavailable", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    ok: true,
    report: {
      url: fetched.finalUrl,
      analyzedAt: (opts.now ?? new Date()).toISOString(),
      overall: overallSeoScore(breakdown),
      breakdown,
      signals,
      suggestions,
      aiRecommendations
    }
  };
}
