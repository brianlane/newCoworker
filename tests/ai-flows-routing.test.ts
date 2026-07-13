import { describe, expect, it } from "vitest";
import {
  multiOfferHeadsUpLine,
  parseRouting,
  routingOfContext
} from "../supabase/functions/_shared/ai_flows/routing";

describe("parseRouting", () => {
  it("returns an empty object for non-object input", () => {
    expect(parseRouting(null)).toEqual({});
    expect(parseRouting(undefined)).toEqual({});
    expect(parseRouting("str")).toEqual({});
    expect(parseRouting(42)).toEqual({});
    expect(parseRouting(["a"])).toEqual({});
  });

  it("passes well-formed fields through and returns a copy", () => {
    const raw = {
      offered: "+15550001111",
      offered_log: ["+15550001111", "+15550002222"],
      tried: ["+15550001111"],
      claimed_by: "+15550002222",
      step_index: 3,
      route_step_index: 3,
      last_event: "claim",
      first_to_claim: false,
      late_claim: true,
      pass_reasons: ["Dave: out of town"]
    };
    const parsed = parseRouting(raw);
    expect(parsed).toEqual(raw);
    parsed.offered = "+15550009999";
    expect(raw.offered).toBe("+15550001111");
  });

  it("drops malformed typed fields instead of trusting them", () => {
    const parsed = parseRouting({
      offered: 42,
      claimed_by: { nested: true },
      step_index: "3",
      tried: "not-an-array",
      offered_log: [1, "+15550001111", null],
      pass_reasons: { a: 1 },
      last_event: "explode",
      first_to_claim: "false",
      late_claim: "yes",
      late_claimed: 1,
      auto_assigned: "true"
    });
    expect(parsed.offered).toBeUndefined();
    expect(parsed.claimed_by).toBeUndefined();
    expect(parsed.step_index).toBeUndefined();
    expect(parsed.tried).toBeUndefined();
    // Arrays are filtered to their string members, not dropped wholesale.
    expect(parsed.offered_log).toEqual(["+15550001111"]);
    expect(parsed.pass_reasons).toBeUndefined();
    expect(parsed.last_event).toBeUndefined();
    expect(parsed.first_to_claim).toBeUndefined();
    expect(parsed.late_claim).toBeUndefined();
    expect(parsed.late_claimed).toBeUndefined();
    expect(parsed.auto_assigned).toBeUndefined();
  });

  it("keeps a well-typed auto_assigned marker (lead auto-assignment claims)", () => {
    expect(parseRouting({ auto_assigned: true }).auto_assigned).toBe(true);
    expect(parseRouting({ auto_assigned: false }).auto_assigned).toBe(false);
  });

  it("preserves unknown/legacy keys at runtime so persisting never drops data", () => {
    const parsed = parseRouting({ offered: "+15550001111", some_future_key: { x: 1 } });
    expect((parsed as Record<string, unknown>).some_future_key).toEqual({ x: 1 });
  });
});

describe("multiOfferHeadsUpLine", () => {
  it("uses the two-offer wording for exactly 2 pending", () => {
    const line = multiOfferHeadsUpLine(2);
    expect(line).toContain("2 pending offers");
    expect(line).toContain('reply "1" twice to take both');
  });

  it("generalizes for 3+ pending", () => {
    const line = multiOfferHeadsUpLine(3);
    expect(line).toContain("3 pending offers");
    expect(line).toContain('once per offer');
  });
});

describe("routingOfContext", () => {
  it("parses context.routing and returns null when absent or malformed", () => {
    expect(routingOfContext(null)).toBeNull();
    expect(routingOfContext({})).toBeNull();
    expect(routingOfContext({ routing: "nope" })).toBeNull();
    expect(routingOfContext({ routing: ["a"] })).toBeNull();
    expect(routingOfContext({ routing: { offered: "+15550001111" } })).toEqual({
      offered: "+15550001111"
    });
  });
});
