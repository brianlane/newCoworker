/**
 * Birthday trigger — pure due-check helpers.
 *
 * The worker's cron tick sweeps enabled birthday flows: a contact whose
 * stored birthday (contacts.birthday, a DATE) is "today" in the trigger's
 * timezone fires once per year, at/after the trigger's local send time
 * (default 09:00). Exactly-once via the run dedupe key
 * `bday:<contactId>:<year>` (unique per flow).
 *
 * All pure (no IO) so the sweep's decisions are unit-tested; the worker owns
 * the queries.
 */

/** Default local send time when the trigger omits one. */
export const BIRTHDAY_DEFAULT_TIME = "09:00";

/** Local {year, month, day, minutes} in a zone (fails open to UTC on junk). */
function localParts(
  nowMs: number,
  timezone: string
): { year: number; month: number; day: number; minutesOfDay: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23"
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23"
    });
  }
  const parts = new Map(fmt.formatToParts(nowMs).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    minutesOfDay: Number(parts.get("hour")) * 60 + Number(parts.get("minute"))
  };
}

/** Parse a DATE column value ("1990-02-14") into month/day/year, or null. */
export function parseBirthday(
  raw: string | null | undefined
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((raw ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: Number(y), month, day };
}

/**
 * Is a birthday flow due for this contact right now? True when the local
 * date matches the stored month/day (Feb 29 birthdays fire on Mar 1 in
 * non-leap years) and the local time has reached the trigger's send time.
 */
export function birthdayDue(
  birthdayRaw: string | null | undefined,
  nowMs: number,
  timezone: string,
  time: string = BIRTHDAY_DEFAULT_TIME
): boolean {
  const bday = parseBirthday(birthdayRaw);
  if (!bday) return false;
  const local = localParts(nowMs, timezone);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  const sendMinutes = timeMatch
    ? Number(timeMatch[1]) * 60 + Number(timeMatch[2])
    : 9 * 60;
  if (local.minutesOfDay < sendMinutes) return false;
  if (bday.month === local.month && bday.day === local.day) return true;
  // Feb 29 → Mar 1 in non-leap years.
  if (bday.month === 2 && bday.day === 29 && local.month === 3 && local.day === 1) {
    const y = local.year;
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return !isLeap;
  }
  return false;
}

/** Exactly-once key: one firing per contact per (local) year, per flow. */
export function birthdayDedupeKey(contactId: string, localYear: number): string {
  return `bday:${contactId}:${localYear}`;
}

/** The contact's age turning today, or null when the birth year is a placeholder. */
export function contactAge(
  birthdayRaw: string | null | undefined,
  localYear: number
): number | null {
  const bday = parseBirthday(birthdayRaw);
  if (!bday) return null;
  const age = localYear - bday.year;
  return age > 0 && age < 130 ? age : null;
}

/** The local year in a zone (drives the dedupe key). */
export function localYearIn(nowMs: number, timezone: string): number {
  return localParts(nowMs, timezone).year;
}
