/**
 * Human text ⇄ weekly-windows JSON for the Employees page.
 *
 * Owners type compact schedules like:
 *
 *   "mon-fri 09:00-17:00"
 *   "mon,wed 9:00-12:00; sat 10:00-14:00, 15:00-17:00"
 *
 * and we store the canonical jsonb shape the routing engine reads
 * (`{"mon":[["09:00","17:00"]]}` — see parseWeeklyWindows in
 * supabase/functions/_shared/ai_flows/engine.ts). Parsing is strict so a
 * typo'd schedule errors in the form instead of silently making an employee
 * unavailable; formatting groups consecutive days that share identical
 * windows back into ranges.
 */

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Monday-first: how humans write schedules (engine keys are identical). */
export const DAY_ORDER: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type WeeklyWindowsJson = Partial<Record<DayKey, [string, string][]>>;

export type ParseResult =
  | { ok: true; value: WeeklyWindowsJson | null }
  | { ok: false; error: string };

const DAY_ALIASES: Record<string, DayKey> = {
  mon: "mon", monday: "mon",
  tue: "tue", tues: "tue", tuesday: "tue",
  wed: "wed", wednesday: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
  fri: "fri", friday: "fri",
  sat: "sat", saturday: "sat",
  sun: "sun", sunday: "sun"
};

function dayFromToken(token: string): DayKey | null {
  return DAY_ALIASES[token.toLowerCase()] ?? null;
}

/** "9:00" / "09:00" → zero-padded "09:00", or null when malformed/out of range. */
function normalizeHm(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** Expand a day token ("wed") or inclusive range ("mon-fri") into day keys. */
function expandDays(spec: string): DayKey[] | null {
  const out: DayKey[] = [];
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) return null;
    const range = token.split("-");
    if (range.length === 1) {
      const day = dayFromToken(range[0]);
      if (!day) return null;
      out.push(day);
      continue;
    }
    if (range.length !== 2) return null;
    const start = dayFromToken(range[0].trim());
    const end = dayFromToken(range[1].trim());
    if (!start || !end) return null;
    const si = DAY_ORDER.indexOf(start);
    const ei = DAY_ORDER.indexOf(end);
    if (ei < si) return null;
    out.push(...DAY_ORDER.slice(si, ei + 1));
  }
  return out;
}

/**
 * Parse schedule text into the stored JSON shape. Empty/blank input is valid
 * and means "no schedule" (null). Errors carry the offending fragment so the
 * form can show exactly what to fix.
 */
export function parseScheduleText(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };

  const value: WeeklyWindowsJson = {};
  for (const rawGroup of trimmed.split(";")) {
    const group = rawGroup.trim();
    if (!group) continue;
    const spaceAt = group.search(/\s/);
    if (spaceAt === -1) {
      return { ok: false, error: `"${group}" needs days and hours, e.g. "mon-fri 09:00-17:00"` };
    }
    const daySpec = group.slice(0, spaceAt);
    const days = expandDays(daySpec);
    if (!days) {
      return { ok: false, error: `"${daySpec}" is not a day or day range (use mon, tue, … or mon-fri)` };
    }
    const windows: [string, string][] = [];
    for (const rawWindow of group.slice(spaceAt + 1).split(",")) {
      const windowText = rawWindow.trim();
      const parts = windowText.split("-");
      const start = parts.length === 2 ? normalizeHm(parts[0]) : null;
      const end = parts.length === 2 ? normalizeHm(parts[1]) : null;
      if (!start || !end) {
        return { ok: false, error: `"${windowText}" is not a time window (use HH:MM-HH:MM, e.g. 09:00-17:00)` };
      }
      // end < start is a valid OVERNIGHT window ("18:00-02:00" — the engine
      // splits it across midnight); only a zero-length window is an error.
      if (end === start) {
        return { ok: false, error: `"${windowText}" starts and ends at the same time` };
      }
      windows.push([start, end]);
    }
    for (const day of days) {
      value[day] = [...(value[day] ?? []), ...windows];
    }
  }
  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}

/**
 * Validate an arbitrary stored jsonb value into the canonical JSON shape.
 * Mirrors the engine's tolerance: malformed entries are dropped; null when
 * nothing valid remains. Used to round-trip DB → form text safely.
 */
export function normalizeWeeklyWindowsJson(raw: unknown): WeeklyWindowsJson | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: WeeklyWindowsJson = {};
  for (const day of DAY_ORDER) {
    const windows = (raw as Record<string, unknown>)[day];
    if (!Array.isArray(windows)) continue;
    const parsed: [string, string][] = [];
    for (const w of windows) {
      if (!Array.isArray(w) || w.length !== 2) continue;
      if (typeof w[0] !== "string" || typeof w[1] !== "string") continue;
      const start = normalizeHm(w[0]);
      const end = normalizeHm(w[1]);
      // end < start is a stored overnight window; only zero-length is invalid.
      if (!start || !end || end === start) continue;
      parsed.push([start, end]);
    }
    if (parsed.length > 0) out[day] = parsed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Render stored windows back to the compact text form, grouping consecutive
 * days with identical windows ("mon-fri 09:00-17:00"). Inverse of
 * parseScheduleText up to canonicalization; invalid/empty input renders "".
 */
export function formatScheduleText(raw: unknown): string {
  const value = normalizeWeeklyWindowsJson(raw);
  if (!value) return "";

  const windowsKey = (day: DayKey): string =>
    JSON.stringify(value[day] ?? null);

  const groups: string[] = [];
  let i = 0;
  while (i < DAY_ORDER.length) {
    const day = DAY_ORDER[i];
    if (!value[day]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < DAY_ORDER.length && windowsKey(DAY_ORDER[j + 1]) === windowsKey(day)) {
      j += 1;
    }
    const daysLabel = j === i ? day : `${day}-${DAY_ORDER[j]}`;
    const windowsLabel = (value[day] as [string, string][])
      .map(([s, e]) => `${s}-${e}`)
      .join(", ");
    groups.push(`${daysLabel} ${windowsLabel}`);
    i = j + 1;
  }
  return groups.join("; ");
}
