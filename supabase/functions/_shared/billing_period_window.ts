/**
 * Monthly usage-quota windows within a (possibly multi-month) Stripe billing
 * period.
 *
 * Background: 12/24-month plans are charged IN FULL at checkout, so the Stripe
 * subscription's `current_period_start/end` now spans the whole prepaid term.
 * Included usage (voice minutes, shared AI chat budget) still resets MONTHLY,
 * so every quota key that used to be "the Stripe period start" must instead be
 * the start of the current month-window anchored to the Stripe period start.
 *
 * Windows are `[addMonths(periodStart, n), addMonths(periodStart, n + 1))` in
 * UTC with day-of-month clamping (a period starting Jan 31 yields windows at
 * Feb 28/29, Mar 31, Apr 30, ...), matching the renewal-date math in
 * /api/checkout.
 *
 * Backward compatibility: for a monthly subscription "now" always falls in
 * window 0, and window 0 returns the input string UNCHANGED — so existing
 * monthly tenants keep their exact current quota keys and no usage pool is
 * split by this change.
 *
 * Zero imports on purpose: this file is shared VERBATIM between the Deno edge
 * functions (imported with the `.ts` extension) and the Next.js app (imported
 * extension-less via a relative path, like `voice_reservation_limits.ts`).
 * The per-tenant VPS services (vps/chat-worker/worker.mjs,
 * vps/voice-bridge/src/index.ts) carry inline copies that MUST stay in
 * lockstep — they build/deploy from their own directories.
 */

export type QuotaWindow = {
  /** Window start. Equal to the raw input string for window 0. */
  startIso: string;
  /** Exclusive window end (start of the next month-window). */
  endIso: string;
};

/**
 * `base + months` calendar months in UTC, clamping the day-of-month to the
 * target month's length while preserving the time-of-day.
 */
export function addUtcMonthsClamped(base: Date, months: number): Date {
  const totalMonths = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), daysInTarget);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
}

/**
 * Resolve the month-window containing `nowMs` for a billing period that
 * started at `periodStartIso`.
 *
 * - `now` before the period start (clock skew, webhook races) → window 0.
 * - Window 0 echoes `periodStartIso` back verbatim as `startIso` so existing
 *   monthly tenants' quota keys are bit-for-bit unchanged.
 * - Unparseable input → degenerate window echoing the input (callers treat
 *   the key opaquely, so this fails no worse than the pre-window behavior).
 */
export function deriveMonthlyQuotaWindow(periodStartIso: string, nowMs: number): QuotaWindow {
  const start = new Date(periodStartIso);
  if (!Number.isFinite(start.getTime())) {
    return { startIso: periodStartIso, endIso: periodStartIso };
  }

  let n = 0;
  if (nowMs > start.getTime()) {
    const now = new Date(nowMs);
    n =
      (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - start.getUTCMonth());
    if (n < 0) n = 0;
    // The month-diff estimate can be off by one around clamped month ends;
    // settle onto the invariant window[n] <= now < window[n+1].
    while (n > 0 && addUtcMonthsClamped(start, n).getTime() > nowMs) n--;
    while (addUtcMonthsClamped(start, n + 1).getTime() <= nowMs) n++;
  }

  return {
    startIso: n === 0 ? periodStartIso : addUtcMonthsClamped(start, n).toISOString(),
    endIso: addUtcMonthsClamped(start, n + 1).toISOString()
  };
}
