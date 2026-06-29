import { describe, expect, it } from "vitest";
import { retrySummary, routingSummary } from "@/lib/ai-flows/run-stats";

describe("routingSummary", () => {
  it("returns null when there is no routing context", () => {
    expect(routingSummary({})).toBeNull();
    expect(routingSummary({ routing: "junk" as unknown as Record<string, unknown> })).toBeNull();
    expect(routingSummary({ routing: {} })).toBeNull();
  });
  it("counts the current offer as one outstanding offer", () => {
    expect(routingSummary({ routing: { offered: "+16025550100", tried: [] } })).toBe(
      "offered to 1 employee · awaiting reply"
    );
  });
  it("counts retired offers plus the current one", () => {
    expect(
      routingSummary({ routing: { offered: "+16025550100", tried: ["+16025550101"] } })
    ).toBe("offered to 2 employees · awaiting reply");
  });
  it("reports the claimer (name preferred, phone fallback)", () => {
    expect(
      routingSummary({ routing: { tried: ["+1"], claimed_by: "+2", claimed_name: "Dave" } })
    ).toBe("offered to 2 employees · claimed by Dave");
    expect(routingSummary({ routing: { tried: [], claimed_by: "+16025550100" } })).toBe(
      "offered to 1 employee · claimed by +16025550100"
    );
  });
  it("reports owner fallback when everyone passed", () => {
    expect(routingSummary({ routing: { tried: ["+1", "+2"] } })).toBe(
      "offered to 2 employees · no claim (owner fallback)"
    );
  });
});

describe("retrySummary", () => {
  it("returns null for zero / negative / non-finite", () => {
    expect(retrySummary(0)).toBeNull();
    expect(retrySummary(-1)).toBeNull();
    expect(retrySummary(Number.NaN)).toBeNull();
  });
  it("pluralizes", () => {
    expect(retrySummary(1)).toBe("1 retry");
    expect(retrySummary(3)).toBe("3 retries");
  });
});
