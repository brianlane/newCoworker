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
      route_step_id: "s_route",
      offered_log: ["+15550001111", "+15550002222"],
      tried: ["+15550001111"],
      claimed_by: "+15550002222",
      claimed_at_ms: 1_754_000_000_000,
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
      claimed_at_ms: "1754000000000",
      route_step_id: 7,
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
    // A stringified claim stamp is malformed: the claim clock is epoch ms.
    expect(parsed.claimed_at_ms).toBeUndefined();
    expect(parsed.route_step_id).toBeUndefined();
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

  it("keeps well-typed owner-direct nudge fields and drops malformed ones", () => {
    const good = parseRouting({ owner_direct: true, owner_nudges: 1, owner_direct_done: true });
    expect(good.owner_direct).toBe(true);
    expect(good.owner_nudges).toBe(1);
    expect(good.owner_direct_done).toBe(true);

    const bad = parseRouting({
      owner_direct: "yes",
      owner_nudges: "1",
      owner_direct_done: 1
    });
    expect(bad.owner_direct).toBeUndefined();
    expect(bad.owner_nudges).toBeUndefined();
    expect(bad.owner_direct_done).toBeUndefined();
  });

  it("keeps a well-typed solo_owner marker and drops malformed ones", () => {
    expect(parseRouting({ solo_owner: true }).solo_owner).toBe(true);
    expect(parseRouting({ solo_owner: false }).solo_owner).toBe(false);
    expect(parseRouting({ solo_owner: "yes" }).solo_owner).toBeUndefined();
    expect(parseRouting({}).solo_owner).toBeUndefined();
  });

  it("preserves unknown/legacy keys at runtime so persisting never drops data", () => {
    const parsed = parseRouting({ offered: "+15550001111", some_future_key: { x: 1 } });
    expect((parsed as Record<string, unknown>).some_future_key).toEqual({ x: 1 });
  });
});

describe("passed_by (who explicitly declined)", () => {
  it("parses as a string array, sanitized like the other phone lists", () => {
    const parsed = parseRouting({ passed_by: ["+15550001111", 42, null, "+15550002222"] });
    expect(parsed.passed_by).toEqual(["+15550001111", "+15550002222"]);
  });

  it("is absent when never set, so an untouched offer reminds everyone", () => {
    expect(parseRouting({ offered_all: ["+15550001111"] }).passed_by).toBeUndefined();
  });
});

describe("multiOfferHeadsUpLine", () => {
  it("names the lead so the reply is unambiguous", () => {
    const line = multiOfferHeadsUpLine(2, "Daniel");
    expect(line).toContain("*You have 2 unclaimed leads.*");
    expect(line).toContain("*1, Daniel*");
  });

  it("counts correctly past two", () => {
    expect(multiOfferHeadsUpLine(3, "Daniel")).toContain("*You have 3 unclaimed leads.*");
  });

  it("falls back to a name placeholder when the flow captured no lead name", () => {
    const line = multiOfferHeadsUpLine(2, "   ");
    expect(line).toContain("*1, <name>*");
    // Never promise a reply shape naming a lead we cannot match on.
    expect(line).not.toContain("*1, *");
  });

  it("no longer tells the team to reply 1 twice, which was never reliable", () => {
    expect(multiOfferHeadsUpLine(2, "Daniel")).not.toContain("twice");
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
