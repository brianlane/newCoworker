/**
 * User-facing copy for `WebsiteIngestError` codes returned by
 * `/api/onboard/website-ingest`.
 *
 * The dashboard (and any other surface that re-runs the crawl) used to dump
 * raw enum values like `fetch_failed` / `blocked_by_robots` into the UI when
 * the server set `inner.ok === false` without a `detail` string. This maps
 * each code to a sentence an owner can actually act on.
 *
 * `detail` — when the server sends one — always wins. It's already a
 * human-readable string produced by the ingestion pipeline (for example
 * Gemini's error message). The canned copy below is only used when `detail`
 * is null/empty.
 */

import type { WebsiteIngestError } from "@/lib/website-ingest";

export const WEBSITE_INGEST_ERROR_COPY: Record<WebsiteIngestError, string> = {
  invalid_url: "That URL does not look right. Double-check the address and try again.",
  private_address: "That address points to a private network, so we can't crawl it.",
  dns_failure: "We couldn't resolve that domain. Check the spelling and try again.",
  blocked_by_robots:
    "The site's robots.txt blocks crawlers. Update robots.txt or enter the summary manually.",
  fetch_failed:
    "We couldn't reach any pages on that site. Check the URL, SSL, or firewall and retry.",
  empty_content:
    "We reached the site but couldn't extract enough text. Try a different landing page.",
  summarizer_unavailable: "Our summarizer is offline. Try again in a minute.",
  summarizer_failed:
    "The summarizer ran but didn't produce a usable result. Try again in a minute."
};

export function websiteIngestErrorMessage(
  error: string | undefined | null,
  detail: string | null | undefined
): string {
  if (detail && detail.trim()) return detail.trim();
  if (error && error in WEBSITE_INGEST_ERROR_COPY) {
    return WEBSITE_INGEST_ERROR_COPY[error as WebsiteIngestError];
  }
  return "Re-crawl could not find public pages.";
}
