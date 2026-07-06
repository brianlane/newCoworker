import { describe, expect, it } from "vitest";
import {
  ADVISOR_WINDOW_DAYS,
  DEFAULT_THRESHOLDS,
  ON_BOX_ERROR_SOURCES,
  advisorDeployedSize,
  buildEscalationAdviceEmail,
  evaluateEscalationSignals,
  nextSizeUp,
  weeklyPeriodKey,
  type BusinessAdvice,
  type DailyUsageRow,
  type EvaluateInput
} from "../supabase/functions/_shared/hardware_escalation";

function usageRow(overrides: Partial<DailyUsageRow> = {}): DailyUsageRow {
  return {
    business_id: "biz-1",
    usage_date: "2026-07-01",
    voice_minutes_used: 0,
    sms_sent: 0,
    peak_concurrent_calls: 0,
    ...overrides
  };
}

function evaluateInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    business: { id: "biz-1", name: "Amy's Plumbing", tier: "starter", vps_size: null },
    usageRows: [],
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

describe("evaluateEscalationSignals", () => {
  it("returns null when nothing fires", () => {
    expect(evaluateEscalationSignals(evaluateInput())).toBeNull();
  });

  it("fires concurrency_saturation after enough days at the cap", () => {
    const rows = [
      usageRow({ usage_date: "2026-07-01", peak_concurrent_calls: 1 }),
      usageRow({ usage_date: "2026-07-02", peak_concurrent_calls: 1 }),
      usageRow({ usage_date: "2026-07-03", peak_concurrent_calls: 0 })
    ];
    const advice = evaluateEscalationSignals(evaluateInput({ usageRows: rows }));
    expect(advice).not.toBeNull();
    expect(advice!.signals).toEqual([
      { kind: "concurrency_saturation", daysAtCap: 2, capCalls: 1 }
    ]);
    expect(advice!.currentSize).toBe("kvm2");
    expect(advice!.recommendedSize).toBe("kvm4");
  });

  it("does not fire concurrency for a single day at the cap", () => {
    const rows = [usageRow({ peak_concurrent_calls: 1 })];
    expect(evaluateEscalationSignals(evaluateInput({ usageRows: rows }))).toBeNull();
  });

  it("skips the concurrency signal entirely when the cap is zero", () => {
    const rows = [
      usageRow({ usage_date: "2026-07-01" }),
      usageRow({ usage_date: "2026-07-02" })
    ];
    const advice = evaluateEscalationSignals(
      evaluateInput({
        usageRows: rows,
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
    // 7 days × 5 min/day → 150/mo projected vs 25 included → way over 80%.
    const rows = Array.from({ length: 7 }, (_, i) =>
      usageRow({ usage_date: `2026-07-0${i + 1}`, voice_minutes_used: 5 })
    );
    const advice = evaluateEscalationSignals(evaluateInput({ usageRows: rows }));
    expect(advice!.signals).toEqual([
      { kind: "voice_volume", projectedMonthlyMinutes: 150, includedMinutes: 25 }
    ]);
  });

  it("does not mistake a single-day voice burst for a sustained pace", () => {
    // 4 minutes on one active day: dividing by the FIXED 7-day window gives
    // ~17 projected min/month (< 80% of 25) — dividing by the 1 row present
    // would have projected 120 and false-flagged the tenant.
    const advice = evaluateEscalationSignals(
      evaluateInput({ usageRows: [usageRow({ voice_minutes_used: 4 })] })
    );
    expect(advice).toBeNull();
  });

  it("skips voice_volume when the tier includes no voice", () => {
    const advice = evaluateEscalationSignals(
      evaluateInput({
        usageRows: [usageRow({ voice_minutes_used: 100 })],
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
    const rows = [
      usageRow({ usage_date: "2026-07-01", peak_concurrent_calls: 1, voice_minutes_used: 10 }),
      usageRow({ usage_date: "2026-07-02", peak_concurrent_calls: 1, voice_minutes_used: 10 })
    ];
    const advice = evaluateEscalationSignals(
      evaluateInput({ usageRows: rows, monthToDateSms: 95, onBoxErrorCount: 40 })
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
