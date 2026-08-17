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
 *   2. Commitment ratio: the sum of per-tenant carrier caps vs the granted
 *      pool. Oversubscription is normal (tenants rarely peak together), but
 *      past 2x the promise stops being credible under simultaneous load.
 *
 * When either trips, the admin gets ONE email per week bucket carrying a
 * ready-to-send raise request, which reduces the unavoidable manual step to
 * forwarding a draft.
 */

/** One email per this bucket: weekly. */
export const CAPACITY_MONITOR_BUCKET_MINUTES = 7 * 24 * 60;

/** Telemetry lookback the counts are computed over. */
export const CAPACITY_MONITOR_LOOKBACK_DAYS = 14;

/** Commitment ratio (sum of tenant caps / pool) above which we flag. */
export const CAPACITY_MONITOR_OVERCOMMIT_RATIO = 2;

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
    inputs.accountLimit > 0 &&
    committedCaps > inputs.accountLimit * CAPACITY_MONITOR_OVERCOMMIT_RATIO
  ) {
    reasons.push(
      `per-tenant caps total ${committedCaps} channels against an account pool of ` +
        `${inputs.accountLimit} (over ${CAPACITY_MONITOR_OVERCOMMIT_RATIO}x committed)`
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
    "After Telnyx confirms, update the TELNYX_ACCOUNT_CHANNEL_LIMIT secret;",
    "the platform's pre-dial gate derives from it. This review emails at",
    "most once a week."
  ];
  return {
    subject: "Telnyx capacity review: raise the account pool",
    text: lines.join("\n")
  };
}

/** Next pool worth requesting: double the current, floored at 20. */
export function suggestedPoolRaise(accountLimit: number): number {
  if (!Number.isFinite(accountLimit) || accountLimit < 10) return 20;
  return accountLimit * 2;
}
