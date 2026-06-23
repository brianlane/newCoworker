/**
 * AiFlows pure engine: trigger evaluation, template rendering, and
 * field-extraction helpers. Dependency-free so it runs identically in the Deno
 * ai-flow-worker and the telnyx-sms-inbound trigger hook, and is fully unit
 * tested (counts toward the _shared coverage gate).
 *
 * Everything here is PURE (no IO). Network/DB effects live in the worker
 * (supabase/functions/ai-flow-worker/index.ts), which calls these helpers to
 * decide what to do and to transform fetched page text.
 */
import { AI_FLOW_DEFINITION_VERSION } from "./types.ts";
import type {
  AiFlowDefinition,
  CorrelationMessage,
  SmsTrigger,
  StepCondition,
  TriggerCondition,
  TriggerContext,
  TriggerResult
} from "./types.ts";

export const DEFAULT_CORRELATION_WINDOW_MINUTES = 10;

const URL_RE = /https?:\/\/[^\s<>"')]+/i;
const URL_RE_GLOBAL = /https?:\/\/[^\s<>"')]+/gi;

/** First http(s) URL in a string, or null. Trailing punctuation is trimmed. */
export function firstUrlInText(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return trimUrlPunctuation(m[0]);
}

/** All http(s) URLs in a string (de-duplicated, order preserved). */
export function allUrlsInText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(URL_RE_GLOBAL) ?? [];
  for (const raw of matches) {
    const u = trimUrlPunctuation(raw);
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** Strip common trailing punctuation that gets glued onto URLs in prose. */
function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/** Case-control substring test. */
function textContains(haystack: string, needle: string, caseInsensitive?: boolean): boolean {
  if (caseInsensitive === false) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Safe regex test — an invalid pattern never throws, it just fails to match. */
export function safeRegexTest(pattern: string, value: string, caseInsensitive?: boolean): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive === false ? "" : "i");
  } catch {
    return false;
  }
  return re.test(value);
}

/**
 * Messages within the correlation window (>= now - windowMinutes), oldest
 * first. Messages with an atMs in the future relative to `nowMs` are kept
 * (clock skew tolerance); only those strictly older than the window are dropped.
 */
export function messagesInWindow(ctx: TriggerContext, windowMinutes: number): CorrelationMessage[] {
  const now = ctx.nowMs ?? Date.now();
  const cutoff = now - Math.max(0, windowMinutes) * 60_000;
  return ctx.messages.filter((m) => m.atMs >= cutoff);
}

/** Evaluate one condition against the combined window text + latest sender. */
function evaluateCondition(
  cond: TriggerCondition,
  windowText: string,
  latestFrom: string
): boolean {
  switch (cond.type) {
    case "contains":
      return textContains(windowText, cond.value, cond.caseInsensitive);
    case "regex":
      return safeRegexTest(cond.value, windowText, cond.caseInsensitive);
    case "has_url":
      return firstUrlInText(windowText) !== null;
    case "from_matches":
      return textContains(latestFrom, cond.value, cond.caseInsensitive);
    /* c8 ignore next 2 -- exhaustive switch; unreachable for valid conditions */
    default:
      return false;
  }
}

/**
 * Evaluate an SMS trigger over the correlation window. Returns matched +
 * windowText + first URL. All conditions must pass (AND). An empty condition
 * list matches any inbound SMS.
 */
export function evaluateSmsTrigger(trigger: SmsTrigger, ctx: TriggerContext): TriggerResult {
  const windowMinutes = trigger.correlationWindowMinutes ?? DEFAULT_CORRELATION_WINDOW_MINUTES;
  const inWindow = messagesInWindow(ctx, windowMinutes);
  const windowText = inWindow.map((m) => m.text).join("\n");
  const latestFrom = inWindow.length > 0 ? inWindow[inWindow.length - 1].from : "";
  const url = firstUrlInText(windowText);
  const matched = trigger.conditions.every((c) => evaluateCondition(c, windowText, latestFrom));
  return { matched, windowText, url };
}

// --- Template rendering ------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Resolve a dotted path (e.g. "vars.seller_phone") against a scope object. */
export function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Replace {{path}} placeholders in a template string with values from `scope`.
 * Missing/object/null values render as the empty string so a half-populated
 * context never injects "undefined" or "[object Object]" into an outbound SMS.
 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_full, path: string) => {
    const v = resolvePath(scope, path);
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  });
}

/**
 * Evaluate a per-step `when` guard against the run vars. Returns true when the
 * step should RUN. `equals` is a whole-value match, `contains` is a substring,
 * `notEquals` is the inverse of `equals`; all are case-insensitive unless
 * `caseInsensitive === false` (so two steps gated on `equals X` / `notEquals X`
 * form an exhaustive either/or branch). String values
 * are trimmed first, since LLM-extracted vars often carry surrounding whitespace
 * or newlines that would otherwise make an `equals` guard silently miss. A
 * missing / non-scalar var resolves to "" so an absent value never accidentally
 * matches a non-empty needle (and a `notEquals` against a present needle then
 * passes, since "" differs from it). When none of `equals`/`contains`/`notEquals`
 * is set (the schema normally forbids this), the guard is a presence check: pass
 * iff the var is non-empty.
 */
export function evaluateStepCondition(
  cond: StepCondition,
  scope: { vars?: Record<string, unknown> }
): boolean {
  const raw = scope.vars?.[cond.var];
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : "";
  const ci = cond.caseInsensitive !== false;
  const hay = ci ? value.toLowerCase() : value;
  if (cond.equals !== undefined) {
    return hay === (ci ? cond.equals.toLowerCase() : cond.equals);
  }
  if (cond.contains !== undefined) {
    return hay.includes(ci ? cond.contains.toLowerCase() : cond.contains);
  }
  if (cond.notEquals !== undefined) {
    return hay !== (ci ? cond.notEquals.toLowerCase() : cond.notEquals);
  }
  return value.length > 0;
}

/** True when a template still has unresolved placeholders against `scope`. */
export function hasUnresolvedPlaceholders(template: string, scope: Record<string, unknown>): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const v = resolvePath(scope, m[1]);
    if (v === null || v === undefined || v === "") return true;
  }
  return false;
}

// --- Phone / field extraction ------------------------------------------------

const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

/**
 * Normalize a loose North-American phone string to E.164 (+1XXXXXXXXXX), or
 * null if it is not a plausible 10-digit (optionally +1) number.
 */
export function normalizeNanpToE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Extract candidate phone numbers from free text as E.164 (deduped, in order). */
export function extractPhones(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(PHONE_RE) ?? [];
  for (const raw of matches) {
    const e164 = normalizeNanpToE164(raw);
    /* c8 ignore next -- PHONE_RE only matches 10/11-digit numbers, which always normalize */
    if (!e164) continue;
    if (seen.has(e164)) continue;
    seen.add(e164);
    out.push(e164);
  }
  return out;
}

// Conventional variable keys an extraction step might capture a lead's name /
// email under, in priority order (specific keys first; the bare "name"/"email"
// fall back last so a generic var doesn't beat a purpose-named one). Lets the
// worker enrich a customer from ANY flow that captured the info, without every
// flow having to use the exact `lead_name`/`lead_email` keys.
const LEAD_NAME_KEYS = [
  "lead_name",
  "lead_full_name",
  "full_name",
  "contact_name",
  "seller_name",
  "buyer_name",
  "customer_name",
  "lead_first_name",
  "seller_first_name",
  "buyer_first_name",
  "first_name",
  "name"
] as const;

const LEAD_EMAIL_KEYS = [
  "lead_email",
  "contact_email",
  "seller_email",
  "buyer_email",
  "customer_email",
  "email"
] as const;

export type LeadIdentity = { name: string | null; email: string | null };

/** First non-empty trimmed string value among `keys`, or null. */
function firstStringValue(
  vars: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = vars[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Pull a lead's display name + email out of a flow's extracted vars, scanning a
 * prioritized set of conventional keys so enrichment works regardless of which
 * key a particular flow used (e.g. `seller_first_name` vs `lead_name`). Name is
 * trimmed; email is trimmed + lowercased. Missing/blank/non-string values yield
 * null.
 */
export function extractLeadIdentity(vars: Record<string, unknown>): LeadIdentity {
  const email = firstStringValue(vars, LEAD_EMAIL_KEYS);
  return {
    name: firstStringValue(vars, LEAD_NAME_KEYS),
    email: email ? email.toLowerCase() : null
  };
}

/**
 * Build the Gemini extraction prompt: ask for a strict JSON object with exactly
 * the requested field names, from the provided page text. Page text is truncated
 * to keep the prompt bounded.
 */
export function buildExtractionPrompt(
  fields: { name: string; description?: string }[],
  pageText: string,
  maxChars = 12_000
): string {
  const fieldLines = fields
    .map((f) => `- ${f.name}${f.description ? `: ${f.description}` : ""}`)
    .join("\n");
  const clipped = pageText.length > maxChars ? pageText.slice(0, maxChars) : pageText;
  return [
    "Extract the following fields from the web page content below.",
    "Return ONLY a JSON object whose keys are exactly these field names.",
    'If a field is not present, use an empty string "". Do not invent values.',
    "",
    "Fields:",
    fieldLines,
    "",
    "Page content:",
    clipped
  ].join("\n");
}

/**
 * Parse a Gemini extraction response into a flat string map limited to the
 * declared field names. Tolerates fenced code blocks and surrounding prose by
 * scanning for the first JSON object. Unknown keys are dropped; missing keys
 * become "". Never throws.
 */
export function parseExtractionJson(
  raw: string,
  fields: { name: string }[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of fields) result[f.name] = "";
  const obj = extractFirstJsonObject(raw);
  if (!obj) return result;
  for (const f of fields) {
    const v = obj[f.name];
    if (typeof v === "string") result[f.name] = v;
    else if (typeof v === "number" || typeof v === "boolean") result[f.name] = String(v);
  }
  return result;
}

export type RoutedAgent = { name: string; phone: string };

/** True for a syntactically valid E.164 number (+ then 7-15 digits, no leading 0). */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

/**
 * Parse Rowboat's next-agent reply for a `route_to_team` step. Rowboat is asked
 * to answer with ONLY `{"name","phone"}` for the next agent to offer, or
 * `{"none":true}` when the roster is exhausted. Tolerates fenced code blocks /
 * surrounding prose (scans for the first JSON object) and accepts either an
 * already-E.164 phone or a loose North-American number. Returns null when the
 * reply signals "none", is unparseable, or lacks a usable phone — the worker
 * treats null as "no agent available" and falls back to the owner.
 */
export function parseRoutedAgent(raw: string): RoutedAgent | null {
  const obj = extractFirstJsonObject(raw);
  if (!obj) return null;
  if (obj.none === true) return null;
  const phoneRaw = typeof obj.phone === "string" ? obj.phone.trim() : "";
  if (!phoneRaw) return null;
  const phone = isE164(phoneRaw) ? phoneRaw : normalizeNanpToE164(phoneRaw);
  if (!phone) return null;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  return { name, phone };
}

/** A persisted `ai_flow_team_members` roster row, as the worker selects from it. */
export type RosterMember = { name: string; phone: string };

/**
 * Deterministic `route_to_team` selection from a persisted roster. `members`
 * must already be in rotation-priority order (least recently offered first —
 * the worker's SQL orders by `last_offered_at` nulls-first). Picks the first
 * member whose phone normalizes to E.164, isn't in `tried`, and isn't the
 * lead's own phone (a corrupt roster row must never text the lead an offer).
 *
 * Returns the member's index (so the caller can stamp that row's rotation
 * cursor) plus the normalized agent, or null when the roster is exhausted.
 *
 * This replaces the LLM in the selection hot path: Rowboat's stateless chat
 * cannot track "least recently received a lead" across runs, and an LLM pick
 * is only as trustworthy as its grounding. A table scan is both.
 */
export function pickRosterAgent(
  members: RosterMember[],
  tried: string[],
  leadPhone?: string | null
): { index: number; agent: RoutedAgent } | null {
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const phone = isE164(m.phone) ? m.phone : normalizeNanpToE164(m.phone);
    if (!phone) continue;
    if (tried.includes(phone)) continue;
    if (leadPhone && phone === leadPhone) continue;
    return { index: i, agent: { name: m.name, phone } };
  }
  return null;
}

// --- Employee availability (route_to_team working-info rules) -----------------
//
// Pure evaluation of `ai_flow_team_members.weekly_schedule` /
// `.preferred_windows` and `employee_time_off` against a business-local
// clock. The worker fetches the rows; everything date/time lives here so it
// is unit-testable and identical across Deno/Node.

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAY_KEYS)[number];

/** Business-local "now": calendar date, weekday key, and minutes since midnight. */
export type LocalClock = { isoDate: string; weekday: Weekday; minutes: number };

/**
 * Resolve `now` into the business-local calendar clock. Invalid/missing
 * timezone falls back to UTC — same forgiving posture as currentDateTimeLine,
 * because a typo'd timezone must never stop lead routing.
 */
export function localClock(now: Date, timeZone?: string | null): LocalClock {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone && timeZone.trim() ? timeZone.trim() : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short"
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short"
    });
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  // hour12:false can render midnight as "24" in some engines; normalize.
  const hour = Number(parts.hour) % 24;
  const weekday = parts.weekday.slice(0, 3).toLowerCase() as Weekday;
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    minutes: hour * 60 + Number(parts.minute)
  };
}

/** A single calendar day's parts, in the business timezone, for templates. */
export type NowDateParts = {
  /** Full weekday name, e.g. "Thursday". */
  weekday: string;
  /** Full month name, e.g. "June". */
  month: string;
  /** Zero-padded month number, e.g. "06". */
  monthNum: string;
  /** Day of month with no leading zero, e.g. "18". */
  day: string;
  /** Day of month with English ordinal suffix, e.g. "18th". */
  dayOrdinal: string;
  /** Four-digit year, e.g. "2026". */
  year: string;
  /** ISO date, e.g. "2026-06-18". */
  iso: string;
};

/**
 * Relative-date tokens injected into the step scope as `{{now.*}}` so a flow can
 * template human dates (e.g. a Clever "tomorrow afternoon" follow-up) without
 * the engine hard-coding any portal's label format. Computed in the business
 * timezone. Today/tomorrow expose the same parts; `afternoonTime` is a 24h
 * "HH:MM" convenience constant a flow can pair with a date.
 */
export type NowScope = {
  today: NowDateParts;
  tomorrow: NowDateParts;
  /** Seven days out, for a weekly follow-up (e.g. a Clever "follow up in 7 days"). */
  in7Days: NowDateParts;
  /** A canonical afternoon time, 24h "HH:MM". */
  afternoonTime: string;
};

/** English ordinal suffix: 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

/** Date parts for `d` rendered in `timeZone` (falls open to UTC on a bad zone). */
function datePartsInZone(d: Date, timeZone: string): NowDateParts {
  const make = (zone: string): NowDateParts => {
    const dmy = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long"
    });
    const monthLongFmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long" });
    const parts: Record<string, string> = {};
    for (const p of dmy.formatToParts(d)) parts[p.type] = p.value;
    const dayNum = Number(parts.day);
    return {
      weekday: parts.weekday,
      month: monthLongFmt.format(d),
      monthNum: parts.month,
      day: String(dayNum),
      dayOrdinal: ordinal(dayNum),
      year: parts.year,
      iso: `${parts.year}-${parts.month}-${parts.day}`
    };
  };
  try {
    return make(timeZone);
  } catch {
    return make("UTC");
  }
}

/**
 * Build the `{{now.*}}` scope at `nowMs`, in the business timezone. Tomorrow is
 * "now + 24h" formatted in-zone, which lands on the next calendar day in every
 * case except the rare instant a DST jump straddles local midnight — acceptable
 * for day-granularity follow-up scheduling.
 */
export function buildNowScope(nowMs: number, timeZone?: string | null): NowScope {
  const tz = timeZone && timeZone.trim() ? timeZone.trim() : "UTC";
  const DAY_MS = 24 * 60 * 60 * 1000;
  return {
    today: datePartsInZone(new Date(nowMs), tz),
    tomorrow: datePartsInZone(new Date(nowMs + DAY_MS), tz),
    in7Days: datePartsInZone(new Date(nowMs + 7 * DAY_MS), tz),
    afternoonTime: "14:00"
  };
}

/** Per-weekday minute windows, e.g. { mon: [[540, 1020]] } for 09:00–17:00. */
export type WeeklyWindows = Partial<Record<Weekday, [number, number][]>>;

/** "HH:MM" → minutes since midnight, or null when malformed/out of range. */
export function parseHmToMinutes(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Validate a stored weekly-windows jsonb value (shape
 * `{"mon":[["09:00","17:00"]]}`) into minute windows. Malformed entries are
 * dropped (an owner typo narrows availability rather than crashing routing);
 * returns null when nothing valid remains, which callers treat as "unset".
 */
export function parseWeeklyWindows(raw: unknown): WeeklyWindows | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: WeeklyWindows = {};
  let any = false;
  for (const day of WEEKDAY_KEYS) {
    const windows = (raw as Record<string, unknown>)[day];
    if (!Array.isArray(windows)) continue;
    const parsed: [number, number][] = [];
    for (const w of windows) {
      if (!Array.isArray(w) || w.length !== 2) continue;
      if (typeof w[0] !== "string" || typeof w[1] !== "string") continue;
      const start = parseHmToMinutes(w[0]);
      const end = parseHmToMinutes(w[1]);
      if (start === null || end === null || end <= start) continue;
      parsed.push([start, end]);
    }
    if (parsed.length > 0) {
      out[day] = parsed;
      any = true;
    }
  }
  return any ? out : null;
}

/** True when the clock falls inside any window for its weekday (start inclusive, end exclusive). */
export function isWithinWeeklyWindows(windows: WeeklyWindows, clock: LocalClock): boolean {
  const dayWindows = windows[clock.weekday];
  if (!dayWindows) return false;
  return dayWindows.some(([start, end]) => clock.minutes >= start && clock.minutes < end);
}

/** Roster row shape the availability filter needs (worker passes DB rows through). */
export type AvailabilityInput = {
  id: string;
  weekly_schedule?: unknown;
  preferred_windows?: unknown;
};

/**
 * Apply the working-info rules to a rotation-ordered roster:
 *   1. members in `offIds` (time off covering today) are dropped — hard skip;
 *   2. members with a valid weekly_schedule are dropped when the clock is
 *      outside it — hard skip (no schedule = always available);
 *   3. members currently inside a preferred window float to the front,
 *      otherwise relative rotation order is preserved — soft priority only,
 *      so a lead is never dropped because nobody "prefers" the current hour.
 */
export function filterRosterByAvailability<T extends AvailabilityInput>(
  roster: T[],
  offIds: ReadonlySet<string>,
  clock: LocalClock
): T[] {
  const available = roster.filter((m) => {
    if (offIds.has(m.id)) return false;
    const schedule = parseWeeklyWindows(m.weekly_schedule);
    if (schedule && !isWithinWeeklyWindows(schedule, clock)) return false;
    return true;
  });
  const preferredNow = (m: T): boolean => {
    const preferred = parseWeeklyWindows(m.preferred_windows);
    return preferred !== null && isWithinWeeklyWindows(preferred, clock);
  };
  return [...available.filter(preferredNow), ...available.filter((m) => !preferredNow(m))];
}

/** Find and parse the first balanced JSON object in a string. Null on failure. */
function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // A balanced `{...}` slice parses to a plain object or throws, so no
        // array/non-object guard is needed past the catch.
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Collapse fetched HTML/markup to readable text for extraction: strip script /
 * style blocks and tags, decode a few common entities, and squeeze whitespace.
 * Deliberately simple (no DOM) — good enough to feed an LLM or a phone regex.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Decode &amp; LAST so a sequence like "&amp;lt;" does not get
    // double-unescaped into "<" (CodeQL js/double-escaping).
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runtime guard the worker runs before executing a stored definition (the rich
 * authoring validation lives in src/lib/ai-flows/schema.ts). Confirms the basic
 * shape so a corrupt/legacy row fails fast as `failed` rather than throwing deep
 * in a step.
 */
export function isExecutableDefinition(def: unknown): def is AiFlowDefinition {
  if (!def || typeof def !== "object") return false;
  const d = def as Record<string, unknown>;
  if (d.version !== AI_FLOW_DEFINITION_VERSION) return false;
  const trigger = d.trigger as Record<string, unknown> | undefined;
  if (!trigger) return false;
  switch (trigger.channel) {
    case "sms":
      if (!Array.isArray(trigger.conditions)) return false;
      break;
    case "email":
      if (typeof trigger.connectionId !== "string" || !Array.isArray(trigger.conditions)) {
        return false;
      }
      break;
    case "tenant_email":
      // The dedicated AI mailbox: push-triggered, so no connectionId — just
      // the AND-ed condition list (which may be empty = match every email).
      if (!Array.isArray(trigger.conditions)) return false;
      break;
    case "schedule": {
      const daily = typeof trigger.time === "string" && typeof trigger.timezone === "string";
      const interval = typeof trigger.everyMinutes === "number";
      if (daily === interval) return false; // exactly one mode
      break;
    }
    case "manual":
      break;
    default:
      return false;
  }
  if (!Array.isArray(d.steps)) return false;
  for (const s of d.steps) {
    if (!s || typeof s !== "object") return false;
    const step = s as Record<string, unknown>;
    if (typeof step.type !== "string" || typeof step.id !== "string") return false;
  }
  return true;
}
