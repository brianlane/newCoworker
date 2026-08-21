/**
 * When each usage meter on /dashboard/billing actually resets or expires.
 *
 * Every included allowance now runs on ONE clock, and bonus packs run on
 * their own:
 *
 *   - Voice included minutes and the shared AI chat budget reset on the
 *     MONTHLY window anchored to the Stripe period start. A 12/24-month
 *     prepaid plan bills once for the whole term, so its Stripe period end
 *     can be years out while the included allowances still refill every
 *     month. See supabase/functions/_shared/billing_period_window.ts: this
 *     is the same window the reserve RPCs key their usage rows with, so the
 *     date shown here is the date enforcement actually flips.
 *     Texts run on this same window: they used to be metered per UTC calendar
 *     month, and moved onto the anchor in the
 *     `sms_billing_window_start` migration so a tenant has one reset date
 *     instead of two. Postgres owns that window; `monthlyUsageResetAt` below
 *     only has to agree with it about the NEXT boundary, which it does,
 *     because the migration's changeover rule moves a window START without
 *     ever moving its end.
 *   - Bonus packs expire per grant at max(period end, purchased + 30 days),
 *     so a balance built from several packs drains in tranches and the date
 *     worth showing is the SOONEST one still holding a balance.
 */

import { deriveMonthlyQuotaWindow } from "../../../supabase/functions/_shared/billing_period_window";

/**
 * End of the month-window the tenant is currently spending against, i.e. the
 * instant included voice minutes and the AI chat budget refill.
 *
 * Returns null when there is no usable period anchor (no subscription yet, or
 * an unparseable timestamp): deriveMonthlyQuotaWindow degenerates to echoing
 * its input there, and rendering a window START as a reset date would be a
 * lie. Callers render nothing instead.
 */
export function monthlyUsageResetAt(
  periodStartIso: string | null | undefined,
  nowMs: number
): string | null {
  if (!periodStartIso) return null;
  if (!Number.isFinite(new Date(periodStartIso).getTime())) return null;
  return deriveMonthlyQuotaWindow(periodStartIso, nowMs).endIso;
}

/**
 * Start of the next UTC calendar month.
 *
 * The fallback window for a tenant with no Stripe period anchor yet (trial,
 * pre-checkout, wiped subscription). Both `sms_billing_window_start` in
 * Postgres and getChatSpendSnapshotForBusiness fall back to the calendar
 * month in exactly that case, so the page shows the same boundary they
 * enforce. `Date.UTC` rolls December over into January on its own.
 */
export function calendarMonthResetAt(nowMs: number): string {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Earliest of a set of grant expiries, ignoring blanks and unparseable
 * values. Returns null when nothing usable is left, so a tenant with no
 * live packs sees no expiry line at all.
 */
export function soonestExpiryAt(
  isos: ReadonlyArray<string | null | undefined>
): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const iso of isos) {
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) continue;
    best = iso;
    bestMs = ms;
  }
  return best;
}

/**
 * Render a reset / expiry instant for the billing page.
 *
 * Formatted in UTC on purpose: every boundary above is a UTC instant, so
 * formatting in the server's own zone would show "Aug 31" for a reset that
 * really happens on Sep 1. Shape matches PlanCard's renewal dates so the
 * two read as the same kind of fact.
 */
export function formatUsagePeriodDate(iso: string, locale: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  return at.toLocaleDateString(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}
