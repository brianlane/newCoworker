/**
 * Calendar business-day math (Mon–Fri), using UTC date parts so unit tests
 * and the daily intro-nudge sweep stay deterministic across host timezones.
 *
 * Weekends are skipped; holidays are not (there is no holiday calendar here).
 */

function utcDayOfWeek(d: Date): number {
  return d.getUTCDay();
}

function isUtcWeekend(d: Date): boolean {
  const day = utcDayOfWeek(d);
  return day === 0 || day === 6;
}

/** Clone `from` and walk forward `n` weekdays (n >= 0). */
export function addBusinessDays(from: Date, n: number): Date {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`addBusinessDays: n must be a non-negative integer, got ${n}`);
  }
  const d = new Date(from.getTime());
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isUtcWeekend(d)) remaining -= 1;
  }
  return d;
}

/** Clone `from` and walk backward `n` weekdays (n >= 0). */
export function subtractBusinessDays(from: Date, n: number): Date {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`subtractBusinessDays: n must be a non-negative integer, got ${n}`);
  }
  const d = new Date(from.getTime());
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!isUtcWeekend(d)) remaining -= 1;
  }
  return d;
}
