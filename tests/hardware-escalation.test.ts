import { describe, expect, it } from "vitest";
import {
  ADVISOR_WINDOW_DAYS,
  DEFAULT_THRESHOLDS,
  ON_BOX_ERROR_SOURCES,
  advisorDeployedSize,
  buildEscalationAdviceEmail,
  dailyPeakConcurrency,
  evaluateEscalationSignals,
  nextSizeUp,
  weeklyPeriodKey,
  type BusinessAdvice,
  type CallInterval,
  type EvaluateInput
} from "../supabase/functions/_shared/hardware_escalation";

/** [start, end) interval on a given UTC day, minutes after midnight. */
function interval(day: string, startMin: number, endMin: number): CallInterval {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  return { startMs: midnight + startMin * 60_000, endMs: midnight + endMin * 60_000 };
}

function evaluateInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    business: { id: "biz-1", name: "Amy's Plumbing", tier: "starter", vps_size: null },
    callIntervals: [],
    windowStartYmd: "2026-07-01",
    windowEndYmd: "2026-07-07",
    windowVoiceSeconds: 0,
    monthToDateSms: 0,
    onBoxErrorCount: 0,
    limits: {
      maxConcurrentCalls: 1,
      voiceIncludedSecondsPerStripePeriod: 1_500,
      smsPerMonth: 100
    },
    ...overrides
  };
}

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
      interval("2026-07-03", 20, 30) // disjoint — still peak 1 that day
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

  it("fires voice_volume when projected monthly minutes clear the utilization bar", () => {
    // 35 settled min over the 7-day window → 150/mo projected vs 25
    // included → way over 80%.
    const advice = evaluateEscalationSignals(evaluateInput({ windowVoiceSeconds: 35 * 60 }));
    expect(advice!.signals).toEqual([
      { kind: "voice_volume", projectedMonthlyMinutes: 150, includedMinutes: 25 }
    ]);
  });

  it("does not mistake a small window total for a sustained pace", () => {
    // 4 settled minutes across the FIXED 7-day window projects ~17
    // min/month (< 80% of 25) — no flag.
    const advice = evaluateEscalationSignals(evaluateInput({ windowVoiceSeconds: 4 * 60 }));
    expect(advice).toBeNull();
  });

  it("skips voice_volume when the tier includes no voice", () => {
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

  it("fires sms_volume at 80% of the monthly cap", () => {
    const advice = evaluateEscalationSignals(evaluateInput({ monthToDateSms: 80 }));
    expect(advice!.signals).toEqual([{ kind: "sms_volume", monthToDateSms: 80, capSms: 100 }]);
  });

  it("skips sms_volume when the cap is not finite", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        monthToDateSms: 10_000,
        limits: {
          maxConcurrentCalls: 1,
          voiceIncludedSecondsPerStripePeriod: 1_500,
          smsPerMonth: Number.POSITIVE_INFINITY
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

  it("stacks multiple signals in one advice block", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        callIntervals: [interval("2026-07-01", 0, 10), interval("2026-07-02", 0, 10)],
        windowVoiceSeconds: 20 * 60,
        monthToDateSms: 95,
        onBoxErrorCount: 40
      })
    );
    expect(advice!.signals.map((s) => s.kind)).toEqual([
      "concurrency_saturation",
      "voice_volume",
      "sms_volume",
      "system_errors"
    ]);
  });
});

describe("buildEscalationAdviceEmail", () => {
  const base: BusinessAdvice = {
    businessId: "biz-1",
    businessName: "Amy's Plumbing",
    tier: "starter",
    currentSize: "kvm2",
    recommendedSize: "kvm4",
    signals: [
      { kind: "concurrency_saturation", daysAtCap: 3, capCalls: 1 },
      { kind: "voice_volume", projectedMonthlyMinutes: 40, includedMinutes: 25 },
      { kind: "sms_volume", monthToDateSms: 90, capSms: 100 },
      { kind: "system_errors", errorCount: 30 }
    ]
  };

  it("names the tenant in a single-candidate subject and describes every signal", () => {
    const { subject, text } = buildEscalationAdviceEmail([base], "https://app.example.com");
    expect(subject).toBe("[ops] Hardware escalation candidate — Amy's Plumbing (kvm2)");
    expect(text).toContain("hit the 1-concurrent-call cap on 3 of the last 7 days");
    expect(text).toContain("on pace for ~40 voice min/month (25 included)");
    expect(text).toContain("90 SMS month-to-date (cap 100)");
    expect(text).toContain("30 on-box error logs in the last 7 days (rowboat/ollama/voice)");
    expect(text).toContain("escalate kvm2 → kvm4 from the admin panel");
    expect(text).toContain("https://app.example.com/admin/biz-1");
  });

  it("counts candidates in a multi-tenant subject and handles the largest box", () => {
    const maxedOut: BusinessAdvice = {
      ...base,
      businessId: "biz-2",
      businessName: "Big Corp",
      tier: "standard",
      currentSize: "kvm8",
      recommendedSize: null,
      signals: [{ kind: "system_errors", errorCount: 50 }]
    };
    const { subject, text } = buildEscalationAdviceEmail(
      [base, maxedOut],
      "https://app.example.com"
    );
    expect(subject).toBe("[ops] 2 hardware escalation candidates");
    expect(text).toContain("Already on the largest box (kvm8)");
    expect(text).toContain("https://app.example.com/admin/biz-2");
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
