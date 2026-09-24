import { describe, expect, it } from "vitest";
import { emptySoftwareCosts, monthlySoftwareCosts, softwareCostTotal } from "@/lib/admin/software-costs";

describe("monthly software receipts", () => {
  it("uses the card receipt for each vendor, the same amount every month", () => {
    expect(monthlySoftwareCosts()).toEqual({
      vercelCents: 2_166,
      resendCents: 2_000,
      zoomCents: 1_699,
      cursorCents: 20_000
    });
    expect(softwareCostTotal(monthlySoftwareCosts())).toBe(2_166 + 2_000 + 1_699 + 20_000);
    expect(softwareCostTotal(emptySoftwareCosts())).toBe(0);
  });
});
