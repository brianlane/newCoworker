import { describe, expect, it } from "vitest";
import {
  CAPACITY_MONITOR_BUCKET_MINUTES,
  CAPACITY_MONITOR_LOOKBACK_DAYS,
  CAPACITY_MONITOR_SAFETY_FACTOR,
  evaluateCapacityHeadroom,
  formatCapacityMonitorEmail,
  suggestedPoolRaise
} from "../supabase/functions/_shared/voice_capacity_monitor";

/**
 * The weekly headroom review. Two triggers: any REAL refusal in the
 * lookback window, and the owner's invariant (Aug 2026): the account pool
 * must stay at least 2x the fleet's committed per-tenant caps. Five tenants
 * promised 10 concurrent calls each = 50 committed = the pool must be 100.
 * The email carries a ready-to-send Telnyx raise draft sized to restore the
 * invariant, because the pool is the one knob their API will not automate.
 */
describe("evaluateCapacityHeadroom", () => {
  it("stays quiet when nothing was refused and the pool holds 2x committed", () => {
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10, 10, 10, 10],
      accountLimit: 100
    });
    expect(v).toEqual({ alert: false, reasons: [], committedCaps: 50 });
  });

  it("flags any real refusal, carrier or platform gate", () => {
    expect(
      evaluateCapacityHeadroom({
        carrierRejections: 1,
        platformBlocks: 0,
        tenantCaps: [],
        accountLimit: 100
      }).alert
    ).toBe(true);
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 3,
      tenantCaps: [],
      accountLimit: 100
    });
    expect(v.alert).toBe(true);
    expect(v.reasons[0]).toContain("3 platform pre-dial block(s)");
    expect(v.reasons[0]).toContain(`${CAPACITY_MONITOR_LOOKBACK_DAYS} days`);
  });

  it("flags a pool below 2x committed caps, and names the target", () => {
    // 5 standard tenants against the old pool of 10: scream.
    const tight = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10, 10, 10, 10],
      accountLimit: 10
    });
    expect(tight.alert).toBe(true);
    expect(tight.reasons[0]).toContain("account pool 10 is below 2x");
    expect(tight.reasons[0]).toContain("50 channels committed");
    expect(tight.reasons[0]).toContain("at least 100");
  });

  it("treats exactly 2x as satisfied (boundary is quiet)", () => {
    expect(CAPACITY_MONITOR_SAFETY_FACTOR).toBe(2);
    const at = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10, 10, 10, 10],
      accountLimit: 100
    });
    expect(at.alert).toBe(false);
    // One more standard tenant breaks the invariant: 60 committed needs 120.
    const over = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10, 10, 10, 10, 10],
      accountLimit: 100
    });
    expect(over.alert).toBe(true);
    expect(over.reasons[0]).toContain("at least 120");
  });

  it("a fleet with no committed caps never trips the invariant", () => {
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [],
      accountLimit: 10
    });
    expect(v.alert).toBe(false);
  });
});

describe("formatCapacityMonitorEmail", () => {
  it("carries the reasons, the numbers, and the ready-to-send draft", () => {
    const inputs = {
      carrierRejections: 2,
      platformBlocks: 1,
      tenantCaps: [10, 10, 10],
      accountLimit: 10
    };
    const verdict = evaluateCapacityHeadroom(inputs);
    const email = formatCapacityMonitorEmail({
      verdict,
      inputs,
      suggestedPool: suggestedPoolRaise(verdict.committedCaps, inputs.accountLimit)
    });
    expect(email.subject).toContain("raise the account pool");
    expect(email.text).toContain("2 carrier channel-limit rejection(s)");
    expect(email.text).toContain("Granted account pool: 10");
    expect(email.text).toContain("Sum of per-tenant carrier caps: 30");
    expect(email.text).toContain("support@telnyx.com");
    expect(email.text).toContain("outbound concurrent call limit to 60");
    expect(email.text).toContain("telnyx_capacity");
    expect(email.text).toContain("AI coworker");
  });
});

describe("suggestedPoolRaise", () => {
  it("restores the invariant when broken (matching the alert reason's number)", () => {
    expect(suggestedPoolRaise(50, 10)).toBe(100);
    expect(suggestedPoolRaise(50, 60)).toBe(100);
    expect(suggestedPoolRaise(30, 10)).toBe(60);
  });

  // Bugbot High on this PR: a refusal-triggered alert with a HEALTHY
  // invariant would otherwise "ask" for a pool at or below the current one.
  // The fleet provably exhausted what it has, so the draft doubles the pool.
  it("is always a genuine increase when the invariant already holds", () => {
    expect(suggestedPoolRaise(50, 100)).toBe(200);
    expect(suggestedPoolRaise(10, 100)).toBe(200);
    expect(suggestedPoolRaise(50, 100)).toBeGreaterThan(100);
  });

  it("floors at 20 and survives garbage", () => {
    expect(suggestedPoolRaise(1, 10)).toBe(20);
    expect(suggestedPoolRaise(0, 0)).toBe(20);
    expect(suggestedPoolRaise(Number.NaN, Number.NaN)).toBe(20);
  });
});

describe("bucket constants", () => {
  it("the monitor bucket is a week, distinct from the hourly incident bucket", () => {
    expect(CAPACITY_MONITOR_BUCKET_MINUTES).toBe(7 * 24 * 60);
  });
});
