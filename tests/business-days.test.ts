import { describe, expect, it } from "vitest";
import { addBusinessDays, subtractBusinessDays } from "@/lib/datetime/business-days";

describe("addBusinessDays", () => {
  it("returns the same instant when n is 0", () => {
    const from = new Date("2026-07-29T15:00:00.000Z"); // Wednesday
    expect(addBusinessDays(from, 0).toISOString()).toBe(from.toISOString());
  });

  it("skips weekends when walking forward", () => {
    // Friday + 1 business day → Monday
    const friday = new Date("2026-07-31T12:00:00.000Z");
    expect(addBusinessDays(friday, 1).toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });

  it("crosses a month boundary on weekdays", () => {
    const thu = new Date("2026-07-30T08:00:00.000Z");
    expect(addBusinessDays(thu, 2).toISOString()).toBe("2026-08-03T08:00:00.000Z");
  });

  it("rejects negative or non-integer n", () => {
    const from = new Date("2026-07-29T00:00:00.000Z");
    expect(() => addBusinessDays(from, -1)).toThrow(/non-negative integer/);
    expect(() => addBusinessDays(from, 1.5)).toThrow(/non-negative integer/);
    expect(() => addBusinessDays(from, Number.NaN)).toThrow(/non-negative integer/);
  });
});

describe("subtractBusinessDays", () => {
  it("returns the same instant when n is 0", () => {
    const from = new Date("2026-08-05T15:00:00.000Z"); // Wednesday
    expect(subtractBusinessDays(from, 0).toISOString()).toBe(from.toISOString());
  });

  it("skips weekends when walking backward (5 business days)", () => {
    // Wednesday Aug 12 minus 5 biz days → Wednesday Aug 5
    const wed = new Date("2026-08-12T18:00:00.000Z");
    expect(subtractBusinessDays(wed, 5).toISOString()).toBe("2026-08-05T18:00:00.000Z");
  });

  it("lands on Friday when subtracting one business day from Monday", () => {
    const mon = new Date("2026-08-03T10:00:00.000Z");
    expect(subtractBusinessDays(mon, 1).toISOString()).toBe("2026-07-31T10:00:00.000Z");
  });

  it("rejects negative or non-integer n", () => {
    const from = new Date("2026-07-29T00:00:00.000Z");
    expect(() => subtractBusinessDays(from, -1)).toThrow(/non-negative integer/);
    expect(() => subtractBusinessDays(from, 2.2)).toThrow(/non-negative integer/);
  });
});
