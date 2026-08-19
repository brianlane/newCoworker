/**
 * Acuity Scheduling API client: HTTP Basic transport plus thin typed helpers
 * over the endpoints the calendar tools, the AiFlow poller, the webhook
 * receiver, and the dashboard card use.
 *
 * Three things make this materially different from the Vagaro client, and
 * each one is why a chunk of code below exists:
 *
 *   1. NO TOKEN EXCHANGE. Acuity authenticates with the merchant's User ID
 *      and API Key as HTTP Basic credentials, so there is no token manager,
 *      no cache, and no 401-retry: a 401 is unconditionally `auth_failed`.
 *
 *   2. THE RATE LIMIT IS PER IP, NOT PER ACCOUNT (10 req/s, 20 concurrent).
 *      On serverless the whole fleet egresses from a shared pool, so every
 *      tenant draws on ONE Acuity bucket. A per-connection throttle would let
 *      ten tenants each stay "under the limit" while collectively blowing
 *      through it, so the budget is enforced globally via the durable
 *      Postgres limiter, with a process-local serializer underneath it so a
 *      single isolate never bursts between durable checks.
 *
 *   3. TIMES ARE TIMEZONE-SENSITIVE AND NOT QUITE ISO 8601. Acuity parses
 *      datetimes with PHP strtotime() in the business/calendar timezone
 *      unless told otherwise, and its availability responses carry compact
 *      offsets (`-0800`, no colon). `acuityDateTime` and `normalizeAcuityTime`
 *      are the only sanctioned way across that boundary, see their docs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";
import { rateLimitDurable } from "@/lib/rate-limit";
import type { AcuityConnectionRow } from "@/lib/db/acuity-connections";

/** The versioned API path. The stored base URL is a bare origin. */
export const ACUITY_API_PATH = "/api/v1";

/** Outbound budget per API call, fail fast on a stuck upstream. */
export const ACUITY_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fleet-wide request budget. Acuity's documented ceiling is 10 req/s per IP;
 * 6 leaves headroom for the fact that we cannot see how many isolates share
 * an egress IP at any moment.
 */
export const ACUITY_FLEET_BUDGET_PER_SECOND = 6;

/**
 * Minimum spacing between requests from a single process. Keeps one isolate
 * from firing a burst in the gap between durable-limiter checks, and pins
 * per-instance concurrency at 1 (far under the 20-connection cap).
 */
export const ACUITY_MIN_REQUEST_INTERVAL_MS = 120;

/**
 * How many times a caller re-checks the fleet bucket before giving up. The
 * window is one second, so this waits out at most a few windows rather than
 * queueing unboundedly behind a genuinely saturated fleet.
 */
export const ACUITY_FLEET_WAIT_ATTEMPTS = 3;

/** The signature header Acuity sends on webhook deliveries. */
export const ACUITY_SIGNATURE_HEADER = "x-acuity-signature";

export class AcuityApiError extends Error {
  constructor(
    public readonly code:
      | "auth_failed"
      | "rate_limited"
      | "not_found"
      | "slot_unavailable"
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable",
    message: string,
    public readonly status?: number,
    /** Acuity's machine-readable code from the error body, when present. */
    public readonly acuityError?: string
  ) {
    super(message);
    this.name = "AcuityApiError";
  }
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * The local calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone`.
 *
 * Acuity's availability endpoints are DATE-scoped, so mapping a tool's
 * instant window onto them means asking "which local days does this cover?".
 * The `en-CA` locale yields `YYYY-MM-DD` directly, which is why it is used
 * here rather than assembling parts by hand.
 *
 * The zone used here MUST be the same one passed as the request's `timezone`
 * param, or our idea of where the day boundary falls disagrees with Acuity's
 * and the edges of the window silently go missing.
 */
export function acuityLocalDate(instantIso: string | Date, timeZone: string): string {
  const d = instantIso instanceof Date ? instantIso : new Date(instantIso);
  if (Number.isNaN(d.getTime())) {
    throw new AcuityApiError("request_failed", `acuityLocalDate: unparseable instant`);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

/**
 * Turn Intl's `longOffset` timeZoneName into an ISO 8601 offset:
 * "GMT-04:00" → "-04:00", "GMT+05:30" → "+05:30".
 *
 * ICU renders a zero offset as the bare string "GMT" in some builds and
 * locales, which has no sign or digits to parse; that is the one case the
 * regex cannot match, and it means UTC.
 */
export function offsetFromLongOffset(longOffset: string): string {
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(longOffset);
  if (!m) return "+00:00";
  const sign = m[1];
  const hours = m[2].padStart(2, "0");
  const minutes = (m[3] ?? "00").padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

/**
 * Render an instant as a full ISO 8601 string WITH offset, as seen in
 * `timeZone` (e.g. `2026-08-04T13:00:00-04:00`).
 *
 * Every datetime we send Acuity goes through this. A naive local string
 * would be re-interpreted by strtotime() against whatever the account or
 * calendar timezone happens to be, which is a silent-wrong-answer bug for a
 * product whose tenants are not all in one zone; an explicit offset leaves
 * strtotime nothing to guess. Handles non-hour offsets (+05:30, +08:45) and
 * both DST transitions, which is exactly what the tests pin.
 */
export function acuityDateTime(instantIso: string | Date, timeZone: string): string {
  const d = instantIso instanceof Date ? instantIso : new Date(instantIso);
  if (Number.isNaN(d.getTime())) {
    throw new AcuityApiError("request_failed", "acuityDateTime: unparseable instant");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // hourCycle h23 explicitly, NOT bare hour12:false: the latter leaves the
    // cycle locale-dependent, and an h24 locale renders midnight as "24",
    // which Acuity would read as the wrong day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset"
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const offset = offsetFromLongOffset(p.timeZoneName);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/**
 * Acuity's availability responses carry offsets WITHOUT a colon
 * (`2016-02-04T13:00:00-0800`), which is not strictly ISO 8601. V8 happens to
 * parse it; other parsers and `Temporal` do not, and depending on that
 * tolerance is how this breaks later. Normalize on the way in, and reject
 * anything unparseable rather than letting an Invalid Date propagate into a
 * booking.
 */
export function normalizeAcuityTime(raw: string): string {
  const withColon = raw.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(withColon);
  if (Number.isNaN(ms)) {
    throw new AcuityApiError("request_failed", `Acuity returned an unparseable time: ${raw}`);
  }
  return new Date(ms).toISOString();
}

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * Process-local serializer. Every Acuity call chains onto the previous one
 * and waits out the minimum interval, so a single isolate issues at most one
 * request at a time regardless of how many callers race.
 */
let requestChain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Drop cached catalog reads, so a credential rotation cannot serve a
 * catalog fetched under the old key.
 *
 * Deliberately does NOT touch `requestChain`. That chain is a concurrency
 * primitive, not a cache: replacing it with a settled promise while requests
 * are still in flight lets the next caller skip the wait entirely, and two
 * overlapping requests is precisely the burst the serializer exists to stop
 * against a per-IP rate limit. The chain needs no clearing anyway, since
 * every link resolves on its own.
 */
export function clearAcuityCaches(): void {
  appointmentTypeCache.clear();
}

/**
 * Take the next slot in the serializer. Returns the release handle, which the
 * caller MUST call once its request settles.
 *
 * The handle is returned rather than stashed in module scope on purpose: two
 * concurrent callers would otherwise overwrite each other's handle, and the
 * loser would release the wrong slot and let both requests run at once, which
 * is exactly the burst this exists to prevent.
 */
async function takeRequestSlot(): Promise<() => void> {
  const previous = requestChain;
  // Definite assignment: the Promise executor runs synchronously, so
  // `release` is always set before it is read.
  let release!: () => void;
  requestChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  await sleep(ACUITY_MIN_REQUEST_INTERVAL_MS);
  return release;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ACUITY_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new AcuityApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Acuity API timed out" : "Acuity API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }
}

export type AcuityRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Repeated keys are supported (Acuity's `ignoreAppointmentIDs[]`). */
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

function buildUrl(conn: AcuityConnectionRow, req: AcuityRequest): string {
  const url = new URL(`${conn.api_base_url}${ACUITY_API_PATH}${req.path}`);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Acuity's array params want the bracketed key repeated once per value.
      for (const v of value) url.searchParams.append(key, v);
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function authHeader(conn: AcuityConnectionRow): string {
  return `Basic ${Buffer.from(`${conn.user_id}:${conn.apiKey}`, "utf8").toString("base64")}`;
}

/** Acuity's 400 bodies: { status_code, message, error }. */
function readErrorBody(text: string): { message: string | null; error: string | null } {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    return {
      message: typeof body.message === "string" ? body.message : null,
      error: typeof body.error === "string" ? body.error : null
    };
  } catch {
    return { message: null, error: null };
  }
}

/** Acuity error codes that mean "that time is not bookable", not "broken". */
const SLOT_UNAVAILABLE_CODES = new Set([
  "not_available",
  "not_available_min_hours_in_advance",
  "not_available_max_days_in_advance",
  "reschedule_too_close",
  "reschedule_not_allowed"
]);

/**
 * Block until the fleet-wide budget admits this request, or give up.
 *
 * The budget only binds if an over-budget check actually PREVENTS the call:
 * sleeping and then issuing it anyway would leave the cap decorative and push
 * enforcement onto Acuity's 429s, which is the outcome the global bucket
 * exists to avoid. So an exhausted budget throws `rate_limited`, which
 * reaches the model as "let me check again in a moment" rather than a booking
 * failure.
 *
 * `rateLimitDurable` records a hit per check and fails open to the in-memory
 * limiter on a DB error, so a Postgres blip degrades to per-isolate limiting
 * rather than blocking every tenant's bookings.
 */
async function awaitFleetBudget(conn: AcuityConnectionRow, req: AcuityRequest): Promise<void> {
  for (let attempt = 0; attempt < ACUITY_FLEET_WAIT_ATTEMPTS; attempt += 1) {
    const limit = await rateLimitDurable("acuity:global", {
      interval: 1000,
      maxRequests: ACUITY_FLEET_BUDGET_PER_SECOND
    });
    if (limit.success) return;
    // Wait out the current window, then re-check: the bucket is fixed-window,
    // so a fresh window is what actually frees capacity.
    await sleep(Math.max(0, Math.min(1000, limit.reset - Date.now())));
  }
  await recordSystemLog({
    businessId: conn.business_id,
    source: "acuity",
    level: "warn",
    event: "acuity_fleet_budget_exhausted",
    message: `Acuity fleet budget exhausted before ${req.method} ${req.path}`,
    payload: { path: req.path, attempts: ACUITY_FLEET_WAIT_ATTEMPTS }
  });
  throw new AcuityApiError(
    "rate_limited",
    "Acuity requests are being throttled fleet-wide; try again shortly"
  );
}

/**
 * Authenticated JSON call, throttled fleet-wide then process-locally.
 *
 * A 429 gets ONE retry honoring `Retry-After` and is always logged: the
 * documented ceiling is per IP, so the real budget available to us depends on
 * how many isolates share an egress address, which we cannot see from here.
 * The log is what makes that observable instead of showing up as mysterious
 * booking failures.
 */
export async function acuityFetch(
  conn: AcuityConnectionRow,
  req: AcuityRequest,
  retrying = false
): Promise<unknown> {
  await awaitFleetBudget(conn, req);

  const release = await takeRequestSlot();
  let res: Response;
  try {
    res = await fetchWithTimeout(buildUrl(conn, req), {
      method: req.method,
      headers: {
        Authorization: authHeader(conn),
        Accept: "application/json",
        ...(req.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) })
    });
  } finally {
    release();
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "");
    await recordSystemLog({
      businessId: conn.business_id,
      source: "acuity",
      level: "warn",
      event: "acuity_rate_limited",
      message: `Acuity rate limited ${req.method} ${req.path}`,
      payload: { path: req.path, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null }
    });
    if (!retrying) {
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
      await sleep(Math.min(waitMs, 5000));
      return acuityFetch(conn, req, true);
    }
    throw new AcuityApiError("rate_limited", "Acuity API rate limit exceeded", 429);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const { message, error } = readErrorBody(text);
    logger.warn("acuity api call failed", {
      businessId: conn.business_id,
      path: req.path,
      status: res.status,
      acuityError: error,
      body: text.slice(0, 300)
    });
    // 401 is unconditional: there is no token to refresh, so a rejected
    // Basic credential means the owner's key is wrong or revoked.
    if (res.status === 401 || res.status === 403) {
      throw new AcuityApiError(
        "auth_failed",
        `Acuity rejected the stored credentials (${res.status})`,
        res.status,
        error ?? undefined
      );
    }
    if (res.status === 404) {
      throw new AcuityApiError(
        "not_found",
        `Acuity API ${req.method} ${req.path} not found`,
        404,
        error ?? undefined
      );
    }
    if (error && SLOT_UNAVAILABLE_CODES.has(error)) {
      throw new AcuityApiError(
        "slot_unavailable",
        message ?? "That time is no longer available on Acuity",
        res.status,
        error
      );
    }
    throw new AcuityApiError(
      "request_failed",
      `Acuity API ${req.method} ${req.path} failed (${res.status})`,
      res.status,
      error ?? undefined
    );
  }
  return res.json().catch(() => null);
}

// ── Typed helpers ────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function arr(payload: unknown): Array<Record<string, unknown>> {
  return Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
}

export type AcuityAppointmentType = {
  id: string;
  name: string | null;
  durationMinutes: number | null;
  /** "service" | "class" | "series"; only services are bookable in v1. */
  type: string;
  active: boolean;
  /** Staff/resource calendars this type is offered on ([] = all). */
  calendarIds: string[];
};

/**
 * Catalog cache keyed by connection row id, so a credential rotation (which
 * writes a new row) invalidates cleanly. Short TTL: appointment types change
 * rarely, but an owner adding one should not have to wait out a long cache.
 */
const APPOINTMENT_TYPE_TTL_MS = 5 * 60_000;
const appointmentTypeCache = new Map<
  string,
  { types: AcuityAppointmentType[]; expiresAtMs: number }
>();

/**
 * The merchant's appointment types. Returns ALL of them (including classes
 * and inactive ones): filtering belongs to the caller, which knows whether it
 * is resolving a bookable service or rendering the dashboard picker.
 */
export async function listAcuityAppointmentTypes(
  conn: AcuityConnectionRow
): Promise<AcuityAppointmentType[]> {
  const cached = appointmentTypeCache.get(conn.id);
  if (cached && cached.expiresAtMs > Date.now()) return cached.types;

  const payload = await acuityFetch(conn, { method: "GET", path: "/appointment-types" });
  const types: AcuityAppointmentType[] = [];
  for (const item of arr(payload)) {
    const id = str(item.id);
    if (!id) continue;
    types.push({
      id,
      name: str(item.name),
      durationMinutes: num(item.duration),
      // Acuity's discriminator; default to "service" so a payload that omits
      // it stays bookable rather than silently vanishing from the catalog.
      type: str(item.type) ?? "service",
      active: item.active !== false,
      calendarIds: Array.isArray(item.calendarIDs)
        ? (item.calendarIDs as unknown[]).map((c) => str(c)).filter((c): c is string => c !== null)
        : []
    });
  }
  appointmentTypeCache.set(conn.id, {
    types,
    expiresAtMs: Date.now() + APPOINTMENT_TYPE_TTL_MS
  });
  return types;
}

export type AcuityCalendar = {
  id: string;
  name: string | null;
  /** IANA zone; Acuity calendars can differ from the business timezone. */
  timezone: string | null;
};

export async function listAcuityCalendars(
  conn: AcuityConnectionRow
): Promise<AcuityCalendar[]> {
  const payload = await acuityFetch(conn, { method: "GET", path: "/calendars" });
  const out: AcuityCalendar[] = [];
  for (const item of arr(payload)) {
    const id = str(item.id);
    if (!id) continue;
    out.push({ id, name: str(item.name), timezone: str(item.timezone) });
  }
  return out;
}

/** Bookable dates in one month. `month` is `YYYY-MM`. */
export async function listAcuityAvailableDates(
  conn: AcuityConnectionRow,
  args: {
    month: string;
    appointmentTypeId: string;
    calendarId?: string | null;
    timezone: string;
  }
): Promise<string[]> {
  const payload = await acuityFetch(conn, {
    method: "GET",
    path: "/availability/dates",
    query: {
      month: args.month,
      appointmentTypeID: args.appointmentTypeId,
      timezone: args.timezone,
      ...(args.calendarId ? { calendarID: args.calendarId } : {})
    }
  });
  return arr(payload)
    .map((item) => str(item.date))
    .filter((d): d is string => d !== null);
}

/**
 * Bookable start times on one local date, as ISO instants.
 *
 * `ignoreAppointmentId` maps to Acuity's `ignoreAppointmentIDs[]`, which is
 * the documented way to compute availability for a RESCHEDULE: without it the
 * appointment's own slot reads as busy, so moving it by less than its own
 * duration is rejected as unavailable.
 */
export async function listAcuityAvailableTimes(
  conn: AcuityConnectionRow,
  args: {
    date: string;
    appointmentTypeId: string;
    calendarId?: string | null;
    timezone: string;
    ignoreAppointmentId?: string | null;
  }
): Promise<string[]> {
  const payload = await acuityFetch(conn, {
    method: "GET",
    path: "/availability/times",
    query: {
      date: args.date,
      appointmentTypeID: args.appointmentTypeId,
      timezone: args.timezone,
      ...(args.calendarId ? { calendarID: args.calendarId } : {}),
      ...(args.ignoreAppointmentId
        ? { "ignoreAppointmentIDs[]": [args.ignoreAppointmentId] }
        : {})
    }
  });
  const out: string[] = [];
  for (const item of arr(payload)) {
    const raw = str(item.time);
    if (!raw) continue;
    out.push(normalizeAcuityTime(raw));
  }
  return out;
}

export type AcuityAppointmentItem = {
  id: string;
  startIso: string;
  endIso: string | null;
  /** Acuity's `dateCreated`. There is NO last-modified field on the API. */
  createdIso: string | null;
  canceled: boolean;
  appointmentTypeId: string | null;
  appointmentTypeName: string | null;
  calendarId: string | null;
  calendarName: string | null;
  durationMinutes: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  notes: string | null;
  timezone: string | null;
};

/**
 * Normalize one raw Acuity appointment. Exported because the webhook receiver
 * and the poller MUST produce byte-identical events for the same appointment
 * (they share `cal:` dedupe keys), which only holds if they share this.
 *
 * Note `canceled`: the appointment object carries no such boolean. Acuity
 * signals cancellation by which listing the row came from, so callers pass it
 * in; `noShow` being present is a secondary hint used as a fallback.
 */
export function normalizeAcuityAppointment(
  item: Record<string, unknown>,
  canceledHint?: boolean
): AcuityAppointmentItem | null {
  const id = str(item.id);
  const rawStart = str(item.datetime);
  if (!id || !rawStart) return null;
  let startIso: string;
  try {
    startIso = normalizeAcuityTime(rawStart);
  } catch {
    return null;
  }
  const durationMinutes = num(item.duration);
  const rawEnd = str(item.endTime);
  let endIso: string | null = null;
  if (rawEnd) {
    // endTime is a bare wall-clock time ("14:30") on some payloads, so only
    // trust it when it parses as a full instant; otherwise derive from the
    // duration, which is always present and unambiguous.
    try {
      endIso = normalizeAcuityTime(rawEnd);
    } catch {
      endIso = null;
    }
  }
  if (!endIso && durationMinutes !== null) {
    endIso = new Date(Date.parse(startIso) + durationMinutes * 60_000).toISOString();
  }
  const createdRaw = str(item.dateCreated);
  let createdIso: string | null = null;
  if (createdRaw) {
    try {
      createdIso = normalizeAcuityTime(createdRaw);
    } catch {
      createdIso = null;
    }
  }
  const first = str(item.firstName) ?? "";
  const last = str(item.lastName) ?? "";
  const customerName = `${first} ${last}`.trim();
  return {
    id,
    startIso,
    endIso,
    createdIso,
    canceled: canceledHint ?? item.noShow !== undefined,
    appointmentTypeId: str(item.appointmentTypeID),
    appointmentTypeName: str(item.type),
    calendarId: str(item.calendarID),
    calendarName: str(item.calendar),
    durationMinutes,
    customerName: customerName.length > 0 ? customerName : null,
    customerEmail: str(item.email),
    customerPhone: str(item.phone),
    notes: str(item.notes),
    timezone: str(item.timezone)
  };
}

/**
 * List appointments in a date window. `canceled` selects WHICH listing:
 * Acuity excludes canceled appointments by default, returns only canceled
 * ones for `canceled=true`, and both for `showall=true`.
 */
export async function listAcuityAppointments(
  conn: AcuityConnectionRow,
  args: {
    minDate?: string;
    maxDate?: string;
    calendarId?: string | null;
    appointmentTypeId?: string | null;
    canceled?: boolean;
    email?: string | null;
    phone?: string | null;
    max?: number;
  }
): Promise<AcuityAppointmentItem[]> {
  const payload = await acuityFetch(conn, {
    method: "GET",
    path: "/appointments",
    query: {
      ...(args.minDate ? { minDate: args.minDate } : {}),
      ...(args.maxDate ? { maxDate: args.maxDate } : {}),
      ...(args.calendarId ? { calendarID: args.calendarId } : {}),
      ...(args.appointmentTypeId ? { appointmentTypeID: args.appointmentTypeId } : {}),
      ...(args.canceled ? { canceled: "true" } : {}),
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
      ...(args.max ? { max: String(args.max) } : {}),
      // Intake form answers are large and unused here.
      excludeForms: "true"
    }
  });
  const out: AcuityAppointmentItem[] = [];
  for (const item of arr(payload)) {
    const normalized = normalizeAcuityAppointment(item, args.canceled === true);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** One appointment by id. Null when Acuity says it does not exist. */
export async function getAcuityAppointment(
  conn: AcuityConnectionRow,
  appointmentId: string
): Promise<AcuityAppointmentItem | null> {
  try {
    const payload = await acuityFetch(conn, {
      method: "GET",
      path: `/appointments/${encodeURIComponent(appointmentId)}`
    });
    const item = payload as Record<string, unknown> | null;
    if (!item) return null;
    // A single fetch DOES carry cancellation state via `canceled`; fall back
    // to the shared normalizer's noShow heuristic when it is absent.
    const canceledFlag = typeof item.canceled === "boolean" ? item.canceled : undefined;
    return normalizeAcuityAppointment(item, canceledFlag);
  } catch (err) {
    if (err instanceof AcuityApiError && err.code === "not_found") return null;
    throw err;
  }
}

export type CreateAcuityAppointmentInput = {
  datetime: string;
  appointmentTypeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  timezone: string;
  calendarId?: string | null;
  notes?: string | null;
  /** Skips availability validation; REQUIRES a calendarId and allows notes. */
  admin: boolean;
  /** Suppress Acuity's own confirmation email/SMS. */
  noEmail: boolean;
};

/** Create an appointment on the merchant's Acuity book. */
export async function createAcuityAppointment(
  conn: AcuityConnectionRow,
  input: CreateAcuityAppointmentInput
): Promise<AcuityAppointmentItem | null> {
  const payload = await acuityFetch(conn, {
    method: "POST",
    path: "/appointments",
    query: {
      ...(input.admin ? { admin: "true" } : {}),
      ...(input.noEmail ? { noEmail: "true" } : {})
    },
    body: {
      datetime: input.datetime,
      appointmentTypeID: input.appointmentTypeId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      timezone: input.timezone,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.calendarId ? { calendarID: input.calendarId } : {}),
      // notes is admin-only; sending it in client mode is a 400.
      ...(input.admin && input.notes ? { notes: input.notes } : {})
    }
  });
  const item = payload as Record<string, unknown> | null;
  return item ? normalizeAcuityAppointment(item, false) : null;
}

/**
 * Move an appointment to a new time IN PLACE. `calendarId` omitted keeps the
 * original calendar (Acuity treats an explicit null as "auto-select"), which
 * is what we want: a reschedule should not silently reassign staff.
 *
 * `admin` waives Acuity's own availability validation, so it is only safe
 * when the caller has ALREADY verified the target against an ignore-aware
 * availability read. A caller that could not run that check must pass
 * `admin: false` and let Acuity be the one to refuse.
 */
export async function rescheduleAcuityAppointmentTime(
  conn: AcuityConnectionRow,
  appointmentId: string,
  args: {
    datetime: string;
    timezone: string;
    calendarId?: string | null;
    admin: boolean;
    noEmail: boolean;
  }
): Promise<AcuityAppointmentItem | null> {
  const payload = await acuityFetch(conn, {
    method: "PUT",
    path: `/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    query: {
      ...(args.admin ? { admin: "true" } : {}),
      ...(args.noEmail ? { noEmail: "true" } : {})
    },
    body: {
      datetime: args.datetime,
      timezone: args.timezone,
      ...(args.calendarId ? { calendarID: args.calendarId } : {})
    }
  });
  const item = payload as Record<string, unknown> | null;
  return item ? normalizeAcuityAppointment(item, false) : null;
}

/**
 * Cancel an appointment. IRREVERSIBLE on Acuity's side: a canceled
 * appointment gains a `noShow` attribute and can never be un-canceled, which
 * is why the calendar-tool layer verifies the target against the booking
 * ledger before ever calling this.
 */
export async function cancelAcuityAppointmentById(
  conn: AcuityConnectionRow,
  appointmentId: string,
  args: { noEmail: boolean }
): Promise<void> {
  await acuityFetch(conn, {
    method: "PUT",
    path: `/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    query: {
      admin: "true",
      ...(args.noEmail ? { noEmail: "true" } : {})
    },
    body: {}
  });
}

export type AcuityAccount = { id: string | null; email: string | null; timezone: string | null };

/** Connect-time credential check. Throws `auth_failed` on a bad key. */
export async function verifyAcuityCredentials(
  conn: AcuityConnectionRow
): Promise<AcuityAccount> {
  const payload = await acuityFetch(conn, { method: "GET", path: "/me" });
  const body = (payload ?? {}) as Record<string, unknown>;
  return {
    id: str(body.id),
    email: str(body.email),
    timezone: str(body.timezone)
  };
}

// ── Dynamic webhooks ─────────────────────────────────────────────────────────

/** The appointment events we consume. Acuity also emits `order.completed`. */
export const ACUITY_WEBHOOK_EVENTS = [
  "appointment.scheduled",
  "appointment.rescheduled",
  "appointment.canceled",
  "appointment.changed"
] as const;

export type AcuityWebhookEventName = (typeof ACUITY_WEBHOOK_EVENTS)[number];

export type AcuityWebhookRecord = { id: string; event: string; target: string | null };

export async function listAcuityWebhooks(
  conn: AcuityConnectionRow
): Promise<AcuityWebhookRecord[]> {
  const payload = await acuityFetch(conn, { method: "GET", path: "/webhooks" });
  const out: AcuityWebhookRecord[] = [];
  for (const item of arr(payload)) {
    const id = str(item.id);
    const event = str(item.event);
    if (!id || !event) continue;
    out.push({ id, event, target: str(item.target) });
  }
  return out;
}

export async function createAcuityWebhook(
  conn: AcuityConnectionRow,
  event: AcuityWebhookEventName,
  target: string
): Promise<AcuityWebhookRecord | null> {
  const payload = await acuityFetch(conn, {
    method: "POST",
    path: "/webhooks",
    body: { event, target }
  });
  const item = payload as Record<string, unknown> | null;
  const id = str(item?.id);
  return id ? { id, event, target } : null;
}

export async function deleteAcuityWebhook(
  conn: AcuityConnectionRow,
  webhookId: string
): Promise<void> {
  await acuityFetch(conn, {
    method: "DELETE",
    path: `/webhooks/${encodeURIComponent(webhookId)}`
  });
}

/**
 * Verify an inbound webhook. Acuity computes a base64 HMAC-SHA256 over the
 * RAW request body with the account's API key as the shared secret.
 *
 * The caller must pass the body exactly as received: re-serializing a parsed
 * form does not byte-match (key order and percent-encoding differ), so the
 * route reads `await request.text()` before anything else touches the stream.
 */
export function verifyAcuityWebhookSignature(
  rawBody: string,
  presentedSignature: string | null,
  apiKey: string
): boolean {
  if (!presentedSignature) return false;
  const expected = createHmac("sha256", apiKey).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(presentedSignature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
