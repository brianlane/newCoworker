/**
 * When a Hostinger box's paid period ends, and whether it renews or goes dark.
 *
 * The source is the `hostinger_vps_costs` snapshot the daily platform-cost
 * sync writes (11:10 UTC), one row per billing subscription. Two fields carry
 * the date and they are NOT interchangeable:
 *
 *   - `next_billing_at` is set while a subscription still auto-renews. It is
 *     the day we are charged again, and therefore how much prepaid runway the
 *     box has.
 *   - `expires_at` is set once a subscription is cancelled or set not to
 *     renew. It is the day the box actually goes dark.
 *
 * Live data has exactly one of them populated per row, never both, so picking
 * the right one is entirely a function of the renew state. {@link boxTermEndsAt}
 * is that pick, shared by /admin/costs and the per-tenant Infrastructure card
 * so the two can never drift.
 *
 * Deliberately NOT derived from here: the term length. Hostinger's
 * `billing_period` / `billing_period_unit` can lag the real term. Observed on
 * VM 1806097 (Aug 26 2026): the owner bought a one-year period, Hostinger
 * pushed `next_billing_at` a full year out to 2027-09-05, and yet still
 * reported `billing_period: 1, billing_period_unit: "month"` with a $19.49
 * renewal price. Rendering "1 month" next to a date twelve months away is
 * worse than saying nothing, so the runway here is measured from the DATE,
 * which is the field that actually moved.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days of remaining runway at or under which a box that will NOT renew is
 * worth shouting about. Renewing boxes never trip it: a renewal landing
 * tomorrow is business as usual, not an outage in waiting.
 */
export const BOX_LAPSE_WARNING_DAYS = 14;

/**
 * How old a snapshot may be before it stops being evidence. The sync runs
 * daily, so anything past a day plus slack means the sync itself is broken
 * and the date on screen is describing the fleet as it was, not as it is.
 */
export const BOX_SNAPSHOT_STALE_MS = 26 * 60 * 60 * 1000;

export type BoxTermState =
  /** Auto-renew is on: the box keeps running and we get charged again. */
  | "renewing"
  /** Auto-renew is off but the subscription still stands: it dies at term end. */
  | "lapsing"
  /** Already cancelled upstream: it dies at term end and cannot be renewed. */
  | "cancelled";

/** The subset of a `hostinger_vps_costs` row this module reads. */
export type BoxBillingFields = {
  status: string;
  is_auto_renewed: boolean | null;
  next_billing_at: string | null;
  expires_at: string | null;
};

export type BoxTerm = {
  state: BoxTermState;
  /**
   * ISO instant the current paid period ends, or null when Hostinger
   * reported neither date. Null is "unknown", never "no expiry".
   */
  endsAt: string | null;
  /** Whole days until {@link endsAt}, rounded up and floored at 0. */
  daysLeft: number | null;
  /** Runway in words, e.g. "about 12 months left". Null when the date is. */
  runwayLabel: string | null;
  /** A box that will not renew and is inside {@link BOX_LAPSE_WARNING_DAYS}. */
  urgent: boolean;
};

/**
 * Renew posture from the two independent fields Hostinger can express it in.
 *
 * `is_auto_renewed === false` and `status === "non_renewing"` mean the same
 * thing, and the live API has been seen setting either, so both are checked.
 * `is_auto_renewed` is nullable: null is unknown, and unknown must NOT read
 * as "lapsing", or an unsynced field would paint every healthy box as dying.
 */
export function boxTermState(row: Pick<BoxBillingFields, "status" | "is_auto_renewed">): BoxTermState {
  if (row.status === "cancelled") return "cancelled";
  if (row.is_auto_renewed === false || row.status === "non_renewing") return "lapsing";
  return "renewing";
}

/**
 * The date the current paid period ends, picking whichever field the renew
 * state makes meaningful. Each branch falls back to the other field so a row
 * carrying only the "wrong" one still shows a date instead of a dash.
 */
export function boxTermEndsAt(row: BoxBillingFields): string | null {
  return boxTermState(row) === "renewing"
    ? (row.next_billing_at ?? row.expires_at)
    : (row.expires_at ?? row.next_billing_at);
}

/**
 * Whole days from `now` to `endsAtIso`, rounded up. Null when there is no
 * usable date; 0 rather than a negative number once the date has passed, so
 * callers can render "ends today" without special-casing the sign.
 */
export function boxTermDaysLeft(
  endsAtIso: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!endsAtIso) return null;
  const ms = Date.parse(endsAtIso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil((ms - now.getTime()) / DAY_MS));
}

/**
 * Runway in words.
 *
 * Exact days up to two months, because that is the range where a specific
 * number changes what you do. Past that, months: nobody acts differently on
 * 374 days than on 366, and "about 12 months left" is the sentence an admin
 * actually wants when they bought a year. The 60-day cutoff also avoids a
 * degenerate "about 1 month left" band, which would read as less precise
 * than the "30 days left" it replaced.
 */
export function boxRunwayLabel(daysLeft: number | null): string | null {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return "ends today";
  if (daysLeft === 1) return "1 day left";
  if (daysLeft < 60) return `${daysLeft} days left`;
  const months = Math.round(daysLeft / 30.44);
  return `about ${months} months left`;
}

/** True when a snapshot is too old to be treated as the current state. */
export function boxSnapshotStale(
  snapshotAtIso: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!snapshotAtIso) return true;
  const ms = Date.parse(snapshotAtIso);
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > BOX_SNAPSHOT_STALE_MS;
}

/**
 * How alive a subscription is, as a sortable rank.
 *
 * The three states are genuinely ordered, not just "renews or not": a
 * `lapsing` subscription is still ours and can be re-enabled (the
 * billing-posture cron does exactly that), while a `cancelled` one is gone
 * and its remaining term is just a leftover. Collapsing those two into one
 * bucket let a cancelled row with a longer leftover term outrank the live
 * subscription, which is the precise case this picker exists to prevent.
 */
function boxLivenessRank(state: BoxTermState): number {
  if (state === "renewing") return 2;
  if (state === "lapsing") return 1;
  return 0;
}

/**
 * Pick the row that describes the box we are running RIGHT NOW.
 *
 * `hostinger_vps_costs` is keyed on `subscription_id`, not `vm_id`, and
 * nothing constrains a VM to one subscription, so a rebuilt or re-billed box
 * can carry both its old cancelled subscription and its new active one. The
 * cancelled row's expiry describes hardware we no longer pay for, and showing
 * it would announce an outage that is not coming. Rank by liveness first, and
 * only among equally-live rows by the furthest end date; a row with no usable
 * date at all loses to any row that has one.
 */
export function pickLiveBoxSnapshot<T extends BoxBillingFields>(
  rows: readonly T[]
): T | null {
  let best: T | null = null;
  let bestRank = -1;
  let bestEnd = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rank = boxLivenessRank(boxTermState(row));
    const endsAt = boxTermEndsAt(row);
    const parsed = endsAt ? Date.parse(endsAt) : Number.NaN;
    const endMs = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    if (rank > bestRank || (rank === bestRank && endMs > bestEnd)) {
      best = row;
      bestRank = rank;
      bestEnd = endMs;
    }
  }
  return best;
}

/** Everything a surface needs to render one box's term, from one row. */
export function summarizeBoxTerm(row: BoxBillingFields, now: Date = new Date()): BoxTerm {
  const state = boxTermState(row);
  const endsAt = boxTermEndsAt(row);
  const daysLeft = boxTermDaysLeft(endsAt, now);
  return {
    state,
    endsAt,
    daysLeft,
    runwayLabel: boxRunwayLabel(daysLeft),
    urgent: state !== "renewing" && daysLeft !== null && daysLeft <= BOX_LAPSE_WARNING_DAYS
  };
}
