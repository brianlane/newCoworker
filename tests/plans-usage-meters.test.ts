import { describe, expect, it } from "vitest";
import {
  aiBudgetPlanMeter,
  planMeter,
  planMeterMinutes,
  smsPlanMeter,
  sumUsageGrants,
  voicePlanMeter
} from "@/lib/plans/usage-meters";

const MIN = 60;
const STANDARD_VOICE_CAP = 250 * MIN; // 15_000s, Standard included pool
const PACK_30 = 30 * MIN;

describe("sumUsageGrants", () => {
  it("treats null/empty as zeros", () => {
    expect(sumUsageGrants(null)).toEqual({ purchased: 0, remaining: 0, consumed: 0 });
    expect(sumUsageGrants(undefined)).toEqual({ purchased: 0, remaining: 0, consumed: 0 });
    expect(sumUsageGrants([])).toEqual({ purchased: 0, remaining: 0, consumed: 0 });
  });

  it("sums per grant so one malformed row cannot steal another grant's consumed", () => {
    expect(
      sumUsageGrants([
        { purchased: PACK_30, remaining: 0 },
        { purchased: 0, remaining: 120 }
      ])
    ).toEqual({ purchased: PACK_30, remaining: 120, consumed: PACK_30 });
  });

  it("ignores non-finite and negative amounts", () => {
    expect(
      sumUsageGrants([
        { purchased: Number.NaN, remaining: -5 },
        { purchased: "1800" as unknown as number, remaining: 600 }
      ])
    ).toEqual({ purchased: 1800, remaining: 600, consumed: 1200 });
  });
});

describe("planMeter", () => {
  it("clamps consumed to purchased and included used to included cap", () => {
    expect(
      planMeter({
        includedUsed: 20_000,
        includedCap: STANDARD_VOICE_CAP,
        unexpiredPurchased: PACK_30,
        unexpiredConsumed: 99_000
      })
    ).toEqual({ used: STANDARD_VOICE_CAP + PACK_30, cap: STANDARD_VOICE_CAP + PACK_30 });
  });

  it("treats garbage numbers as zero", () => {
    expect(
      planMeter({
        includedUsed: Number.NaN,
        includedCap: Number.NEGATIVE_INFINITY,
        unexpiredPurchased: -1,
        unexpiredConsumed: Number.NaN
      })
    ).toEqual({ used: 0, cap: 0 });
  });
});

describe("voicePlanMeter (Amy-style Standard 250 min + 30 min pack)", () => {
  it("at included cap, a new 30-min pack raises the denominator to 280", () => {
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: PACK_30,
      unexpiredConsumedSeconds: 0
    });
    expect(planMeterMinutes(meter)).toEqual({ used: 250, cap: 280 });
  });

  it("after pack usage the numerator climbs while the denominator stays included+grant", () => {
    // 11 min still in the pack → 19 min drawn from it → 269/280.
    const remaining = 11 * MIN;
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: PACK_30,
      unexpiredConsumedSeconds: PACK_30 - remaining
    });
    expect(planMeterMinutes(meter)).toEqual({ used: 269, cap: 280 });
  });

  it("does not use remaining pack balance as the denominator", () => {
    const remaining = 11 * MIN;
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: PACK_30,
      unexpiredConsumedSeconds: PACK_30 - remaining
    });
    expect(planMeterMinutes(meter).cap).toBe(280);
    expect(planMeterMinutes(meter).cap).not.toBe(250);
    expect(planMeterMinutes(meter).cap).not.toBe(261);
  });

  it("drops the grant from the denominator once it expires", () => {
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: 0,
      unexpiredConsumedSeconds: 0
    });
    expect(planMeterMinutes(meter)).toEqual({ used: 250, cap: 250 });
  });

  it("keeps a drained-but-unexpired pack in the denominator", () => {
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: PACK_30,
      unexpiredConsumedSeconds: PACK_30
    });
    expect(planMeterMinutes(meter)).toEqual({ used: 280, cap: 280 });
  });

  it("stacks multiple unexpired purchases (manual + auto-reload)", () => {
    const totals = sumUsageGrants([
      { purchased: PACK_30, remaining: 11 * MIN },
      { purchased: PACK_30, remaining: PACK_30 }
    ]);
    const meter = voicePlanMeter({
      committedIncludedSeconds: STANDARD_VOICE_CAP,
      tierCapSeconds: STANDARD_VOICE_CAP,
      unexpiredPurchasedSeconds: totals.purchased,
      unexpiredConsumedSeconds: totals.consumed
    });
    expect(planMeterMinutes(meter)).toEqual({ used: 269, cap: 310 });
  });
});

describe("smsPlanMeter", () => {
  const included = 5_000;

  it("at-cap analog: unused pack raises the denominator, numerator stays period usage", () => {
    expect(
      smsPlanMeter({
        usedThisPeriod: 4_180,
        includedCap: included,
        unexpiredPurchased: 500,
        unexpiredConsumed: 0
      })
    ).toEqual({ used: 4_180, cap: 5_500 });
  });

  it("after pack usage the numerator includes included+pack draw", () => {
    expect(
      smsPlanMeter({
        usedThisPeriod: 5_200,
        includedCap: included,
        unexpiredPurchased: 500,
        unexpiredConsumed: 200
      })
    ).toEqual({ used: 5_200, cap: 5_500 });
  });

  it("after expiry the expired pack drops out of both sides", () => {
    expect(
      smsPlanMeter({
        usedThisPeriod: 5_200,
        includedCap: included,
        unexpiredPurchased: 0,
        unexpiredConsumed: 0
      })
    ).toEqual({ used: 5_000, cap: 5_000 });
  });

  it("stacks two unexpired text packs", () => {
    const totals = sumUsageGrants([
      { purchased: 500, remaining: 300 },
      { purchased: 1_000, remaining: 1_000 }
    ]);
    expect(
      smsPlanMeter({
        usedThisPeriod: 5_200,
        includedCap: included,
        unexpiredPurchased: totals.purchased,
        unexpiredConsumed: totals.consumed
      })
    ).toEqual({ used: 5_200, cap: 6_500 });
  });

  it("does not let pack consumption exceed period usage when the ledger is behind", () => {
    expect(
      smsPlanMeter({
        usedThisPeriod: 100,
        includedCap: included,
        unexpiredPurchased: 500,
        unexpiredConsumed: 400
      })
    ).toEqual({ used: 400, cap: 5_500 });
  });
});

describe("aiBudgetPlanMeter", () => {
  const base = 10_000_000; // $10 Standard included
  const pack = 5_000_000; // $5 credit pack

  it("at included cap, a new credit pack raises the denominator", () => {
    expect(
      aiBudgetPlanMeter({
        spendMicros: base,
        baseCapMicros: base,
        unexpiredCreditMicros: pack
      })
    ).toEqual({ used: 10_000_000, cap: 15_000_000 });
  });

  it("after spend into the pack the numerator climbs", () => {
    expect(
      aiBudgetPlanMeter({
        spendMicros: 12_000_000,
        baseCapMicros: base,
        unexpiredCreditMicros: pack
      })
    ).toEqual({ used: 12_000_000, cap: 15_000_000 });
  });

  it("after credit expiry the extra grant drops out of the denominator", () => {
    expect(
      aiBudgetPlanMeter({
        spendMicros: 12_000_000,
        baseCapMicros: base,
        unexpiredCreditMicros: 0
      })
    ).toEqual({ used: 10_000_000, cap: 10_000_000 });
  });

  it("stacks unexpired credit packs", () => {
    expect(
      aiBudgetPlanMeter({
        spendMicros: 12_000_000,
        baseCapMicros: base,
        unexpiredCreditMicros: pack + pack
      })
    ).toEqual({ used: 12_000_000, cap: 20_000_000 });
  });

  it("under the included cap with no credit shows spend over the base", () => {
    expect(
      aiBudgetPlanMeter({
        spendMicros: 4_380_000,
        baseCapMicros: base,
        unexpiredCreditMicros: 0
      })
    ).toEqual({ used: 4_380_000, cap: 10_000_000 });
  });
});
