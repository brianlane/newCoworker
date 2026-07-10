import { describe, expect, it } from "vitest";
import {
  formatRunValue,
  retrySummary,
  routingSummary,
  runTriggerEntries,
  runVarEntries
} from "@/lib/ai-flows/run-stats";

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

describe("formatRunValue", () => {
  it("passes strings through untrimmed (an empty value must stay visible)", () => {
    expect(formatRunValue("hi")).toBe("hi");
    expect(formatRunValue("")).toBe("");
    expect(formatRunValue("  ")).toBe("  ");
  });
  it("joins arrays and stringifies objects / scalars / null", () => {
    expect(formatRunValue(["+1", "+2"])).toBe("+1, +2");
    expect(formatRunValue({ a: 1 })).toBe('{"a":1}');
    expect(formatRunValue(42)).toBe("42");
    expect(formatRunValue(true)).toBe("true");
    expect(formatRunValue(null)).toBe("");
    expect(formatRunValue(undefined)).toBe("");
  });
  it("degrades to String() for objects JSON cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatRunValue(cyclic)).toBe("[object Object]");
  });
});

describe("runTriggerEntries", () => {
  it("returns the trigger scope minus channel and empty padding", () => {
    expect(
      runTriggerEntries({
        trigger: {
          channel: "sms",
          windowText: "New lead: Dana 602-555-0100",
          from: "+16025550100",
          url: "",
          participants: ["+16025550100", "+15551230000"]
        }
      })
    ).toEqual([
      { key: "windowText", value: "New lead: Dana 602-555-0100" },
      { key: "from", value: "+16025550100" },
      { key: "participants", value: "+16025550100, +15551230000" }
    ]);
  });
  it("handles a missing or malformed trigger", () => {
    expect(runTriggerEntries({})).toEqual([]);
    expect(runTriggerEntries({ trigger: "junk" })).toEqual([]);
    expect(runTriggerEntries({ trigger: ["a"] })).toEqual([]);
  });
});

describe("runVarEntries", () => {
  it("keeps empty values (the usual failure clue) and hides engine markers", () => {
    expect(
      runVarEntries({
        vars: {
          lead_name: "Dana",
          lead_phone: "",
          claimed_agent: "none",
          __branch_br1: "arm1",
          __waited_s2: "1",
          _bypass_quiet_hours: "1"
        }
      })
    ).toEqual([
      { key: "lead_name", value: "Dana" },
      { key: "lead_phone", value: "" },
      { key: "claimed_agent", value: "none" }
    ]);
  });
  it("handles a missing or malformed vars object", () => {
    expect(runVarEntries({})).toEqual([]);
    expect(runVarEntries({ vars: 7 })).toEqual([]);
    expect(runVarEntries({ vars: ["x"] })).toEqual([]);
  });
});
