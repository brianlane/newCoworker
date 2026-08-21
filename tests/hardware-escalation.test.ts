import { describe, expect, it } from "vitest";
import {
  ADVISOR_MIN_METRIC_SAMPLES,
  ADVISOR_WINDOW_DAYS,
  DEFAULT_THRESHOLDS,
  ON_BOX_ERROR_SOURCES,
  adviceLogMessage,
  advisorDeployedSize,
  autoReloadCovers,
  buildEscalationAdviceEmail,
  dailyPeakConcurrency,
  evaluateEscalationSignals,
  isAdvisorFleetCandidate,
  nextSizeUp,
  signalCategory,
  weeklyPeriodKey,
  type AdvisorHostMetrics,
  type BusinessAdvice,
  type CallInterval,
  type EscalationSignal,
  type EvaluateInput
} from "../supabase/functions/_shared/hardware_escalation";

/** [start, end) interval on a given UTC day, minutes after midnight. */
function interval(day: string, startMin: number, endMin: number): CallInterval {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  return { startMs: midnight + startMin * 60_000, endMs: midnight + endMin * 60_000 };
}

/** An hourly host aggregate with enough samples to count. */
function metricsRow(overrides: Partial<AdvisorHostMetrics> = {}): AdvisorHostMetrics {
  return {
    cpuCount: 2,
    load1Max: 0.2,
    load1Mean: 0.1,
    memAvailableMinMib: 4485,
    memTotalMib: 7940,
    swapUsedMaxMib: 15,
    samples: 30,
    ...overrides
  };
}

/** N identical hourly aggregates. */
function metricsRows(n: number, overrides: Partial<AdvisorHostMetrics> = {}): AdvisorHostMetrics[] {
  return Array.from({ length: n }, () => metricsRow(overrides));
}

function evaluateInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    business: { id: "biz-1", name: "Amy's Plumbing", tier: "starter", vps_size: null },
    callIntervals: [],
    windowStartYmd: "2026-07-01",
    windowEndYmd: "2026-07-07",
    windowVoiceSeconds: 0,
    monthToDateSmsUnits: 0,
    onBoxErrorCount: 0,
    limits: {
      maxConcurrentCalls: 1,
      voiceIncludedSecondsPerStripePeriod: 1_500,
      smsPerMonth: 100
    },
    ...overrides
  };
}

describe("isAdvisorFleetCandidate", () => {
  it("keeps an online tenant with a box", () => {
    expect(
      isAdvisorFleetCandidate({ is_paused: false, hostinger_vps_id: "1815606" })
    ).toBe(true);
    expect(isAdvisorFleetCandidate({ is_paused: null, hostinger_vps_id: 1815606 })).toBe(true);
  });

  it("skips paused tenants even when they still have a box", () => {
    expect(
      isAdvisorFleetCandidate({ is_paused: true, hostinger_vps_id: "1815606" })
    ).toBe(false);
  });

  it("skips boxless tenants (null or empty hostinger_vps_id)", () => {
    expect(isAdvisorFleetCandidate({ is_paused: false, hostinger_vps_id: null })).toBe(false);
    expect(isAdvisorFleetCandidate({ is_paused: false, hostinger_vps_id: "" })).toBe(false);
  });
});

describe("advisorDeployedSize", () => {
  it("honors every valid pin", () => {
    expect(advisorDeployedSize("starter", "kvm1")).toBe("kvm1");
    expect(advisorDeployedSize("starter", "kvm2")).toBe("kvm2");
    expect(advisorDeployedSize("standard", "kvm4")).toBe("kvm4");
    expect(advisorDeployedSize("standard", "kvm8")).toBe("kvm8");
  });

  it("falls back to legacy deployed defaults when unpinned or corrupt", () => {
    expect(advisorDeployedSize("starter", null)).toBe("kvm2");
    expect(advisorDeployedSize("standard", null)).toBe("kvm8");
    expect(advisorDeployedSize("starter", "kvm16")).toBe("kvm2");
  });
});

describe("nextSizeUp", () => {
  it("walks the ladder and tops out at kvm8", () => {
    expect(nextSizeUp("kvm1")).toBe("kvm2");
    expect(nextSizeUp("kvm2")).toBe("kvm4");
    expect(nextSizeUp("kvm4")).toBe("kvm8");
    expect(nextSizeUp("kvm8")).toBeNull();
  });
});

describe("weeklyPeriodKey", () => {
  it("returns the Monday of the week for a mid-week date", () => {
    // Wednesday 2026-07-08 → Monday 2026-07-06
    expect(weeklyPeriodKey(new Date("2026-07-08T15:30:00Z"))).toBe("2026-07-06");
  });

  it("maps Sunday back to the preceding Monday", () => {
    // Sunday 2026-07-12 → Monday 2026-07-06
    expect(weeklyPeriodKey(new Date("2026-07-12T01:00:00Z"))).toBe("2026-07-06");
  });

  it("returns a Monday for a Monday", () => {
    expect(weeklyPeriodKey(new Date("2026-07-06T00:00:00Z"))).toBe("2026-07-06");
  });

  it("defaults to now", () => {
    expect(weeklyPeriodKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("dailyPeakConcurrency", () => {
  it("returns an empty map for no intervals", () => {
    expect(dailyPeakConcurrency([]).size).toBe(0);
  });

  it("records each day's max overlap", () => {
    const peaks = dailyPeakConcurrency([
      interval("2026-07-01", 0, 10),
      interval("2026-07-01", 5, 15), // overlaps → 2
      interval("2026-07-02", 30, 40) // lone call next day → 1
    ]);
    expect(peaks.get("2026-07-01")).toBe(2);
    expect(peaks.get("2026-07-02")).toBe(1);
  });

  it("does not count back-to-back calls (end meets start) as overlap", () => {
    const peaks = dailyPeakConcurrency([
      interval("2026-07-01", 0, 10),
      interval("2026-07-01", 10, 20)
    ]);
    expect(peaks.get("2026-07-01")).toBe(1);
  });

  it("attributes a cross-midnight call to both its start and end days", () => {
    const peaks = dailyPeakConcurrency([interval("2026-07-01", 23 * 60 + 50, 24 * 60 + 10)]);
    expect(peaks.get("2026-07-01")).toBe(1);
    expect(peaks.get("2026-07-02")).toBe(1);
  });
});

describe("evaluateEscalationSignals", () => {
  it("returns null when nothing fires", () => {
    expect(evaluateEscalationSignals(evaluateInput())).toBeNull();
  });

  it("fires concurrency_saturation after enough days at the cap", () => {
    const intervals = [
      interval("2026-07-01", 0, 10),
      interval("2026-07-02", 0, 10),
      interval("2026-07-03", 0, 10),
      interval("2026-07-03", 20, 30) // disjoint, still peak 1 that day
    ];
    const advice = evaluateEscalationSignals(evaluateInput({ callIntervals: intervals }));
    expect(advice).not.toBeNull();
    expect(advice!.signals).toEqual([
      { kind: "concurrency_saturation", daysAtCap: 3, capCalls: 1 }
    ]);
    expect(advice!.currentSize).toBe("kvm2");
    expect(advice!.recommendedSize).toBe("kvm4");
  });

  it("does not fire concurrency for a single day at the cap", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({ callIntervals: [interval("2026-07-01", 0, 10)] })
    );
    expect(advice).toBeNull();
  });

  it("ignores peak days outside the rolling window bounds", () => {
    // One in-window day at cap; two out-of-window days (before start, after
    // end) must not count toward daysAtCap.
    const advice = evaluateEscalationSignals(
      evaluateInput({
        callIntervals: [
          interval("2026-06-25", 0, 10),
          interval("2026-07-03", 0, 10),
          interval("2026-07-09", 0, 10)
        ]
      })
    );
    expect(advice).toBeNull();
  });

  it("requires the OVERLAP to reach the cap, not just call volume", () => {
    // Standard cap is 10 concurrent: two sequential calls a day never get
    // near it no matter how many days they repeat.
    const intervals = Array.from({ length: 7 }, (_, i) => [
      interval(`2026-07-0${i + 1}`, 0, 10),
      interval(`2026-07-0${i + 1}`, 20, 30)
    ]).flat();
    const advice = evaluateEscalationSignals(
      evaluateInput({
        business: { id: "biz-2", name: "Big Corp", tier: "standard", vps_size: null },
        callIntervals: intervals,
        limits: {
          maxConcurrentCalls: 10,
          voiceIncludedSecondsPerStripePeriod: 15_000,
          smsPerMonth: 3_000
        }
      })
    );
    expect(advice).toBeNull();
  });

  it("skips the concurrency signal entirely when the cap is zero", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        callIntervals: [interval("2026-07-01", 0, 10), interval("2026-07-02", 0, 10)],
        limits: {
          maxConcurrentCalls: 0,
          voiceIncludedSecondsPerStripePeriod: 1_500,
          smsPerMonth: 100
        }
      })
    );
    expect(advice).toBeNull();
  });

  // --- CPU, the signal that actually answers "is this box too small" -------

  it("fires cpu_saturation on sustained per-core load", () => {
    // 6 busy hours at 1.0 mean load per core (2.0 across 2 cores) out of 20
    // measured. The rest of the fleet idles around 0.07 total.
    const advice = evaluateEscalationSignals(
      evaluateInput({
        hostMetrics: [...metricsRows(6, { load1Mean: 2.0, load1Max: 2.6 }), ...metricsRows(14)]
      })
    );
    expect(advice!.signals).toEqual([
      {
        kind: "cpu_saturation",
        saturatedReports: 6,
        totalReports: 20,
        worstMeanLoadPerCore: 1,
        cpuCount: 2
      }
    ]);
    expect(advice!.hardwareSignals).toHaveLength(1);
    expect(advice!.usageSignals).toEqual([]);
    expect(advice!.recommendedSize).toBe("kvm4");
  });

  it("does not fire cpu_saturation on one busy hour", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        hostMetrics: [...metricsRows(1, { load1Mean: 4.0 }), ...metricsRows(20)]
      })
    );
    expect(advice).toBeNull();
  });

  it("normalizes load by core count, so a big box is not flagged for the same load", () => {
    // 2.0 load: saturated on 2 cores, comfortable on 8.
    const busy = evaluateEscalationSignals(
      evaluateInput({ hostMetrics: metricsRows(10, { cpuCount: 2, load1Mean: 2.0 }) })
    );
    expect(busy!.signals[0].kind).toBe("cpu_saturation");
    const roomy = evaluateEscalationSignals(
      evaluateInput({ hostMetrics: metricsRows(10, { cpuCount: 8, load1Mean: 2.0 }) })
    );
    expect(roomy).toBeNull();
  });

  it("reports the WORST hour's per-core load, with that hour's core count", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        hostMetrics: [
          ...metricsRows(5, { load1Mean: 1.8 }),
          metricsRow({ load1Mean: 3.4 }),
          ...metricsRows(2, { load1Mean: 1.7 })
        ]
      })
    );
    const sig = advice!.signals[0] as Extract<EscalationSignal, { kind: "cpu_saturation" }>;
    expect(sig.worstMeanLoadPerCore).toBeCloseTo(1.7, 5);
    expect(sig.saturatedReports).toBe(8);
  });

  it("ignores hourly aggregates too thin to be evidence", () => {
    // A report built from 3 of the ~30 samples covers 6 minutes of the hour.
    const advice = evaluateEscalationSignals(
      evaluateInput({ hostMetrics: metricsRows(20, { load1Mean: 4.0, samples: 3 }) })
    );
    expect(advice).toBeNull();
    expect(ADVISOR_MIN_METRIC_SAMPLES).toBe(10);
  });

  it("ignores aggregates whose divisors are unusable", () => {
    // cpuCount 0 would make every per-core figure infinite; memTotalMib 0
    // would make every headroom fraction NaN.
    expect(
      evaluateEscalationSignals(
        evaluateInput({ hostMetrics: metricsRows(20, { cpuCount: 0, load1Mean: 9 }) })
      )
    ).toBeNull();
    expect(
      evaluateEscalationSignals(
        evaluateInput({ hostMetrics: metricsRows(20, { memTotalMib: 0, memAvailableMinMib: 0 }) })
      )
    ).toBeNull();
  });

  it("fires nothing at all when the box reports no metrics", () => {
    // A heartbeat that predates the metrics block must read as "not
    // measured", never as a quiet box.
    expect(evaluateEscalationSignals(evaluateInput({ hostMetrics: [] }))).toBeNull();
    expect(evaluateEscalationSignals(evaluateInput())).toBeNull();
  });

  // --- memory --------------------------------------------------------------

  it("fires memory_pressure on repeated low headroom", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        hostMetrics: [
          ...metricsRows(6, { memAvailableMinMib: 400, swapUsedMaxMib: 20 }),
          ...metricsRows(4)
        ]
      })
    );
    const sig = advice!.signals[0] as Extract<EscalationSignal, { kind: "memory_pressure" }>;
    expect(sig.kind).toBe("memory_pressure");
    expect(sig.pressuredReports).toBe(6);
    expect(sig.totalReports).toBe(10);
    expect(sig.lowestAvailableFraction).toBeCloseTo(400 / 7940, 6);
    expect(sig.highestSwapUsedMib).toBe(20);
  });

  it("fires memory_pressure on swap alone, without low headroom", () => {
    // A box can spill to swap during a burst and look fine at the sample.
    const advice = evaluateEscalationSignals(
      evaluateInput({ hostMetrics: metricsRows(6, { swapUsedMaxMib: 900 }) })
    );
    const sig = advice!.signals[0] as Extract<EscalationSignal, { kind: "memory_pressure" }>;
    expect(sig.kind).toBe("memory_pressure");
    expect(sig.highestSwapUsedMib).toBe(900);
  });

  it("treats the fleet's idle swap as normal, not as pressure", () => {
    // Amy's box idles with 15 MiB of 4095 in use. Zero tolerance here would
    // flag every box in the fleet forever.
    expect(evaluateEscalationSignals(evaluateInput({ hostMetrics: metricsRows(50) }))).toBeNull();
  });

  it("does not fire memory_pressure below the report count", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({ hostMetrics: metricsRows(5, { memAvailableMinMib: 100 }) })
    );
    expect(advice).toBeNull();
  });

  // --- the AI budget's real hardware consequence ---------------------------

  it("fires local_model_fallback on a SINGLE local turn", () => {
    // Both surfaces were moved off the local model for being unusable
    // (~100s+ per owner-chat turn), so one turn means a tenant is living in
    // the configuration we abandoned.
    const advice = evaluateEscalationSignals(evaluateInput({ localModelTurns: 1 }));
    expect(advice!.signals).toEqual([
      { kind: "local_model_fallback", localTurns: 1, refusedTurns: 0, hasLocalModel: true }
    ]);
    expect(advice!.recommendedSize).toBe("kvm4");
  });

  it("fires local_model_fallback on refusals alone (a box with no local model)", () => {
    const advice = evaluateEscalationSignals(evaluateInput({ refusedOverBudgetTurns: 4 }));
    expect(advice!.signals).toEqual([
      { kind: "local_model_fallback", localTurns: 0, refusedTurns: 4, hasLocalModel: false }
    ]);
  });

  it("reports both when a tenant degraded and then refused", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({ localModelTurns: 3, refusedOverBudgetTurns: 2 })
    );
    expect(advice!.signals).toEqual([
      { kind: "local_model_fallback", localTurns: 3, refusedTurns: 2, hasLocalModel: true }
    ]);
  });

  // --- usage signals, and why they are not hardware -------------------------

  it("fires voice_volume when projected monthly minutes clear the utilization bar", () => {
    // 35 settled min over the 7-day window → 150/mo projected vs 25
    // included → way over 80%.
    const advice = evaluateEscalationSignals(evaluateInput({ windowVoiceSeconds: 35 * 60 }));
    expect(advice!.signals).toEqual([
      { kind: "voice_volume", projectedMonthlyMinutes: 150, includedMinutes: 25, packMinutes: 0 }
    ]);
  });

  it("gives a usage-only tenant NO size recommendation", () => {
    // The bug this module was rewritten to remove: a tenant near their plan's
    // voice minutes was told to buy a bigger box, while their box sat idle.
    const advice = evaluateEscalationSignals(evaluateInput({ windowVoiceSeconds: 35 * 60 }));
    expect(advice!.hardwareSignals).toEqual([]);
    expect(advice!.usageSignals).toHaveLength(1);
    expect(advice!.recommendedSize).toBeNull();
  });

  it("counts purchased packs toward the voice allowance", () => {
    // 150/mo projected. Against 25 included alone that is 600%; with 500
    // purchased minutes the allowance is 525 and the pace is 29%.
    const advice = evaluateEscalationSignals(
      evaluateInput({ windowVoiceSeconds: 35 * 60, voiceBonusSeconds: 500 * 60 })
    );
    expect(advice).toBeNull();
  });

  it("still fires when the packs are not enough", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({ windowVoiceSeconds: 35 * 60, voiceBonusSeconds: 100 * 60 })
    );
    expect(advice!.signals).toEqual([
      { kind: "voice_volume", projectedMonthlyMinutes: 150, includedMinutes: 25, packMinutes: 100 }
    ]);
  });

  it("says nothing to a tenant whose auto-reload is armed on a live card", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        windowVoiceSeconds: 35 * 60,
        autoReload: { voiceArmed: true, smsArmed: false, hasCard: true }
      })
    );
    expect(advice).toBeNull();
  });

  it("an armed rule with no card on file cannot charge, so it does not suppress", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        windowVoiceSeconds: 35 * 60,
        autoReload: { voiceArmed: true, smsArmed: false, hasCard: false }
      })
    );
    expect(advice!.signals[0].kind).toBe("voice_volume");
  });

  it("does not mistake a small window total for a sustained pace", () => {
    // 4 settled minutes across the FIXED 7-day window projects ~17
    // min/month (< 80% of 25), no flag.
    const advice = evaluateEscalationSignals(evaluateInput({ windowVoiceSeconds: 4 * 60 }));
    expect(advice).toBeNull();
  });

  it("skips voice_volume when the tier includes no voice and holds no packs", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        windowVoiceSeconds: 100 * 60,
        limits: {
          maxConcurrentCalls: 1,
          voiceIncludedSecondsPerStripePeriod: 0,
          smsPerMonth: 100
        }
      })
    );
    expect(advice).toBeNull();
  });

  it("fires sms_volume at 80% of the monthly cap, in TEXT UNITS", () => {
    const advice = evaluateEscalationSignals(evaluateInput({ monthToDateSmsUnits: 80 }));
    expect(advice!.signals).toEqual([
      { kind: "sms_volume", monthToDateUnits: 80, capUnits: 100, packUnits: 0 }
    ]);
  });

  it("counts purchased packs toward the SMS allowance", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({ monthToDateSmsUnits: 80, smsBonusUnits: 500 })
    );
    expect(advice).toBeNull();
  });

  it("suppresses sms_volume for an armed SMS auto-reload", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        monthToDateSmsUnits: 95,
        autoReload: { voiceArmed: false, smsArmed: true, hasCard: true }
      })
    );
    expect(advice).toBeNull();
  });

  it("skips sms_volume when the cap is not finite", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        monthToDateSmsUnits: 10_000,
        limits: {
          maxConcurrentCalls: 1,
          voiceIncludedSecondsPerStripePeriod: 1_500,
          smsPerMonth: Number.POSITIVE_INFINITY
        }
      })
    );
    expect(advice).toBeNull();
  });

  it("skips sms_volume when there is no allowance at all", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        monthToDateSmsUnits: 10,
        limits: {
          maxConcurrentCalls: 1,
          voiceIncludedSecondsPerStripePeriod: 1_500,
          smsPerMonth: 0
        }
      })
    );
    expect(advice).toBeNull();
  });

  it("fires system_errors at the error-count threshold", () => {
    const advice = evaluateEscalationSignals(evaluateInput({ onBoxErrorCount: 25 }));
    expect(advice!.signals).toEqual([{ kind: "system_errors", errorCount: 25 }]);
  });

  it("honors custom thresholds", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        onBoxErrorCount: 3,
        thresholds: { ...DEFAULT_THRESHOLDS, systemErrorCount: 3 }
      })
    );
    expect(advice!.signals).toEqual([{ kind: "system_errors", errorCount: 3 }]);
  });

  it("reports no next size when already on kvm8", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        business: { id: "biz-2", name: "Big Corp", tier: "standard", vps_size: "kvm8" },
        onBoxErrorCount: 100,
        limits: {
          maxConcurrentCalls: 10,
          voiceIncludedSecondsPerStripePeriod: 15_000,
          smsPerMonth: 3_000
        }
      })
    );
    expect(advice!.currentSize).toBe("kvm8");
    expect(advice!.recommendedSize).toBeNull();
  });

  it("stacks multiple signals and splits them by category", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        callIntervals: [interval("2026-07-01", 0, 10), interval("2026-07-02", 0, 10)],
        hostMetrics: metricsRows(8, { load1Mean: 2.4, memAvailableMinMib: 200 }),
        localModelTurns: 2,
        windowVoiceSeconds: 20 * 60,
        monthToDateSmsUnits: 95,
        onBoxErrorCount: 40
      })
    );
    expect(advice!.signals.map((sig) => sig.kind)).toEqual([
      "concurrency_saturation",
      "cpu_saturation",
      "memory_pressure",
      "local_model_fallback",
      "system_errors",
      "voice_volume",
      "sms_volume"
    ]);
    expect(advice!.hardwareSignals.map((sig) => sig.kind)).toEqual([
      "concurrency_saturation",
      "cpu_saturation",
      "memory_pressure",
      "local_model_fallback",
      "system_errors"
    ]);
    expect(advice!.usageSignals.map((sig) => sig.kind)).toEqual(["voice_volume", "sms_volume"]);
    // A hardware signal is present, so the size recommendation is earned.
    expect(advice!.recommendedSize).toBe("kvm4");
  });
});

describe("signalCategory", () => {
  it("puts plan-limit signals in usage and everything else in hardware", () => {
    expect(signalCategory("voice_volume")).toBe("usage");
    expect(signalCategory("sms_volume")).toBe("usage");
    for (const kind of [
      "concurrency_saturation",
      "cpu_saturation",
      "memory_pressure",
      "local_model_fallback",
      "system_errors"
    ] as const) {
      expect(signalCategory(kind)).toBe("hardware");
    }
  });
});

describe("autoReloadCovers", () => {
  it("covers only the category that is armed, and only with a card", () => {
    const armed = { voiceArmed: true, smsArmed: false, hasCard: true };
    expect(autoReloadCovers(armed, "voice")).toBe(true);
    expect(autoReloadCovers(armed, "sms")).toBe(false);
    expect(autoReloadCovers({ ...armed, hasCard: false }, "voice")).toBe(false);
    expect(autoReloadCovers({ voiceArmed: false, smsArmed: true, hasCard: true }, "sms")).toBe(true);
  });

  it("covers nothing when the posture could not be read", () => {
    expect(autoReloadCovers(null, "voice")).toBe(false);
    expect(autoReloadCovers(null, "sms")).toBe(false);
  });
});

describe("buildEscalationAdviceEmail", () => {
  function advice(overrides: Partial<BusinessAdvice> = {}): BusinessAdvice {
    const signals: EscalationSignal[] = overrides.signals ?? [];
    return {
      businessId: "biz-1",
      businessName: "Amy's Plumbing",
      tier: "starter",
      currentSize: "kvm2",
      recommendedSize: "kvm4",
      hardwareSignals: signals.filter((sig) => signalCategory(sig.kind) === "hardware"),
      usageSignals: signals.filter((sig) => signalCategory(sig.kind) === "usage"),
      ...overrides,
      signals
    };
  }

  const everySignal: EscalationSignal[] = [
    { kind: "concurrency_saturation", daysAtCap: 3, capCalls: 1 },
    {
      kind: "cpu_saturation",
      saturatedReports: 9,
      totalReports: 160,
      worstMeanLoadPerCore: 1.45,
      cpuCount: 2
    },
    {
      kind: "memory_pressure",
      pressuredReports: 7,
      totalReports: 160,
      lowestAvailableFraction: 0.06,
      highestSwapUsedMib: 1200
    },
    { kind: "local_model_fallback", localTurns: 14, refusedTurns: 0, hasLocalModel: true },
    { kind: "system_errors", errorCount: 30 },
    { kind: "voice_volume", projectedMonthlyMinutes: 40, includedMinutes: 25, packMinutes: 0 },
    { kind: "sms_volume", monthToDateUnits: 90, capUnits: 100, packUnits: 0 }
  ];

  it("names the tenant in a single-candidate subject and describes every signal", () => {
    const { subject, text } = buildEscalationAdviceEmail(
      [advice({ signals: everySignal })],
      "https://app.example.com"
    );
    expect(subject).toBe("[ops] Hardware escalation candidate, Amy's Plumbing (kvm2)");
    expect(text).toContain("hit the 1-concurrent-call cap on 3 of the last 7 days");
    expect(text).toContain(
      "averaged 1.45 load per core at its worst hour (2 cores), across 9 busy hours of 160 measured"
    );
    expect(text).toContain(
      "memory down to 6% available, peak swap 1200 MiB, across 7 hours of 160 measured"
    );
    expect(text).toContain("14 replies generated on the box's own model, AI budget exhausted");
    expect(text).toContain("30 on-box error logs in the last 7 days (rowboat/ollama/voice)");
    expect(text).toContain("on pace for ~40 voice min/month (25 included, no packs held)");
    expect(text).toContain("90 SMS text units month-to-date (cap 100, no packs held)");
    expect(text).toContain("escalate kvm2 → kvm4 from the admin panel");
    expect(text).toContain("https://app.example.com/admin/biz-1");
  });

  it("keeps the size recommendation out of the usage section", () => {
    const { text } = buildEscalationAdviceEmail(
      [advice({ signals: everySignal })],
      "https://app.example.com"
    );
    const hardwareAt = text.indexOf("HARDWARE.");
    const usageAt = text.indexOf("USAGE.");
    expect(hardwareAt).toBeGreaterThan(-1);
    expect(usageAt).toBeGreaterThan(hardwareAt);
    // The only "escalate" instruction is above the usage section.
    expect(text.indexOf("escalate kvm2")).toBeLessThan(usageAt);
    expect(text.slice(usageAt)).not.toContain("escalate");
    expect(text).toContain("packs and auto-reload cover it without touching the box");
  });

  it("does not say 'escalation' when only usage fired", () => {
    const usageOnly = advice({
      recommendedSize: null,
      signals: [
        { kind: "voice_volume", projectedMonthlyMinutes: 227, includedMinutes: 250, packMinutes: 0 }
      ]
    });
    const { subject, text } = buildEscalationAdviceEmail([usageOnly], "https://app.example.com");
    expect(subject).toBe("[ops] Usage review, Amy's Plumbing");
    expect(text).not.toContain("HARDWARE.");
    expect(text).not.toContain("escalate");
  });

  it("counts usage-only tenants in a plural subject", () => {
    const one = advice({
      recommendedSize: null,
      signals: [{ kind: "sms_volume", monthToDateUnits: 90, capUnits: 100, packUnits: 0 }]
    });
    const two = advice({
      businessId: "biz-2",
      businessName: "Big Corp",
      recommendedSize: null,
      signals: [{ kind: "sms_volume", monthToDateUnits: 4200, capUnits: 5000, packUnits: 0 }]
    });
    const { subject } = buildEscalationAdviceEmail([one, two], "https://app.example.com");
    expect(subject).toBe("[ops] Usage review, 2 tenants");
  });

  it("counts candidates in a multi-tenant subject and handles the largest box", () => {
    const maxedOut = advice({
      businessId: "biz-2",
      businessName: "Big Corp",
      tier: "standard",
      currentSize: "kvm8",
      recommendedSize: null,
      signals: [{ kind: "system_errors", errorCount: 50 }]
    });
    const { subject, text } = buildEscalationAdviceEmail(
      [advice({ signals: everySignal }), maxedOut],
      "https://app.example.com"
    );
    expect(subject).toBe("[ops] 2 hardware escalation candidates");
    expect(text).toContain("Already on the largest box (kvm8)");
    expect(text).toContain("https://app.example.com/admin/biz-2");
  });

  it("shows packs in the allowance when the tenant holds some", () => {
    const { text } = buildEscalationAdviceEmail(
      [
        advice({
          recommendedSize: null,
          signals: [
            {
              kind: "voice_volume",
              projectedMonthlyMinutes: 400,
              includedMinutes: 250,
              packMinutes: 240
            },
            { kind: "sms_volume", monthToDateUnits: 4800, capUnits: 5000, packUnits: 500 }
          ]
        })
      ],
      "https://app.example.com"
    );
    expect(text).toContain("on pace for ~400 voice min/month (250 included + 240 from packs)");
    expect(text).toContain("4800 SMS text units month-to-date (cap 5000 + 500 from packs)");
  });

  it("distinguishes a degraded reply from a refused one", () => {
    const both = buildEscalationAdviceEmail(
      [
        advice({
          signals: [
            { kind: "local_model_fallback", localTurns: 6, refusedTurns: 2, hasLocalModel: true }
          ]
        })
      ],
      "https://app.example.com"
    ).text;
    expect(both).toContain(
      "6 replies generated on the box's own model and 2 refused outright, AI budget exhausted"
    );

    const refusedOnly = buildEscalationAdviceEmail(
      [
        advice({
          signals: [
            { kind: "local_model_fallback", localTurns: 0, refusedTurns: 5, hasLocalModel: false }
          ]
        })
      ],
      "https://app.example.com"
    ).text;
    // On kvm1 this is an outage, not a slowdown, and the wording has to say so.
    expect(refusedOnly).toContain("5 inbound replies REFUSED");
    expect(refusedOnly).toContain("customers got silence");
  });

  it("omits the swap clause when the box never swapped", () => {
    const { text } = buildEscalationAdviceEmail(
      [
        advice({
          signals: [
            {
              kind: "memory_pressure",
              pressuredReports: 7,
              totalReports: 20,
              lowestAvailableFraction: 0.04,
              highestSwapUsedMib: 0
            }
          ]
        })
      ],
      "https://app.example.com"
    );
    expect(text).toContain("memory down to 4% available, across 7 hours of 20 measured");
  });
});

describe("adviceLogMessage", () => {
  function advice(overrides: Partial<BusinessAdvice>): BusinessAdvice {
    const signals: EscalationSignal[] = overrides.signals ?? [];
    return {
      businessId: "biz-1",
      businessName: "Amy's Plumbing",
      tier: "starter",
      currentSize: "kvm2",
      recommendedSize: "kvm4",
      hardwareSignals: signals.filter((sig) => signalCategory(sig.kind) === "hardware"),
      usageSignals: signals.filter((sig) => signalCategory(sig.kind) === "usage"),
      ...overrides,
      signals
    };
  }

  it("names the migration for a hardware finding", () => {
    expect(
      adviceLogMessage(advice({ signals: [{ kind: "system_errors", errorCount: 40 }] }))
    ).toBe("Sustained load: system_errors, consider migrating kvm2 → kvm4");
  });

  it("says the box is maxed out only when hardware fired and the ladder ran out", () => {
    expect(
      adviceLogMessage(
        advice({
          currentSize: "kvm8",
          recommendedSize: null,
          signals: [{ kind: "system_errors", errorCount: 40 }]
        })
      )
    ).toBe("Sustained load: system_errors, already on kvm8 (largest box)");
  });

  it("does NOT call an idle kvm2 maxed out just because it has no recommendation", () => {
    // `recommendedSize` is null in two cases that mean opposite things. This
    // tenant's box is fine; they are near a plan limit.
    const msg = adviceLogMessage(
      advice({
        recommendedSize: null,
        signals: [
          {
            kind: "voice_volume",
            projectedMonthlyMinutes: 227,
            includedMinutes: 250,
            packMinutes: 0
          }
        ]
      })
    );
    expect(msg).toBe(
      "Near a plan limit: voice_volume, a packs or plan conversation, not hardware"
    );
    expect(msg).not.toContain("largest box");
    expect(msg).not.toContain("migrating");
  });

  it("reports both halves when a tenant tripped hardware AND a plan limit", () => {
    expect(
      adviceLogMessage(
        advice({
          signals: [
            { kind: "local_model_fallback", localTurns: 2, refusedTurns: 0, hasLocalModel: true },
            { kind: "sms_volume", monthToDateUnits: 90, capUnits: 100, packUnits: 0 }
          ]
        })
      )
    ).toBe(
      "Sustained load: local_model_fallback, consider migrating kvm2 → kvm4. " +
        "Also near a plan limit: sms_volume"
    );
  });
});

describe("ON_BOX_ERROR_SOURCES", () => {
  it("covers the on-box services", () => {
    expect(ON_BOX_ERROR_SOURCES).toEqual(["rowboat", "ollama", "voice"]);
  });
});

describe("ADVISOR_WINDOW_DAYS", () => {
  it("is the 7-day rolling window every signal divides by", () => {
    expect(ADVISOR_WINDOW_DAYS).toBe(7);
  });
});
