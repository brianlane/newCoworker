/**
 * Admin billing levers: pause collection, and move the next billing date.
 *
 * Both are white-glove comps an operator applies to a live tenant from
 * /admin/[businessId], and both are expressed as Stripe subscription-update
 * payloads. This module is the pure part: validation and payload shaping,
 * no network, no clock of its own (callers pass `now`). The routes in
 * src/app/api/admin/billing-{pause,date} do the Stripe call and the DB
 * mirror.
 *
 * PAUSE uses `pause_collection` with behavior "void": Stripe keeps generating
 * invoices on schedule but voids them, so the tenant is comped and no payment
 * is attempted (no dunning, no `invoice.payment_failed`). Critically,
 * `pause_collection` leaves `subscription.status` alone, the Stripe webhook
 * tears a tenant down when the status becomes past_due/unpaid/paused, and a
 * comped tenant must never hit that path.
 *
 * NEXT BILLING DATE uses `trial_end`, which is Stripe's supported way to move
 * a subscription's next charge and re-anchor the cycle to it. Stripe only
 * accepts a future timestamp. The subscription reports `trialing` until the
 * date arrives, which our webhook already maps to the local `active` status.
 * Side effect we accept: the billing period restarts at the change, so the
 * monthly usage windows (supabase/functions/_shared/billing_period_window.ts)
 * re-anchor and the tenant gets a fresh usage month.
 */

/** Stripe rejects a `trial_end` / `resumes_at` that is not in the future. */
export const MIN_LEAD_MS = 60 * 1000;

/** Sanity ceiling on both dates: two years out. Guards a fat-fingered year. */
export const MAX_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type BillingControlError =
  | "invalid_date"
  | "date_must_be_in_the_future"
  | "date_too_far_out"
  | "date_before_current_period_end";

export type BillingControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BillingControlError };

/** Stripe's `pause_collection` shape for a comped pause. */
export type PauseCollectionParams = {
  pause_collection: { behavior: "void"; resumes_at?: number };
};

/** Clearing a pause: Stripe reads an explicit null as "resume collection". */
export type ResumeCollectionParams = { pause_collection: null };

export type NextBillingDateParams = {
  trial_end: number;
  /**
   * Moving the anchor must not generate a credit or a catch-up charge: this
   * is a comped date change, not a plan change.
   */
  proration_behavior: "none";
};

/**
 * Validate an ISO timestamp as a future date within the horizon and return it
 * as Stripe's unix seconds.
 */
function toFutureUnixSeconds(iso: string, now: Date): BillingControlResult<number> {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return { ok: false, reason: "invalid_date" };
  if (at - now.getTime() < MIN_LEAD_MS) {
    return { ok: false, reason: "date_must_be_in_the_future" };
  }
  if (at - now.getTime() > MAX_HORIZON_MS) {
    return { ok: false, reason: "date_too_far_out" };
  }
  return { ok: true, value: Math.floor(at / 1000) };
}

/**
 * Pause collection, optionally with an auto-resume date. A null/omitted
 * `resumesAtIso` pauses indefinitely until an operator resumes.
 */
export function buildPauseCollectionParams(
  resumesAtIso: string | null | undefined,
  now: Date
): BillingControlResult<PauseCollectionParams> {
  if (resumesAtIso == null || resumesAtIso === "") {
    return { ok: true, value: { pause_collection: { behavior: "void" } } };
  }
  const resumesAt = toFutureUnixSeconds(resumesAtIso, now);
  if (!resumesAt.ok) return resumesAt;
  return {
    ok: true,
    value: { pause_collection: { behavior: "void", resumes_at: resumesAt.value } }
  };
}

export function buildResumeCollectionParams(): ResumeCollectionParams {
  return { pause_collection: null };
}

/**
 * Move the next charge to `nextBillingAtIso` and re-anchor the cycle there.
 *
 * `currentPeriodEndIso` is the paid-through date. Moving the anchor EARLIER
 * than that collapses the period the tenant already paid for, and because
 * this is deliberately `proration_behavior: "none"` they get no credit for
 * the unused days: a monthly tenant who paid $195 on Jul 1 and is moved to
 * Jul 6 loses 26 paid days and is charged the full renewal on the 6th.
 *
 * This tool exists to COMP a tenant (push the date out), which is why the
 * route documented it as "can extend a cycle but never bill earlier". Stripe
 * only requires `trial_end > now`, so that promise needs enforcing here.
 *
 * An unknown or unparseable period end falls back to the future-only check:
 * a subscription with no cached period end must stay movable rather than
 * become unmanageable from admin.
 */
export function buildNextBillingDateParams(
  nextBillingAtIso: string,
  now: Date,
  currentPeriodEndIso: string | null | undefined
): BillingControlResult<NextBillingDateParams> {
  const trialEnd = toFutureUnixSeconds(nextBillingAtIso, now);
  if (!trialEnd.ok) return trialEnd;

  const periodEnd = currentPeriodEndIso ? Date.parse(currentPeriodEndIso) : NaN;
  if (Number.isFinite(periodEnd) && new Date(nextBillingAtIso).getTime() < periodEnd) {
    return { ok: false, reason: "date_before_current_period_end" };
  }
  return { ok: true, value: { trial_end: trialEnd.value, proration_behavior: "none" } };
}

export type BillingPauseState = {
  billing_paused: boolean;
  billing_pause_resumes_at: string | null;
};

/**
 * Read the pause state off a Stripe subscription for the DB mirror. Tolerant
 * of unknown input so the webhook can call it on any payload shape: anything
 * that is not a recognizable `pause_collection` object reads as "not paused",
 * which matches Stripe (the field is null when collection is running).
 */
export function pauseStateFromStripeSubscription(sub: unknown): BillingPauseState {
  const pause =
    sub != null && typeof sub === "object"
      ? (sub as { pause_collection?: unknown }).pause_collection
      : null;
  if (pause == null || typeof pause !== "object") {
    return { billing_paused: false, billing_pause_resumes_at: null };
  }
  const resumesAt = (pause as { resumes_at?: unknown }).resumes_at;
  return {
    billing_paused: true,
    billing_pause_resumes_at:
      typeof resumesAt === "number" && Number.isFinite(resumesAt)
        ? new Date(resumesAt * 1000).toISOString()
        : null
  };
}

/**
 * Human-readable message for a Stripe rejection of a billing-date change.
 * The common one in this fleet: term (annual/biennial) subscriptions are
 * driven by a subscription schedule, and Stripe refuses anchor edits on a
 * scheduled subscription. Surfacing that plainly beats echoing Stripe's raw
 * error at an operator.
 */
export function describeBillingDateStripeError(message: string): string {
  if (/schedule/i.test(message)) {
    return "Stripe manages this subscription with a commitment schedule, so its billing date cannot be moved here. Adjust the schedule in the Stripe dashboard instead.";
  }
  return message;
}
