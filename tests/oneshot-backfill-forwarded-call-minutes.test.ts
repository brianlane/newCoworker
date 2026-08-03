import { describe, expect, it } from "vitest";
import {
  BACKFILL_CONTEXT,
  classifyForwardedCall,
  roundToBillableSeconds,
  type BusinessBilling,
  type ForwardedCallRow
} from "../scripts/oneshot/backfill-forwarded-call-minutes";
import { VOICE_RES_LIMITS } from "../supabase/functions/_shared/voice_reservation_limits";

// Amy Laidlaw Real Estate's real shape: biennial term starting Jul 28 2026,
// standard tier. Her two unmetered forwarded calls are the fixtures below.
const AMY_PERIOD = "2026-07-28T22:42:02+00:00";

const standard: BusinessBilling = {
  tier: "standard",
  enterpriseLimits: null,
  periodStartIso: AMY_PERIOD
};

function call(overrides: Partial<ForwardedCallRow> = {}): ForwardedCallRow {
  return {
    call_control_id: "v3:leg",
    business_id: "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3",
    started_at: "2026-08-03T17:05:02.251173+00:00",
    ended_at: "2026-08-03T17:15:45.952+00:00",
    status: "completed",
    ...overrides
  };
}

describe("classifyForwardedCall", () => {
  it("meters an answered call with the span from its own timestamps", () => {
    const result = classifyForwardedCall(call(), standard);
    expect(result).toEqual({
      action: "meter",
      reportedSeconds: 643,
      stripePeriodStart: new Date(AMY_PERIOD).toISOString(),
      tierCapSeconds: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod
    });
  });

  it("meters the Jul 31 call into the same period", () => {
    const result = classifyForwardedCall(
      call({
        call_control_id: "v3:TT13",
        started_at: "2026-07-31T22:03:58.236285+00:00",
        ended_at: "2026-07-31T22:06:30.547+00:00"
      }),
      standard
    );
    expect(result).toMatchObject({ action: "meter", reportedSeconds: 152 });
  });

  describe("keys each call to the period it happened in, not today's", () => {
    it("files a later month into its own month-window", () => {
      // A monthly anchor: a call two months later must not land on window 0.
      const monthly: BusinessBilling = {
        tier: "standard",
        enterpriseLimits: null,
        periodStartIso: "2026-01-31T12:00:00.000Z"
      };
      const result = classifyForwardedCall(
        call({ started_at: "2026-03-15T09:00:00.000Z", ended_at: "2026-03-15T09:02:00.000Z" }),
        monthly
      );
      expect(result).toMatchObject({
        action: "meter",
        // Jan 31 + 1 month clamps to Feb 28, and Mar 15 falls in that window.
        stripePeriodStart: "2026-02-28T12:00:00.000Z"
      });
    });

    it("echoes the period start verbatim for a window-0 call", () => {
      const result = classifyForwardedCall(
        call({ started_at: "2026-07-29T00:00:00.000Z", ended_at: "2026-07-29T00:01:00.000Z" }),
        standard
      );
      expect(result).toMatchObject({
        action: "meter",
        stripePeriodStart: new Date(AMY_PERIOD).toISOString()
      });
    });
  });

  describe("skips", () => {
    it("a call that rang out", () => {
      expect(classifyForwardedCall(call({ status: "missed" }), standard)).toEqual({
        action: "skip",
        reason: "not_answered"
      });
    });

    it("a call with no ended_at", () => {
      expect(classifyForwardedCall(call({ ended_at: null }), standard)).toEqual({
        action: "skip",
        reason: "no_timestamps"
      });
    });

    it("a call with no started_at", () => {
      expect(classifyForwardedCall(call({ started_at: null }), standard)).toEqual({
        action: "skip",
        reason: "no_timestamps"
      });
    });

    it("a call with unparseable timestamps", () => {
      expect(classifyForwardedCall(call({ ended_at: "nonsense" }), standard)).toEqual({
        action: "skip",
        reason: "no_timestamps"
      });
    });

    it("a negative span rather than clamping it to zero", () => {
      expect(
        classifyForwardedCall(
          call({
            started_at: "2026-08-03T17:15:45.000Z",
            ended_at: "2026-08-03T17:05:02.000Z"
          }),
          standard
        )
      ).toEqual({ action: "skip", reason: "negative_span" });
    });

    // Metering 0 would insert a claim row and permanently block a later
    // correct meter for the same call_control_id.
    it("a zero-second span, leaving the idempotency key available", () => {
      expect(
        classifyForwardedCall(
          call({
            started_at: "2026-08-03T17:05:02.000Z",
            ended_at: "2026-08-03T17:05:02.400Z"
          }),
          standard
        )
      ).toEqual({ action: "skip", reason: "zero_seconds" });
    });

    it("a tenant with no subscription row", () => {
      expect(
        classifyForwardedCall(call(), { ...standard, periodStartIso: null })
      ).toEqual({ action: "skip", reason: "no_subscription" });
    });

    it("a tenant whose period start is unparseable", () => {
      expect(
        classifyForwardedCall(call(), { ...standard, periodStartIso: "not-a-date" })
      ).toEqual({ action: "skip", reason: "closed_period" });
    });

    it("a call predating the current Stripe period (already invoiced)", () => {
      expect(
        classifyForwardedCall(
          call({
            started_at: "2026-07-15T07:00:00.000Z",
            ended_at: "2026-07-15T07:09:03.000Z"
          }),
          standard
        )
      ).toEqual({ action: "skip", reason: "closed_period" });
    });
  });

  describe("tier caps resolve the same way the live meter resolves them", () => {
    it("standard", () => {
      expect(classifyForwardedCall(call(), standard)).toMatchObject({
        tierCapSeconds: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod
      });
    });

    it("starter", () => {
      expect(
        classifyForwardedCall(call(), { ...standard, tier: "starter" })
      ).toMatchObject({
        tierCapSeconds: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
      });
    });

    it("an unknown tier falls back to starter", () => {
      expect(
        classifyForwardedCall(call(), { ...standard, tier: "mystery" })
      ).toMatchObject({
        tierCapSeconds: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
      });
    });

    it("enterprise reads its own limits", () => {
      const result = classifyForwardedCall(call(), {
        ...standard,
        tier: "enterprise",
        enterpriseLimits: { voiceIncludedSecondsPerStripePeriod: 99000 }
      });
      expect(result).toMatchObject({ action: "meter" });
      expect((result as { tierCapSeconds: number }).tierCapSeconds).toBeGreaterThan(0);
    });
  });
});

describe("roundToBillableSeconds", () => {
  it("rounds up to the next whole minute, matching the RPC", () => {
    expect(roundToBillableSeconds(643)).toBe(660);
    expect(roundToBillableSeconds(152)).toBe(180);
    expect(roundToBillableSeconds(60)).toBe(60);
    expect(roundToBillableSeconds(1)).toBe(60);
  });

  it("bills nothing for a non-positive duration", () => {
    expect(roundToBillableSeconds(0)).toBe(0);
    expect(roundToBillableSeconds(-5)).toBe(0);
  });

  // Amy's two calls: 660 + 180 = 840s = 14 min, taking her card from 9 to 23.
  it("totals Amy's two unmetered calls to 14 minutes", () => {
    expect((roundToBillableSeconds(643) + roundToBillableSeconds(152)) / 60).toBe(14);
  });
});

describe("BACKFILL_CONTEXT", () => {
  it("is distinguishable from the live meter contexts in the audit table", () => {
    expect(BACKFILL_CONTEXT).toBe("forwarded_backfill");
    expect(BACKFILL_CONTEXT).not.toBe("warm_transfer");
    expect(BACKFILL_CONTEXT).not.toBe("handoff_chain");
  });
});
