import { describe, expect, it } from "vitest";
import {
  CAPACITY_MONITOR_BUCKET_MINUTES,
  CAPACITY_MONITOR_LOOKBACK_DAYS,
  CAPACITY_MONITOR_OVERCOMMIT_RATIO,
  evaluateCapacityHeadroom,
  formatCapacityMonitorEmail,
  suggestedPoolRaise
} from "../supabase/functions/_shared/voice_capacity_monitor";

/**
 * The weekly headroom review: real refusals OR heavy overcommitment flag;
 * a quiet fleet under a comfortable pool stays silent. The email carries a
 * ready-to-send Telnyx raise draft, because the account pool is the one
 * knob their API will not automate.
 */
describe("evaluateCapacityHeadroom", () => {
  it("stays quiet when nothing was refused and commitment is sane", () => {
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 1],
      accountLimit: 10
    });
    expect(v).toEqual({ alert: false, reasons: [], committedCaps: 11 });
  });

  it("flags any real refusal, carrier or platform gate", () => {
    expect(
      evaluateCapacityHeadroom({
        carrierRejections: 1,
        platformBlocks: 0,
        tenantCaps: [],
        accountLimit: 10
      }).alert
    ).toBe(true);
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 3,
      tenantCaps: [],
      accountLimit: 10
    });
    expect(v.alert).toBe(true);
    expect(v.reasons[0]).toContain("3 platform pre-dial block(s)");
    expect(v.reasons[0]).toContain(`${CAPACITY_MONITOR_LOOKBACK_DAYS} days`);
  });

  it("flags overcommitment past the ratio, and only past it", () => {
    const at = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10],
      accountLimit: 10
    });
    // Exactly 2x is the boundary: not yet flagged.
    expect(at.alert).toBe(false);
    const over = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10, 10, 1],
      accountLimit: 10
    });
    expect(over.alert).toBe(true);
    expect(over.reasons[0]).toContain("21 channels");
    expect(over.reasons[0]).toContain(`${CAPACITY_MONITOR_OVERCOMMIT_RATIO}x`);
  });

  it("never divides by a zero pool", () => {
    const v = evaluateCapacityHeadroom({
      carrierRejections: 0,
      platformBlocks: 0,
      tenantCaps: [10],
      accountLimit: 0
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
    const email = formatCapacityMonitorEmail({ verdict, inputs, suggestedPool: 20 });
    expect(email.subject).toContain("raise the account pool");
    expect(email.text).toContain("2 carrier channel-limit rejection(s)");
    expect(email.text).toContain("Granted account pool: 10");
    expect(email.text).toContain("Sum of per-tenant carrier caps: 30");
    expect(email.text).toContain("support@telnyx.com");
    expect(email.text).toContain("outbound concurrent call limit to 20");
    expect(email.text).toContain("TELNYX_ACCOUNT_CHANNEL_LIMIT");
    expect(email.text).toContain("AI coworker");
  });
});

describe("suggestedPoolRaise", () => {
  it("doubles the pool, floored at 20, and survives garbage", () => {
    expect(suggestedPoolRaise(10)).toBe(20);
    expect(suggestedPoolRaise(50)).toBe(100);
    expect(suggestedPoolRaise(0)).toBe(20);
    expect(suggestedPoolRaise(Number.NaN)).toBe(20);
  });
});

describe("bucket constants", () => {
  it("the monitor bucket is a week, distinct from the hourly incident bucket", () => {
    expect(CAPACITY_MONITOR_BUCKET_MINUTES).toBe(7 * 24 * 60);
  });
});
