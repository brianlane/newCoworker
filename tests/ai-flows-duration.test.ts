import { describe, expect, it } from "vitest";
import { formatDurationMinutes } from "@/lib/ai-flows/duration";

describe("formatDurationMinutes", () => {
  it("uses the largest exact unit", () => {
    expect(formatDurationMinutes(1)).toBe("1 minute");
    expect(formatDurationMinutes(2)).toBe("2 minutes");
    expect(formatDurationMinutes(60)).toBe("1 hour");
    expect(formatDurationMinutes(300)).toBe("5 hours");
    expect(formatDurationMinutes(1440)).toBe("1 day");
    expect(formatDurationMinutes(2880)).toBe("2 days");
    expect(formatDurationMinutes(10_080)).toBe("1 week");
    expect(formatDurationMinutes(43_200)).toBe("1 month");
    expect(formatDurationMinutes(525_600)).toBe("1 year");
  });

  it("keeps every non-zero remainder so exact settings never display rounded", () => {
    expect(formatDurationMinutes(90)).toBe("1 hour 30 minutes");
    expect(formatDurationMinutes(1500)).toBe("1 day 1 hour");
    expect(formatDurationMinutes(1441)).toBe("1 day 1 minute");
    expect(formatDurationMinutes(11_520)).toBe("1 week 1 day");
    expect(formatDurationMinutes(43_199)).toBe("4 weeks 1 day 23 hours 59 minutes");
  });

  it("degrades bad input to 0 minutes", () => {
    expect(formatDurationMinutes(0)).toBe("0 minutes");
    expect(formatDurationMinutes(-5)).toBe("0 minutes");
    expect(formatDurationMinutes(Number.NaN)).toBe("0 minutes");
  });

  it("rounds fractional minutes", () => {
    expect(formatDurationMinutes(59.6)).toBe("1 hour");
  });
});
