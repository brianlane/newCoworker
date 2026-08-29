import { describe, it, expect } from "vitest";
import type { BillingHistoryCell } from "@/lib/admin/billing-history";

const EMPTY: BillingHistoryCell = {
  messages: 0,
  textUnits: 0,
  voiceMinutes: 0,
  calls: 0,
  telnyxCents: 0,
  geminiCents: 0,
  revenueCents: 0
};
import {
  METRICS,
  MONTH_CHOICES,
  barPercent,
  changeTone,
  formatChange,
  formatMetric,
  resolveMetric,
  resolveMonthCount
} from "@/lib/admin/billing-history-view";

const CELL = {
  ...EMPTY,
  messages: 450,
  textUnits: 2072,
  voiceMinutes: 12.34,
  calls: 7,
  telnyxCents: 3178,
  geminiCents: 288,
  revenueCents: 85_200
};

describe("metric catalog", () => {
  it("picks the right number out of a cell for every metric", () => {
    const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m.pick(CELL)]));
    expect(byKey).toEqual({
      telnyx: 3178,
      gemini: 288,
      vendor: 3466,
      revenue: 85_200,
      textUnits: 2072,
      messages: 450,
      voiceMinutes: 12.34,
      calls: 7
    });
  });

  it("marks only the cost metrics as bad when they rise", () => {
    const bad = METRICS.filter((m) => m.upIsBad).map((m) => m.key);
    expect(bad).toEqual(["telnyx", "gemini", "vendor"]);
  });

  it("defaults to Telnyx cost, which is the reason the page exists", () => {
    expect(resolveMetric(undefined).key).toBe("telnyx");
    expect(resolveMetric("nonsense").key).toBe("telnyx");
    expect(resolveMetric("revenue").key).toBe("revenue");
  });

  it("only accepts the month counts it offers", () => {
    expect(MONTH_CHOICES).toEqual([6, 12, 24]);
    expect(resolveMonthCount("6")).toBe(6);
    expect(resolveMonthCount("24")).toBe(24);
    expect(resolveMonthCount("7")).toBe(12);
    expect(resolveMonthCount(undefined)).toBe(12);
    expect(resolveMonthCount("drop table")).toBe(12);
  });
});

describe("formatMetric", () => {
  it("renders money from cents", () => {
    expect(formatMetric(3178, "money")).toBe("$31.78");
    expect(formatMetric(0, "money")).toBe("$0.00");
    expect(formatMetric(123_456, "money")).toBe("$1,234.56");
  });

  it("renders minutes to one decimal", () => {
    expect(formatMetric(12.34, "minutes")).toBe("12.3");
  });

  it("renders counts as whole grouped numbers", () => {
    expect(formatMetric(2072.4, "count")).toBe("2,072");
  });
});

describe("barPercent", () => {
  it("scales against the tallest bar", () => {
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(100, 100)).toBe(100);
  });

  it("keeps a small non-zero value visible", () => {
    expect(barPercent(1, 10_000)).toBe(4);
  });

  it("renders nothing for a zero value or an all-zero series", () => {
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(-1, 100)).toBe(0);
  });
});

describe("changeTone", () => {
  it("calls a small move flat rather than colouring noise", () => {
    expect(changeTone(4.9, true)).toBe("flat");
    expect(changeTone(-4.9, false)).toBe("flat");
  });

  it("reads a rise as bad for a cost and good for revenue", () => {
    expect(changeTone(65, true)).toBe("bad");
    expect(changeTone(65, false)).toBe("good");
  });

  it("reads a fall as good for a cost and bad for revenue", () => {
    expect(changeTone(-30, true)).toBe("good");
    expect(changeTone(-30, false)).toBe("bad");
  });

  it("has no opinion when there is no previous month", () => {
    expect(changeTone(null, true)).toBe("unknown");
  });
});

describe("formatChange", () => {
  it("signs a rise and rounds", () => {
    expect(formatChange(124.1)).toBe("+124%");
  });

  it("keeps a fall negative", () => {
    expect(formatChange(-30.4)).toBe("-30%");
  });

  it("does not sign a rounded zero", () => {
    expect(formatChange(0.2)).toBe("0%");
  });

  it("says new when there is nothing to compare against", () => {
    expect(formatChange(null)).toBe("new");
  });
});
