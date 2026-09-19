import { describe, expect, it } from "vitest";
import {
  aiBudgetPlanMeter,
  planMeterMinutes,
  smsPlanMeterFromGrants,
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

describe("smsPlanMeterFromGrants", () => {
  const included = 5_000;
  const windowStart = "2026-09-01T00:00:00.000Z";
  const nowMs = Date.parse("2026-09-19T12:00:00.000Z");
  const leftoverLive = {
    purchased: 500,
    remaining: 300,
    purchasedAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z"
  };

  it("counts leftover pack overflow after a window rollover", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [leftoverLive],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_200, cap: 5_500 });
  });

  it("drops overflow from a pack that expired this window while another live pack keeps the cap", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          leftoverLive,
          {
            purchased: 500,
            remaining: 0,
            purchasedAt: "2026-09-05T00:00:00.000Z",
            expiresAt: "2026-09-10T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_500 });
  });

  it("drops leftover last-window consumption covering an older pack that expired this window", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          leftoverLive,
          {
            purchased: 500,
            remaining: 0,
            purchasedAt: "2026-07-01T00:00:00.000Z",
            expiresAt: "2026-09-10T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_500 });
  });

  it("counts same-window pack draw on a still-live grant", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          {
            purchased: 500,
            remaining: 300,
            purchasedAt: "2026-09-05T00:00:00.000Z",
            expiresAt: "2026-10-01T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_200, cap: 5_500 });
  });

  it("does not wipe included usage after rollover while under cap", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 100,
        includedCap: included,
        grants: [{ ...leftoverLive, remaining: 100 }],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 100, cap: 5_500 });
  });

  it("treats a missing window as no this-period pack draw", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [leftoverLive],
        windowStart: "",
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_500 });
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [leftoverLive],
        windowStart: null,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_500 });
  });

  it("treats missing expiry as live and null grants as no packs", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [{ purchased: 500, remaining: 300, purchasedAt: "2026-08-10T00:00:00.000Z" }],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_200, cap: 5_500 });
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: null,
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_000 });
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: undefined,
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_000 });
  });

  it("ignores packs that expired in a previous window", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          leftoverLive,
          {
            purchased: 500,
            remaining: 0,
            purchasedAt: "2026-07-01T00:00:00.000Z",
            expiresAt: "2026-08-15T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_200, cap: 5_500 });
  });

  it("uses Date.now when nowMs is omitted", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 4_180,
        includedCap: included,
        grants: [
          {
            purchased: 500,
            remaining: 500,
            purchasedAt: "2026-09-05T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z"
          }
        ],
        windowStart
      })
    ).toEqual({ used: 4_180, cap: 5_500 });
  });

  it("drops an expired-only grant from both sides", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          {
            purchased: 500,
            remaining: 0,
            purchasedAt: "2026-09-05T00:00:00.000Z",
            expiresAt: "2026-09-10T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_000, cap: 5_000 });
  });

  it("stacks two live packs in the denominator", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: 5_200,
        includedCap: included,
        grants: [
          leftoverLive,
          {
            purchased: 1_000,
            remaining: 1_000,
            purchasedAt: "2026-09-05T00:00:00.000Z",
            expiresAt: "2026-10-01T00:00:00.000Z"
          }
        ],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 5_200, cap: 6_500 });
  });

  it("treats garbage SMS amounts as zero", () => {
    expect(
      smsPlanMeterFromGrants({
        usedThisPeriod: Number.NaN,
        includedCap: Number.NEGATIVE_INFINITY,
        grants: [{ purchased: -1, remaining: Number.NaN }],
        windowStart,
        nowMs
      })
    ).toEqual({ used: 0, cap: 0 });
  });
});

describe("voicePlanMeter clamps", () => {
  it("clamps consumed to purchased and included used to included cap", () => {
    expect(
      voicePlanMeter({
        committedIncludedSeconds: 20_000,
        tierCapSeconds: STANDARD_VOICE_CAP,
        unexpiredPurchasedSeconds: PACK_30,
        unexpiredConsumedSeconds: 99_000
      })
    ).toEqual({ used: STANDARD_VOICE_CAP + PACK_30, cap: STANDARD_VOICE_CAP + PACK_30 });
  });

  it("treats garbage numbers as zero", () => {
    expect(
      voicePlanMeter({
        committedIncludedSeconds: Number.NaN,
        tierCapSeconds: Number.NEGATIVE_INFINITY,
        unexpiredPurchasedSeconds: -1,
        unexpiredConsumedSeconds: Number.NaN
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
