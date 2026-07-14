/**
 * Direct CalDAV client (iCloud, Nextcloud, generic CalDAV servers) —
 * concept ported from BizBlasts' Calendar::CaldavService/IcloudService.
 *
 * Speaks just enough of RFC 4791 for the calendar tools:
 *   - discoverEventCalendars: current-user-principal → calendar-home-set →
 *     calendar list (PROPFIND), filtered to VEVENT-capable collections.
 *   - fetchCaldavBusy: REPORT calendar-query with a time-range filter and
 *     server-side recurrence `expand` (RFC 4791 §9.6.5 — expanded instances
 *     come back in UTC), parsed into busy blocks.
 *   - createCaldavEvent: PUT a minimal VCALENDAR with `If-None-Match: *`.
 *
 * Transport safety: every request URL (including discovery hrefs and manual
 * redirect hops — iCloud bounces principals onto pNN-caldav partition hosts)
 * is re-validated as https + public host before it is fetched, so a
 * malicious server can never steer us at an internal address.
 *
 * XML/iCal parsing is deliberately regex-based over namespace-stripped text
 * (the same shapes BizBlasts parsed with Nokogiri) — the multistatus
 * documents involved are small and highly regular.
 */
import { isPrivateOrLoopbackHost } from "@/lib/db/custom-integrations";
import { logger } from "@/lib/logger";

export const CALDAV_REQUEST_TIMEOUT_MS = 20_000;
/** Manual-redirect budget (iCloud principal discovery uses 1-2 hops). */
export const CALDAV_MAX_REDIRECTS = 3;

export class CaldavApiError extends Error {
  constructor(
    public readonly code:
      | "blocked_url"
      | "auth_failed"
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "CaldavApiError";
  }
}

export type CaldavCredentials = {
  serverUrl: string;
  username: string;
  password: string;
};

export type CaldavRequestOptions = {
  fetchImpl?: typeof fetch;
};

/** Throws CaldavApiError("blocked_url") unless https + public host. */
export function assertSafeCaldavUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CaldavApiError("blocked_url", `CalDAV URL is not valid: ${raw.slice(0, 120)}`);
  }
  if (url.protocol !== "https:") {
    throw new CaldavApiError("blocked_url", "CalDAV URLs must use https://");
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new CaldavApiError("blocked_url", "CalDAV URL points at a private/loopback host");
  }
  return url;
}

function basicAuthHeader(creds: CaldavCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64")}`;
}

/**
 * Authenticated CalDAV request with manual, re-validated redirects.
 * 401/403 → CaldavApiError("auth_failed") so callers can map it to
 * "calendar_not_connected" (revoked app-specific password).
 */
export async function caldavRequest(
  creds: CaldavCredentials,
  req: { url: string; method: string; headers?: Record<string, string>; body?: string },
  opts: CaldavRequestOptions = {}
): Promise<{ status: number; body: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let currentUrl = assertSafeCaldavUrl(req.url);

  for (let hop = 0; hop <= CALDAV_MAX_REDIRECTS; hop += 1) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), CALDAV_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(currentUrl.toString(), {
        method: req.method,
        headers: {
          Authorization: basicAuthHeader(creds),
          "User-Agent": "NewCoworker Calendar/1.0 (CalDAV)",
          ...(req.headers ?? {})
        },
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: "manual",
        signal: ac.signal
      });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      throw new CaldavApiError(
        aborted ? "upstream_timeout" : "upstream_unreachable",
        aborted ? "CalDAV server timed out" : "CalDAV server unreachable"
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop === CALDAV_MAX_REDIRECTS) {
        throw new CaldavApiError(
          "request_failed",
          `CalDAV ${req.method} redirected without a usable target (${res.status})`,
          res.status
        );
      }
      // Relative Location headers resolve against the current URL; the
      // result is re-validated so a redirect can never escape to a
      // private host.
      currentUrl = assertSafeCaldavUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new CaldavApiError(
        "auth_failed",
        "CalDAV server rejected the credentials",
        res.status
      );
    }

    return { status: res.status, body: await res.text() };
  }
  /* c8 ignore next 2 -- unreachable: the loop always returns or throws */
  throw new CaldavApiError("request_failed", "CalDAV redirect loop");
}

// ---------------------------------------------------------------------------
// XML helpers (namespace-agnostic, mirroring Nokogiri's remove_namespaces!)
// ---------------------------------------------------------------------------

/** Strip namespace prefixes from element tags: `<D:href>` → `<href>`. */
export function stripXmlNamespaces(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z0-9_-]+:/g, "<$1");
}

/** First `<href>` inside the first `<elementName>` element, or null. */
export function extractHrefInside(xml: string, elementName: string): string | null {
  const stripped = stripXmlNamespaces(xml);
  const el = stripped.match(
    new RegExp(`<${elementName}[^>]*>([\\s\\S]*?)</${elementName}>`, "i")
  );
  if (!el) return null;
  const href = el[1].match(/<href[^>]*>([^<]+)<\/href>/i);
  return href ? href[1].trim() : null;
}

export type CaldavCalendar = { url: string; name: string };

/**
 * Event-capable calendar collections from a PROPFIND Depth-1 multistatus.
 * A collection qualifies when its resourcetype carries `<calendar/>` and its
 * supported-component-set mentions VEVENT (absent set = assume events, like
 * BizBlasts did).
 */
export function parseCalendarList(xml: string, baseUrl: string): CaldavCalendar[] {
  const stripped = stripXmlNamespaces(xml);
  const calendars: CaldavCalendar[] = [];
  for (const match of stripped.matchAll(/<response[^>]*>([\s\S]*?)<\/response>/gi)) {
    const block = match[1];
    const href = block.match(/<href[^>]*>([^<]+)<\/href>/i)?.[1]?.trim();
    if (!href) continue;
    if (!/<resourcetype[^>]*>[\s\S]*?<calendar[\s/>][\s\S]*?<\/resourcetype>/i.test(block)) {
      continue;
    }
    const hasComponentSet = /supported-calendar-component-set/i.test(block);
    if (hasComponentSet && !/VEVENT/i.test(block)) continue;
    const name = block.match(/<displayname[^>]*>([^<]*)<\/displayname>/i)?.[1]?.trim();
    calendars.push({
      url: new URL(href, baseUrl).toString(),
      name: name && name.length > 0 ? name : "Calendar"
    });
  }
  return calendars;
}

/**
 * Preferred event calendar for bookings when the account has several —
 * BizBlasts' name heuristic ('work' first: 'home' can be read-only on some
 * iCloud setups), else the first listed.
 */
export function pickPreferredCalendar(calendars: CaldavCalendar[]): CaldavCalendar | null {
  if (calendars.length === 0) return null;
  const preferredNames = ["work", "calendar", "personal", "main", "default", "home"];
  for (const wanted of preferredNames) {
    const hit = calendars.find((c) => c.name.toLowerCase() === wanted);
    if (hit) return hit;
  }
  return calendars[0];
}

const PROPFIND_PRINCIPAL_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal /></D:prop></D:propfind>';

const PROPFIND_CALENDAR_HOME_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  "<D:prop><C:calendar-home-set /></D:prop></D:propfind>";

const PROPFIND_CALENDAR_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  "<D:prop><D:resourcetype /><D:displayname />" +
  "<C:supported-calendar-component-set /></D:prop></D:propfind>";

function propfindHeaders(depth: "0" | "1"): Record<string, string> {
  return {
    "Content-Type": "application/xml; charset=utf-8",
    Depth: depth,
    Accept: "application/xml, text/xml"
  };
}

async function propfind(
  creds: CaldavCredentials,
  url: string,
  body: string,
  depth: "0" | "1",
  opts: CaldavRequestOptions
): Promise<string> {
  const res = await caldavRequest(
    creds,
    { url, method: "PROPFIND", headers: propfindHeaders(depth), body },
    opts
  );
  if (res.status < 200 || res.status > 299) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV PROPFIND failed (${res.status})`,
      res.status
    );
  }
  return res.body;
}

/**
 * Three-step discovery: principal → calendar home → event calendars.
 * Throws CaldavApiError on every failure mode (bad credentials, blocked
 * URLs, malformed responses).
 */
export async function discoverEventCalendars(
  creds: CaldavCredentials,
  opts: CaldavRequestOptions = {}
): Promise<CaldavCalendar[]> {
  const base = assertSafeCaldavUrl(creds.serverUrl).toString();

  const principalXml = await propfind(creds, base, PROPFIND_PRINCIPAL_BODY, "0", opts);
  const principalHref = extractHrefInside(principalXml, "current-user-principal");
  if (!principalHref) {
    throw new CaldavApiError("request_failed", "CalDAV principal discovery returned no href");
  }
  const principalUrl = new URL(principalHref, base).toString();

  const homeXml = await propfind(creds, principalUrl, PROPFIND_CALENDAR_HOME_BODY, "0", opts);
  const homeHref = extractHrefInside(homeXml, "calendar-home-set");
  if (!homeHref) {
    throw new CaldavApiError("request_failed", "CalDAV calendar-home-set returned no href");
  }
  const homeUrl = new URL(homeHref, principalUrl).toString();

  const listXml = await propfind(creds, homeUrl, PROPFIND_CALENDAR_LIST_BODY, "1", opts);
  return parseCalendarList(listXml, homeUrl);
}

// ---------------------------------------------------------------------------
// iCal parsing (REPORT responses)
// ---------------------------------------------------------------------------

/** Undo RFC 5545 line folding (CRLF followed by a space/tab continues). */
export function unfoldICalLines(ical: string): string[] {
  return ical
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
}

/** `YYYYMMDDTHHMMSSZ` for an instant — the shape CalDAV PUTs use. */
export function icalUtcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * One DTSTART/DTEND property value → UTC Date, or null when unparseable.
 *   - `20260711T090000Z`     → that UTC instant (what `expand` returns)
 *   - `20260711` (VALUE=DATE) → UTC midnight (all-day boundary)
 *   - `20260711T090000`      → treated as UTC (floating times are rare and
 *     a slightly-off busy block beats a dropped one)
 */
export function parseICalDateValue(value: string): Date | null {
  const dateTime = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (dateTime) {
    const [, y, mo, d, h, mi, s] = dateTime;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }
  return null;
}

export type BusyBlock = { start: Date; end: Date };

/**
 * Busy blocks from raw iCal text: every VEVENT with a parseable DTSTART +
 * DTEND, skipping cancelled and transparent (free-time) events. Events
 * without a DTEND are skipped — with server-side `expand`, real events
 * carry both.
 */
export function parseICalBusyBlocks(ical: string): BusyBlock[] {
  const lines = unfoldICalLines(ical);
  const blocks: BusyBlock[] = [];
  let inEvent = false;
  let start: Date | null = null;
  let end: Date | null = null;
  let skip = false;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      inEvent = true;
      start = null;
      end = null;
      skip = false;
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (inEvent && !skip && start && end && end.getTime() > start.getTime()) {
        blocks.push({ start, end });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const prop = line.match(/^(DTSTART|DTEND|STATUS|TRANSP)(?:;[^:]*)?:(.*)$/i);
    if (!prop) continue;
    const name = prop[1].toUpperCase();
    const value = prop[2].trim();
    if (name === "DTSTART") start = parseICalDateValue(value);
    else if (name === "DTEND") end = parseICalDateValue(value);
    else if (name === "STATUS" && /CANCELLED/i.test(value)) skip = true;
    else if (name === "TRANSP" && /TRANSPARENT/i.test(value)) skip = true;
  }
  return blocks;
}

/**
 * `<calendar-data>` payloads from a REPORT multistatus. CDATA-wrapped and
 * XML-escaped variants both appear in the wild.
 */
export function extractCalendarData(xml: string): string[] {
  const stripped = stripXmlNamespaces(xml);
  const payloads: string[] = [];
  for (const match of stripped.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/gi)) {
    let text = match[1];
    const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) text = cdata[1];
    payloads.push(
      text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#13;/g, "\r")
        .replace(/&amp;/g, "&")
    );
  }
  return payloads;
}

function calendarQueryBody(windowStart: Date, windowEnd: Date): string {
  const start = icalUtcStamp(windowStart);
  const end = icalUtcStamp(windowEnd);
  // `expand` makes the server return recurrence INSTANCES in UTC
  // (RFC 4791 §9.6.5) — without it a weekly standing meeting would never
  // block slots.
  return (
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag />" +
    `<C:calendar-data><C:expand start="${start}" end="${end}"/></C:calendar-data>` +
    "</D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
    `<C:time-range start="${start}" end="${end}"/>` +
    "</C:comp-filter></C:comp-filter></C:filter>" +
    "</C:calendar-query>"
  );
}

/** Busy blocks in [windowStart, windowEnd) from one calendar collection. */
export async function fetchCaldavBusy(
  creds: CaldavCredentials,
  calendarUrl: string,
  windowStart: Date,
  windowEnd: Date,
  opts: CaldavRequestOptions = {}
): Promise<BusyBlock[]> {
  const res = await caldavRequest(
    creds,
    {
      url: calendarUrl,
      method: "REPORT",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1"
      },
      body: calendarQueryBody(windowStart, windowEnd)
    },
    opts
  );
  if (res.status < 200 || res.status > 299) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV REPORT failed (${res.status})`,
      res.status
    );
  }
  return extractCalendarData(res.body).flatMap((ical) => parseICalBusyBlocks(ical));
}

/** iCal TEXT escaping (RFC 5545 §3.3.11). */
export function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export type CaldavEventInput = {
  uid: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
};

/**
 * Create one event on a calendar collection via PUT. `If-None-Match: *`
 * guarantees we never overwrite an existing resource. Returns the event UID
 * on success; throws CaldavApiError otherwise.
 */
export async function createCaldavEvent(
  creds: CaldavCredentials,
  calendarUrl: string,
  event: CaldavEventInput,
  opts: CaldavRequestOptions = {}
): Promise<{ eventUid: string }> {
  // The UID doubles as the resource filename — keep it path-safe.
  assertSafeEventUid(event.uid);
  const ical =
    "BEGIN:VCALENDAR\r\n" +
    "VERSION:2.0\r\n" +
    "PRODID:-//NewCoworker//Calendar Integration//EN\r\n" +
    "CALSCALE:GREGORIAN\r\n" +
    "BEGIN:VEVENT\r\n" +
    `UID:${event.uid}\r\n` +
    `DTSTAMP:${icalUtcStamp(new Date())}\r\n` +
    `DTSTART:${icalUtcStamp(new Date(event.startIso))}\r\n` +
    `DTEND:${icalUtcStamp(new Date(event.endIso))}\r\n` +
    `SUMMARY:${escapeICalText(event.summary)}\r\n` +
    `DESCRIPTION:${escapeICalText(event.description)}\r\n` +
    "STATUS:CONFIRMED\r\n" +
    "TRANSP:OPAQUE\r\n" +
    "END:VEVENT\r\n" +
    "END:VCALENDAR\r\n";

  const eventUrl = eventResourceUrl(calendarUrl, event.uid);
  const res = await caldavRequest(
    creds,
    {
      url: eventUrl,
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*"
      },
      body: ical
    },
    opts
  );
  if (![200, 201, 204].includes(res.status)) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV event create failed (${res.status})`,
      res.status
    );
  }
  return { eventUid: event.uid };
}

/** UID sanity shared by create and the lifecycle helpers (path safety). */
function assertSafeEventUid(uid: string): void {
  if (!/^[\w.@-]+$/.test(uid)) {
    throw new CaldavApiError("request_failed", "CalDAV event UID contains invalid characters");
  }
}

/** The event resource URL our bookings PUT to (UID doubles as filename). */
function eventResourceUrl(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/+$/, "")}/${uid}.ics`;
}

/**
 * Move an existing event IN PLACE: GET the resource, rewrite DTSTART/DTEND
 * (bumping DTSTAMP and SEQUENCE so clients treat it as an update to the
 * SAME event), PUT it back. Every other property — SUMMARY, DESCRIPTION,
 * anything the server added — survives untouched.
 *
 * Throws CaldavApiError("request_failed", 404) when the resource is gone;
 * callers map that to booking_not_found.
 */
export async function updateCaldavEventTime(
  creds: CaldavCredentials,
  calendarUrl: string,
  uid: string,
  startIso: string,
  endIso: string,
  opts: CaldavRequestOptions = {}
): Promise<void> {
  assertSafeEventUid(uid);
  const url = eventResourceUrl(calendarUrl, uid);

  const got = await caldavRequest(
    creds,
    { url, method: "GET", headers: { Accept: "text/calendar" } },
    opts
  );
  if (got.status < 200 || got.status > 299) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV event fetch failed (${got.status})`,
      got.status
    );
  }

  // Property lines are matched with optional parameters (DTSTART;TZID=…:).
  // Our own bookings write unfolded single-line values, and DTSTART/DTEND/
  // DTSTAMP/SEQUENCE values are never long enough to fold in practice.
  const stamp = icalUtcStamp(new Date());
  let ical = got.body
    .replace(/^DTSTART(?:;[^:\r\n]*)?:.*$/m, `DTSTART:${icalUtcStamp(new Date(startIso))}`)
    .replace(/^DTEND(?:;[^:\r\n]*)?:.*$/m, `DTEND:${icalUtcStamp(new Date(endIso))}`)
    .replace(/^DTSTAMP(?:;[^:\r\n]*)?:.*$/m, `DTSTAMP:${stamp}`);
  if (!/^DTSTART:/m.test(ical) || !/^DTEND:/m.test(ical)) {
    // A resource without both times (e.g. all-day VALUE=DATE that our
    // replace missed, or a stray non-event) must not be blind-PUT.
    throw new CaldavApiError("request_failed", "CalDAV event body has no usable DTSTART/DTEND");
  }
  const seq = ical.match(/^SEQUENCE(?:;[^:\r\n]*)?:(\d+)\s*$/m);
  ical = seq
    ? ical.replace(/^SEQUENCE(?:;[^:\r\n]*)?:\d+\s*$/m, `SEQUENCE:${Number(seq[1]) + 1}`)
    : ical.replace(/^(UID(?:;[^:\r\n]*)?:.*)$/m, `$1\r\nSEQUENCE:1`);

  const put = await caldavRequest(
    creds,
    {
      url,
      method: "PUT",
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
      body: ical
    },
    opts
  );
  if (![200, 201, 204].includes(put.status)) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV event update failed (${put.status})`,
      put.status
    );
  }
}

/**
 * Delete an event resource. A 404 counts as success — the event is gone
 * either way, and a retried cancel must not fail the second time.
 */
export async function deleteCaldavEvent(
  creds: CaldavCredentials,
  calendarUrl: string,
  uid: string,
  opts: CaldavRequestOptions = {}
): Promise<void> {
  assertSafeEventUid(uid);
  const res = await caldavRequest(
    creds,
    { url: eventResourceUrl(calendarUrl, uid), method: "DELETE" },
    opts
  );
  if (![200, 202, 204, 404].includes(res.status)) {
    throw new CaldavApiError(
      "request_failed",
      `CalDAV event delete failed (${res.status})`,
      res.status
    );
  }
}

export type CaldavVerification =
  | { ok: true; calendars: CaldavCalendar[] }
  | { ok: false; reason: CaldavApiError["code"] };

/**
 * End-to-end connection check for the connect flow: full discovery walk.
 * Never throws — the dashboard reports the outcome instead of 500ing.
 */
export async function verifyCaldavConnection(
  creds: CaldavCredentials,
  opts: CaldavRequestOptions = {}
): Promise<CaldavVerification> {
  try {
    const calendars = await discoverEventCalendars(creds, opts);
    if (calendars.length === 0) return { ok: false, reason: "request_failed" };
    return { ok: true, calendars };
  } catch (err) {
    logger.warn("caldav verification failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      reason: err instanceof CaldavApiError ? err.code : "request_failed"
    };
  }
}
