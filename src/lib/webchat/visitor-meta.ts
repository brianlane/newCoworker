/**
 * Passive visitor metadata for the website chat widget.
 *
 * Two sources, combined at session start and stored as
 * `webchat_sessions.visitor_meta` (jsonb):
 *
 *   * REQUEST-DERIVED (server-side, free): approximate location from
 *     Vercel's IP-geo headers and a coarse device summary from the
 *     User-Agent. THE IP ADDRESS ITSELF IS NEVER STORED — it is read
 *     transiently for rate limiting and geo derivation only, and only the
 *     derived city/region/country/timezone persist (privacy posture:
 *     coarse facts, not identifiers).
 *   * CLIENT-REPORTED (the loader on the host page): page URL, referrer,
 *     UTM campaign parameters, browser language, screen size, local
 *     timezone, returning-visitor flag, and time-on-page before opening
 *     the chat. All untrusted — validated and length-capped here.
 *
 * The message route additionally appends the pages the visitor navigates
 * to while the chat is open (`pages`, capped).
 */

import { z } from "zod";

/** Longest URL we persist (page, referrer, page-trail entries). */
export const VISITOR_META_MAX_URL_CHARS = 500;
/** Page-trail cap — enough to see a journey, never unbounded. */
export const VISITOR_META_MAX_PAGES = 20;

/**
 * Field parsers are individually FORGIVING: one malformed value (an empty
 * `screen`, an over-long language tag, a non-boolean flag) degrades to
 * undefined instead of failing the whole payload — a single bad field must
 * never drop everything else the loader collected (Bugbot Medium on PR
 * #653). Empty/whitespace strings become undefined; URLs are truncated,
 * never rejected, for length.
 */
const trimmedField = (max: number) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return undefined;
      const t = v.trim();
      return t ? t.slice(0, max) : undefined;
    },
    z.string().optional()
  );

const urlField = trimmedField(VISITOR_META_MAX_URL_CHARS);

const screenField = z.preprocess(
  (v) =>
    typeof v === "string" && /^\d{1,5}x\d{1,5}$/.test(v.trim()) ? v.trim() : undefined,
  z.string().optional()
);

const returningField = z.preprocess(
  (v) => (typeof v === "boolean" ? v : undefined),
  z.boolean().optional()
);

const timeOnPageField = z.preprocess(
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7 * 24 * 60 * 60 * 1000
      ? v
      : undefined,
  z.number().optional()
);

/** Client-reported meta on the session-start POST. Everything optional. */
export const webchatClientMetaSchema = z.object({
  page: urlField,
  referrer: urlField,
  utm: z
    .preprocess(
      (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined),
      z
        .object({
          source: trimmedField(200),
          medium: trimmedField(200),
          campaign: trimmedField(200),
          term: trimmedField(200),
          content: trimmedField(200)
        })
        .optional()
    ),
  language: trimmedField(35),
  screen: screenField,
  timezone: trimmedField(64),
  returning: returningField,
  timeOnPageMs: timeOnPageField
});

export type WebchatClientMeta = z.infer<typeof webchatClientMetaSchema>;

export type WebchatVisitorGeo = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

export type WebchatVisitorDevice = {
  browser?: string;
  os?: string;
  mobile?: boolean;
};

export type WebchatVisitorMeta = {
  geo?: WebchatVisitorGeo;
  device?: WebchatVisitorDevice;
  client?: WebchatClientMeta;
  /** Pages seen while the chat was open (session-start page first). */
  pages?: string[];
};

function headerValue(headers: Headers, name: string): string | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  // Vercel URL-encodes non-ASCII header values (e.g. "S%C3%A3o%20Paulo").
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return raw.slice(0, 100);
  }
}

/** Approximate location from Vercel's IP-geo headers. Never the IP itself. */
export function geoFromRequestHeaders(headers: Headers): WebchatVisitorGeo | undefined {
  const geo: WebchatVisitorGeo = {};
  const country = headerValue(headers, "x-vercel-ip-country");
  const region = headerValue(headers, "x-vercel-ip-country-region");
  const city = headerValue(headers, "x-vercel-ip-city");
  const timezone = headerValue(headers, "x-vercel-ip-timezone");
  if (country) geo.country = country;
  if (region) geo.region = region;
  if (city) geo.city = city;
  if (timezone) geo.timezone = timezone;
  return Object.keys(geo).length > 0 ? geo : undefined;
}

/**
 * Coarse browser/OS/mobile summary from the User-Agent. Deliberately a
 * handful of substring checks, not a UA-parser dependency — "Chrome on
 * macOS, desktop" is the whole requirement.
 */
export function deviceFromUserAgent(ua: string | null | undefined): WebchatVisitorDevice | undefined {
  if (!ua || !ua.trim()) return undefined;
  const s = ua;

  let os: string | undefined;
  if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/CrOS/i.test(s)) os = "ChromeOS";
  else if (/Linux/i.test(s)) os = "Linux";

  // Order matters: Edge/Opera UAs contain "Chrome"; Chrome/Safari overlap.
  let browser: string | undefined;
  if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/Firefox\//i.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//i.test(s)) browser = "Chrome";
  else if (/Safari\//i.test(s)) browser = "Safari";

  const mobile = /Mobi|iPhone|iPod|Android(?!.*Tablet)/i.test(s);

  if (!os && !browser) return undefined;
  const device: WebchatVisitorDevice = { mobile };
  if (browser) device.browser = browser;
  if (os) device.os = os;
  return device;
}

/**
 * Combine request-derived and client-reported meta for a new session.
 * Null when nothing was collectable (all-empty stays a NULL column, not
 * an empty object).
 */
export function buildVisitorMeta(args: {
  headers: Headers;
  clientMeta?: WebchatClientMeta | null;
}): WebchatVisitorMeta | null {
  const meta: WebchatVisitorMeta = {};
  const geo = geoFromRequestHeaders(args.headers);
  const device = deviceFromUserAgent(args.headers.get("user-agent"));
  if (geo) meta.geo = geo;
  if (device) meta.device = device;
  const client = compactClientMeta(args.clientMeta);
  if (client) {
    meta.client = client;
    if (client.page) meta.pages = [client.page];
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Drop undefined-valued keys (the forgiving field parsers emit them for
 * present-but-invalid inputs) so an all-invalid payload stores NOTHING,
 * not `client: {}`.
 */
function compactClientMeta(raw: WebchatClientMeta | null | undefined): WebchatClientMeta | null {
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (k === "utm" && v && typeof v === "object") {
      const utm = Object.fromEntries(
        Object.entries(v).filter(([, uv]) => uv !== undefined)
      );
      if (Object.keys(utm).length > 0) out.utm = utm;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as WebchatClientMeta) : null;
}

/** Defensive read of a stored jsonb column into the typed shape. */
export function parseVisitorMeta(raw: unknown): WebchatVisitorMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as WebchatVisitorMeta;
}

/**
 * Record a page the visitor navigated to while chatting. Returns the new
 * meta when it changed, null when it didn't (caller skips the write).
 * Dedupes against the LAST entry (back-and-forth still shows), caps the
 * trail, truncates the URL.
 */
export function appendVisitorPage(
  meta: WebchatVisitorMeta | null,
  url: string
): WebchatVisitorMeta | null {
  const clean = url.trim().slice(0, VISITOR_META_MAX_URL_CHARS);
  if (!clean) return null;
  const base = meta ?? {};
  const pages = Array.isArray(base.pages) ? base.pages : [];
  if (pages[pages.length - 1] === clean) return null;
  if (pages.length >= VISITOR_META_MAX_PAGES) return null;
  return { ...base, pages: [...pages, clean] };
}

// ---------------------------------------------------------------------
// Display formatting (admin/owner views)
// ---------------------------------------------------------------------

/** "Phoenix, AZ, US" — most specific parts first, nothing invented. */
export function formatVisitorLocation(meta: WebchatVisitorMeta | null): string | null {
  const geo = meta?.geo;
  if (!geo) return null;
  const parts = [geo.city, geo.region, geo.country].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "Chrome on macOS · mobile" */
export function formatVisitorDevice(meta: WebchatVisitorMeta | null): string | null {
  const d = meta?.device;
  if (!d) return null;
  const core =
    d.browser && d.os ? `${d.browser} on ${d.os}` : (d.browser ?? d.os ?? null);
  if (!core) return null;
  return d.mobile ? `${core} · mobile` : core;
}

/** Campaign source: UTM first ("google / cpc / brand"), else referrer host. */
export function formatVisitorSource(meta: WebchatVisitorMeta | null): string | null {
  const c = meta?.client;
  if (!c) return null;
  const utmBits = [c.utm?.source, c.utm?.medium, c.utm?.campaign].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (utmBits.length > 0) return utmBits.join(" / ");
  if (c.referrer) {
    try {
      return new URL(c.referrer).host || c.referrer;
    } catch {
      return c.referrer;
    }
  }
  return null;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export type VisitorMetaRow = { label: string; value: string };

/**
 * Everything we know, as label/value rows for the transcript header —
 * the "display everything except IP" surface (there is no IP to display:
 * it is never stored).
 */
export function visitorMetaDisplayRows(meta: WebchatVisitorMeta | null): VisitorMetaRow[] {
  if (!meta) return [];
  const rows: VisitorMetaRow[] = [];
  const location = formatVisitorLocation(meta);
  if (location) rows.push({ label: "Location", value: location });
  const device = formatVisitorDevice(meta);
  if (device) rows.push({ label: "Device", value: device });
  const c = meta.client;
  if (c?.language) rows.push({ label: "Language", value: c.language });
  const tz = c?.timezone ?? meta.geo?.timezone;
  if (tz) rows.push({ label: "Local timezone", value: tz });
  if (c?.screen) rows.push({ label: "Screen", value: c.screen });
  if (c?.page) rows.push({ label: "Opened on", value: c.page });
  const source = formatVisitorSource(meta);
  if (source) rows.push({ label: "Source", value: source });
  if (typeof c?.returning === "boolean") {
    rows.push({ label: "Returning visitor", value: c.returning ? "yes" : "no" });
  }
  if (typeof c?.timeOnPageMs === "number") {
    rows.push({ label: "Time on page before chat", value: formatDuration(c.timeOnPageMs) });
  }
  const trail = (meta.pages ?? []).filter((p) => typeof p === "string" && p.length > 0);
  // The first trail entry is the session-start page, already shown above.
  if (trail.length > 1) {
    rows.push({ label: "Pages visited", value: trail.slice(1).join(" → ") });
  }
  return rows;
}
