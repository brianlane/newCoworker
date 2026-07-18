/**
 * Tracked SMS short links (concept ported from BizBlasts' SmsLinkShortener).
 *
 * Outbound lead-facing texts rewrite long URLs — scheme-prefixed http(s)
 * ones AND bare-domain ones like "calendly.com/james/intro" — to
 * `<app>/s/<code>` redirects backed by the `sms_links` table, so link
 * engagement is
 * measurable per business / flow / run (the flow-funnel analytics read the
 * click counts). Shortening is strictly fail-safe: any insert error, missing
 * base URL, or URL that would not actually get shorter leaves the original
 * text untouched — a tracking problem must never block or corrupt a send.
 *
 * Dependency-free (caller injects the supabase client and, in tests, the
 * randomness source) so this is unit-tested from vitest under the shared
 * 100% coverage gate, and imported by BOTH the Deno ai-flow-worker and the
 * Node voice-tools route (same pattern as cap_alerts.ts).
 */

export const SHORT_CODE_LENGTH = 8;

// Exactly 32 symbols so a random byte maps to an index with a power-of-two
// mask (`byte & 31`) — uniform by construction, with no modulo bias on the
// CSPRNG output (CodeQL js/biased-cryptographic-random).
const SHORT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Postgres unique-violation SQLSTATE — short-code collision, retry. */
const UNIQUE_VIOLATION = "23505";

/** Attempts per URL before giving up and leaving it unshortened. */
const MAX_CODE_ATTEMPTS = 3;

type DbError = { message: string; code?: string } | null;

export interface ShortLinkSupabase {
  // PromiseLike (not Promise) so supabase-js's thenable builder satisfies
  // the interface structurally.
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: DbError }>;
    update(row: Record<string, unknown>): {
      in(column: string, values: string[]): PromiseLike<{ error: DbError }>;
    };
    delete(): {
      in(column: string, values: string[]): PromiseLike<{ error: DbError }>;
    };
  };
}

/** Injectable randomness for deterministic tests. */
export type RandomBytes = (length: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (length) =>
  crypto.getRandomValues(new Uint8Array(length));

export function generateShortCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    // Power-of-two mask over the 32-symbol alphabet: uniform, no modulo bias.
    code += SHORT_CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function shortLinkUrl(baseUrl: string, code: string): string {
  return `${trimBase(baseUrl)}/s/${code}`;
}

// Two alternatives, matched up to whitespace/angle-quote (trailing sentence
// punctuation is stripped below so "…see https://x.com/a." drops the period):
//   1. scheme-prefixed http(s) URLs;
//   2. bare-domain URLs the way owners actually type them into flow bodies
//      ("calendly.com/james/intro-call") — dotted labels ending in an
//      alphabetic TLD, then a REQUIRED "/path" (so plain "example.com" in
//      prose, filenames, and version numbers like "1.2.3" never match). The
//      lookbehind keeps it off email tails ("john@x.com/…"), the middle of
//      larger tokens, and hosts right after a scheme-ish "xyz:" prefix
//      (a malformed "https:x.com/a" must not get its host segment swapped).
const URL_RE =
  /https?:\/\/[^\s<>"']+|(?<![\w@.\/:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>"']+/gi;

/** Bare-domain matches get https:// so the stored redirect target is absolute. */
export function ensureUrlScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Whether a matched URL is one of our own /s/<code> redirects. Compared with
 * the scheme stripped and "www." optional on both sides, so a short link
 * quoted bare or at the apex domain ("newcoworker.com/s/…") is still
 * recognized and never re-shortened.
 */
function isOwnShortLink(url: string, base: string): boolean {
  const strip = (u: string) =>
    u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
  return strip(url).startsWith(`${strip(base)}/s/`);
}

/**
 * Trim sentence punctuation from a matched URL's tail without mutilating
 * URLs that legitimately end in ")": a closing paren is only stripped while
 * the URL holds more ")" than "(" — so "(see https://x.com/a)" loses the
 * wrapper paren but a Wikipedia-style ".../Foo_(bar)" keeps its own.
 */
export function trimTrailingUrlPunctuation(raw: string): string {
  let url = raw;
  for (;;) {
    if (/[.,!?;:\]]$/.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    if (url.endsWith(")")) {
      const opens = url.split("(").length - 1;
      const closes = url.split(")").length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/**
 * Distinct shortenable URLs in a message body, longest first.
 *
 * Longest-first matters for the replacement pass: when one URL is a prefix
 * of another ("https://x.com/a" inside "https://x.com/a/b"), replacing the
 * longer one first keeps the shorter replacement from corrupting it.
 *
 * Skipped: URLs already under our own /s/ prefix (never re-shorten, whether
 * typed with or without the scheme), and URLs short enough that the
 * replacement would not meaningfully shrink them.
 */
export function extractShortenableUrls(text: string, baseUrl: string): string[] {
  const base = trimBase(baseUrl);
  // "/s/" + code, plus a small margin so near-ties aren't churned.
  const minLength = base.length + SHORT_CODE_LENGTH + 3 + 4;
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailingUrlPunctuation(match[0]);
    if (url.length <= minLength) continue;
    if (isOwnShortLink(url, base)) continue;
    seen.add(url);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

export type ShortenedLink = { shortCode: string; originalUrl: string };

export type ShortenSmsBodyResult = {
  /** Body with every successfully tracked URL replaced by its short link. */
  text: string;
  links: ShortenedLink[];
};

export type ShortenSmsBodyOptions = {
  businessId: string;
  text: string;
  /** Send surface, mirroring sms_outbound_log.source. */
  source: string;
  /** Public app origin (NEXT_PUBLIC_APP_URL). Missing/invalid ⇒ no-op. */
  baseUrl: string | null | undefined;
  toE164?: string | null;
  flowId?: string | null;
  runId?: string | null;
  randomBytes?: RandomBytes;
};

/**
 * Insert one sms_links row, retrying fresh codes on unique collision.
 * Returns the persisted code, or null when the link could not be tracked
 * (the caller then leaves the original URL in place).
 */
async function insertShortLink(
  db: ShortLinkSupabase,
  opts: ShortenSmsBodyOptions,
  originalUrl: string
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateShortCode(opts.randomBytes);
    try {
      const { error } = await db.from("sms_links").insert({
        business_id: opts.businessId,
        short_code: code,
        // Bare-domain matches are stored scheme-prefixed: the /s/<code>
        // redirect needs an absolute URL.
        original_url: ensureUrlScheme(originalUrl),
        to_e164: opts.toE164 ?? null,
        source: opts.source,
        flow_id: opts.flowId ?? null,
        run_id: opts.runId ?? null
      });
      if (!error) return code;
      if (error.code !== UNIQUE_VIOLATION) {
        console.warn("sms_short_links: insert failed, leaving URL unshortened", error.message);
        return null;
      }
      // Collision: loop mints a fresh code.
    } catch (err) {
      console.warn(
        "sms_short_links: insert threw, leaving URL unshortened",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }
  console.warn("sms_short_links: exhausted code attempts, leaving URL unshortened");
  return null;
}

/**
 * Best-effort removal of tracked links whose send never went out (carrier
 * rejection, quota release, transport error) — otherwise the rows would sit
 * as live /s/<code> redirects for messages nobody received. Never throws:
 * cleanup is strictly subordinate to the caller's own error handling.
 */
export async function deleteShortLinks(
  db: ShortLinkSupabase,
  links: readonly ShortenedLink[]
): Promise<void> {
  if (links.length === 0) return;
  try {
    const { error } = await db
      .from("sms_links")
      .delete()
      .in("short_code", links.map((l) => l.shortCode));
    if (error) {
      console.warn("sms_short_links: cleanup delete failed", error.message);
    }
  } catch (err) {
    console.warn(
      "sms_short_links: cleanup delete threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Rewrite long URLs in an outbound SMS body to tracked /s/<code> redirects.
 *
 * Fail-safe by design: a missing/non-http base URL, a body with no
 * shortenable URLs, or any insert failure returns the text unchanged (in
 * whole or for that URL) — never throws, never blocks the send.
 */
export async function shortenSmsBodyUrls(
  db: ShortLinkSupabase,
  opts: ShortenSmsBodyOptions
): Promise<ShortenSmsBodyResult> {
  const baseUrl = (opts.baseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { text: opts.text, links: [] };
  }
  const urls = extractShortenableUrls(opts.text, baseUrl);
  let text = opts.text;
  const links: ShortenedLink[] = [];
  for (const originalUrl of urls) {
    const code = await insertShortLink(db, opts, originalUrl);
    if (!code) continue;
    text = text.split(originalUrl).join(shortLinkUrl(baseUrl, code));
    links.push({ shortCode: code, originalUrl });
  }
  return { text, links };
}

/**
 * Pair tracked short links with the outbound log row for the SMS that carried
 * them. Runs after a successful send + logOutboundSms insert. Best-effort:
 * never throws, never blocks the caller.
 */
export async function linkSmsLinksToOutboundLog(
  db: ShortLinkSupabase,
  shortCodes: readonly string[],
  outboundLogId: string | null | undefined
): Promise<void> {
  if (!outboundLogId || shortCodes.length === 0) return;
  try {
    const { error } = await db
      .from("sms_links")
      .update({ sms_outbound_log_id: outboundLogId })
      .in("short_code", [...shortCodes]);
    if (error) {
      console.warn("sms_short_links: outbound log pairing failed", error.message);
    }
  } catch (err) {
    console.warn(
      "sms_short_links: outbound log pairing threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}
