import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONSTANT_PIN_PATHS,
  decideTelnyxRateDrift,
  retargetConstantPins,
  type RateCalibration,
  type RateReport
} from "../.github/scripts/telnyx-rate-drift";

const calibration: RateCalibration = {
  terminationCentsPerMinute: 0.5333,
  measuredThrough: "2026-08-27",
  note: "kept"
};

const pricingSource = "voiceTelnyxCentsPerMinute: 0.9,\n";

function pins(value = "0.9"): Record<string, string> {
  const body = `expect(ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute).toBe(${value});\n`;
  return Object.fromEntries(CONSTANT_PIN_PATHS.map((path) => [path, body]));
}

function report(overrides: Partial<RateReport> = {}): RateReport {
  return {
    actualsSince: "2026-09-01",
    baselineCentsPerMinute: 0.5,
    actuals: { billedSeconds: 16_860, cents: 166.8, centsPerMinute: 0.5936 },
    history: {
      // 2026-09-21 Monday run: 392 min at 0.5c, plus a short tail at 2c, 0.9c,
      // 1c, and 7c. 227.8c / 407 min is what the current zone table prices.
      billedMinutes: 407,
      modeledCents: 392 * 0.5 + 5 * 2 + 2 * 0.9 + 6 * 1 + 2 * 7,
      minutesAboveBaseline: 15
    },
    ...overrides
  };
}

describe("decideTelnyxRateDrift", () => {
  it("does not move the constant when the invoice matches the zone table", () => {
    const decision = decideTelnyxRateDrift({
      report: report(),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(false);
    expect(decision.pricingSource).toBeNull();
    expect(decision.summary).toContain("Destination mix, not a Zone 1 list-price change");
    expect(decision.summary).toContain("392");
    expect(decision.summary).toContain("0.5c baseline");
  });

  it("leaves a second pass on the same mix as a no-op", () => {
    const first = decideTelnyxRateDrift({
      report: report(),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    const second = decideTelnyxRateDrift({
      report: report(),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(second).toEqual(first);
  });

  it("does not edit when the drift versus the calibration is under 0.05c", () => {
    const decision = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 12_000, cents: 110, centsPerMinute: 0.55 },
        history: { billedMinutes: 200, modeledCents: 100, minutesAboveBaseline: 0 }
      }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(false);
    expect(decision.summary).toContain("under the 0.05c threshold");
  });

  it("does not edit on a thin invoice sample", () => {
    const decision = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 600, cents: 10, centsPerMinute: 1 }
      }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(false);
    expect(decision.summary).toContain("need 60");
  });

  it("moves the constant when the invoice leaves the zone table", () => {
    const decision = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 12_000, cents: 140, centsPerMinute: 0.7 },
        history: { billedMinutes: 200, modeledCents: 100, minutesAboveBaseline: 0 }
      }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(true);
    expect(decision.pricingSource).toContain("voiceTelnyxCentsPerMinute: 1.07,");
    expect(decision.calibration?.terminationCentsPerMinute).toBe(0.7);
    expect(decision.calibration?.note).toBe("kept");
    for (const path of CONSTANT_PIN_PATHS) {
      expect(decision.pinSources?.[path]).toContain(".toBe(1.07)");
    }
    expect(decision.summary).toContain("does not explain the charge");
  });

  it("measures ~0 drift the Monday after a real edit lands", () => {
    const bumped = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 12_000, cents: 140, centsPerMinute: 0.7 },
        history: { billedMinutes: 200, modeledCents: 100, minutesAboveBaseline: 0 }
      }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    const again = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 12_000, cents: 140, centsPerMinute: 0.7 },
        history: { billedMinutes: 200, modeledCents: 100, minutesAboveBaseline: 0 }
      }),
      calibration: bumped.calibration!,
      pricingSource: bumped.pricingSource!,
      pinSources: bumped.pinSources!
    });
    expect(again.changed).toBe(false);
    expect(again.summary).toContain("under the 0.05c threshold");
  });

  it("still edits when classified history is too thin to explain the invoice", () => {
    const decision = decideTelnyxRateDrift({
      report: report({
        actuals: { billedSeconds: 12_000, cents: 140, centsPerMinute: 0.7 },
        history: { billedMinutes: 30, modeledCents: 15, minutesAboveBaseline: 0 }
      }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(true);
    expect(decision.summary).toContain("Not enough classified call history");
  });

  it("still edits when the report has no classified history", () => {
    const decision = decideTelnyxRateDrift({
      report: report({ history: undefined }),
      calibration,
      pricingSource,
      pinSources: pins()
    });
    expect(decision.changed).toBe(true);
    expect(decision.pricingSource).toContain("voiceTelnyxCentsPerMinute: 0.96,");
  });

  it("refuses to rewrite a pin that is not the current constant", () => {
    expect(() =>
      decideTelnyxRateDrift({
        report: report({ history: undefined }),
        calibration,
        pricingSource,
        pinSources: pins("1.5")
      })
    ).toThrow(/does not own/);
  });
});

describe("the pins the Monday job has to commit", () => {
  it("moves the real toBe(0.9) pins and the workflow git-adds each file", () => {
    const workflow = readFileSync(".github/workflows/telnyx-voice-rate-cutover.yml", "utf8");
    for (const path of CONSTANT_PIN_PATHS) {
      expect(workflow).toContain(path);
      const source = readFileSync(path, "utf8");
      const moved = retargetConstantPins(source, 0.9, 0.96, path);
      expect(moved).toContain("voiceTelnyxCentsPerMinute).toBe(0.96)");
      expect(moved).not.toContain("voiceTelnyxCentsPerMinute).toBe(0.9)");
    }
  });
});
