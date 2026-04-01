import { describe, expect, it } from "vitest";

import { getMonthLabel } from "@/lib/admin/dashboard";

describe("admin dashboard month labels", () => {
  it("pins the date to the first day before subtracting months", () => {
    const march31 = new Date("2026-03-31T12:00:00Z");

    expect(getMonthLabel(1, march31)).toBe("Feb");
    expect(getMonthLabel(2, march31)).toBe("Jan");
  });
});
