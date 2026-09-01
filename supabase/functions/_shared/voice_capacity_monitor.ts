/**
 * Weekly Telnyx capacity headroom review (pure logic; the cron edge
 * function feeds it counts and mails the verdict).
 *
 * The account-level outbound channel pool is support-ticket-only at Telnyx
 * (not readable or writable via API), so growth cannot be automated, only
 * watched. Two honest signals, no synthetic modeling:
 *
 *   1. REAL refusals in the lookback window: carrier channel-limit 403s
 *      (telemetry voice_outbound_dial_failed with capacity=true) plus the
 *      platform gate's pre-dial platform_capacity blocks. Any nonzero count
 *      means the fleet actually touched its ceiling.
 *   2. The headroom invariant (owner policy, Aug 2026): the account pool
 *      must stay at least SAFETY_FACTOR times the sum of per-tenant carrier
 *      caps, so the fleet always has double the concurrent capacity it
 *      could commit to. Example: 5 tenants promised 10 concurrent calls
 *      each = 50 committed, so the pool must be >= 100.
 *
 * When either trips, the admin gets ONE email per week bucket carrying a
 * ready-to-send raise request sized to restore the invariant, which reduces
 * the unavoidable manual step to forwarding a draft.
 */

/** One email per this bucket: weekly. */
export const CAPACITY_MONITOR_BUCKET_MINUTES = 7 * 24 * 60;

/** Telemetry lookback the counts are computed over. */
export const CAPACITY_MONITOR_LOOKBACK_DAYS = 14;

/** The pool must be at least this many times the committed tenant caps. */
export const CAPACITY_MONITOR_SAFETY_FACTOR = 2;

export type CapacityHeadroomInputs = {
  carrierRejections: number;
  platformBlocks: number;
  tenantCaps: number[];
  accountLimit: number;
};

export type CapacityHeadroomVerdict = {
  alert: boolean;
  reasons: string[];
  committedCaps: number;
};

export function evaluateCapacityHeadroom(inputs: CapacityHeadroomInputs): CapacityHeadroomVerdict {
  const reasons: string[] = [];
  const committedCaps = inputs.tenantCaps.reduce((sum, cap) => sum + cap, 0);
  const refusals = inputs.carrierRejections + inputs.platformBlocks;
  if (refusals > 0) {
    reasons.push(
      `${inputs.carrierRejections} carrier channel-limit rejection(s) and ` +
        `${inputs.platformBlocks} platform pre-dial block(s) in the last ` +
        `${CAPACITY_MONITOR_LOOKBACK_DAYS} days`
    );
  }
  if (
    committedCaps > 0 &&
    inputs.accountLimit < committedCaps * CAPACITY_MONITOR_SAFETY_FACTOR
  ) {
    reasons.push(
      `account pool ${inputs.accountLimit} is below ${CAPACITY_MONITOR_SAFETY_FACTOR}x the ` +
        `fleet's committed per-tenant caps (${committedCaps} channels committed, so the ` +
        `pool should be at least ${committedCaps * CAPACITY_MONITOR_SAFETY_FACTOR})`
    );
  }
  return { alert: reasons.length > 0, reasons, committedCaps };
}

/** The weekly email, carrying the ready-to-send Telnyx raise request. */
export function formatCapacityMonitorEmail(args: {
  verdict: CapacityHeadroomVerdict;
  inputs: CapacityHeadroomInputs;
  suggestedPool: number;
}): { subject: string; text: string } {
  const lines = [
    "Weekly Telnyx outbound-capacity review: the pool is getting tight.",
    "",
    ...args.verdict.reasons.map((reason) => `- ${reason}`),
    "",
    `Granted account pool: ${args.inputs.accountLimit} concurrent outbound calls.`,
    `Sum of per-tenant carrier caps: ${args.verdict.committedCaps}.`,
    "",
    "Raising the account pool is a Telnyx support ticket (it is not exposed",
    "via API). Ready to send from the account owner email to",
    "support@telnyx.com:",
    "",
    "--- draft ---",
    `Subject: Request: raise account-level outbound concurrent call limit to ${args.suggestedPool}`,
    "",
    "Hello Telnyx team, we would like to raise our account-level outbound",
    `concurrent call limit to ${args.suggestedPool}. We run an AI coworker platform for`,
    "small businesses: transactional, consented business calling with 30s",
    "ring timeouts, premium answering machine detection on follow-ups, and",
    "per-customer Call Control Applications and Outbound Voice Profiles",
    "each carrying their own channel limits and daily spend limits. Our",
    "per-customer caps and observed usage now need more account headroom.",
    "Thank you!",
    "--- end draft ---",
    "",
    "After Telnyx confirms, update admin_platform_settings key telnyx_capacity",
    "(jsonb_set on account_channel_limit). The pre-dial gate derives from",
    "that row. This review emails at most once a week."
  ];
  return {
    subject: "Telnyx capacity review: raise the account pool",
    text: lines.join("\n")
  };
}

/**
 * The pool to request. When the headroom invariant is broken, ask for
 * exactly what restores it (SAFETY_FACTOR x committed caps, matching the
 * alert reason's number). When the alert fired from real refusals while
 * the invariant still holds, that target would be at or below the current
 * pool, so a "raise" must instead double the pool itself: the fleet
 * provably exhausted what it has. Floored at 20 so a tiny fleet still
 * asks for a usable pool.
 */
export function suggestedPoolRaise(committedCaps: number, accountLimit: number): number {
  const committed = Number.isFinite(committedCaps) && committedCaps > 0 ? committedCaps : 0;
  const pool = Number.isFinite(accountLimit) && accountLimit > 0 ? accountLimit : 0;
  const invariantTarget = committed * CAPACITY_MONITOR_SAFETY_FACTOR;
  const target =
    invariantTarget > pool ? invariantTarget : pool * CAPACITY_MONITOR_SAFETY_FACTOR;
  return Math.max(20, target);
}
