import { describe, expect, it } from "vitest";
import { LEAD_TYPE_TAGS, mergeTags } from "../scripts/oneshot/amy-roster-lead-type-tags";

/**
 * Amy: "Dave and Gabby for Seller leads and Dave, Gabby, and Jason for Buyer
 * leads." Before this the rule was true in exactly one place, the two arms of
 * one flow, and Jason appeared nowhere else on the account.
 */
describe("LEAD_TYPE_TAGS", () => {
  it("puts Jason on buyers only", () => {
    expect(LEAD_TYPE_TAGS["Jason Lane"]).toEqual(["buyer"]);
  });

  it("puts Dave and Gabby on everything", () => {
    for (const n of ["Dave Lane", "Gabrielle Mota"]) {
      expect(LEAD_TYPE_TAGS[n]).toEqual(["buyer", "seller", "both"]);
    }
  });

  /**
   * Amy is deliberately absent. Her roster row already carries
   * team_broadcast_enabled=false, which is what keeps her out of team alerts;
   * tagging her would not change that and would imply she is part of an
   * audience she is deliberately not part of. She stays on the CLAIM OFFERS,
   * which this does not touch.
   */
  it("leaves Amy untagged", () => {
    expect(LEAD_TYPE_TAGS["Amy Laidlaw"]).toBeUndefined();
  });
});

describe("mergeTags", () => {
  it("adds without disturbing tags set for another purpose", () => {
    expect(mergeTags(["spanish"], ["buyer", "seller"])).toEqual(["spanish", "buyer", "seller"]);
  });

  it("is idempotent and case-insensitive about duplicates", () => {
    expect(mergeTags(["Buyer"], ["buyer"])).toEqual(["Buyer"]);
    expect(mergeTags(["buyer", "seller", "both"], ["buyer", "seller", "both"])).toEqual([
      "buyer",
      "seller",
      "both"
    ]);
  });

  it("handles an empty starting list", () => {
    expect(mergeTags([], ["buyer"])).toEqual(["buyer"]);
  });
});
