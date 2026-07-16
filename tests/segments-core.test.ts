import { describe, expect, it } from "vitest";
import {
  describeSegmentFilters,
  matchesSegment,
  segmentFiltersSchema,
  type SegmentContactFacts,
  type SegmentFilters
} from "@/lib/segments/core";

/**
 * Smart Lists core: the saved-filter schema and the pure membership matcher
 * (all criteria AND; empty filters match everyone; date-less contacts fail
 * "within" checks and pass "overdue" ones — a never-contacted lead is
 * maximally overdue).
 */

const NOW = Date.parse("2026-07-16T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const facts = (over: Partial<SegmentContactFacts> = {}): SegmentContactFacts => ({
  tags: ["New Lead", "VIP"],
  type: "customer",
  ownerEmployeeId: "00000000-0000-0000-0000-0000000000aa",
  lastChannel: "sms",
  lastInteractionAt: new Date(NOW - 2 * DAY).toISOString(),
  totalInteractions: 4,
  createdAt: new Date(NOW - 10 * DAY).toISOString(),
  ...over
});

describe("segmentFiltersSchema", () => {
  it("accepts a full filter set and an empty object", () => {
    expect(segmentFiltersSchema.parse({})).toEqual({});
    const full = segmentFiltersSchema.parse({
      tagsAny: ["VIP"],
      type: "customer",
      ownerEmployeeId: "11111111-1111-4111-8111-111111111111",
      lastChannel: "sms",
      lastInteractionWithinDays: 7,
      lastInteractionOlderThanDays: 30,
      neverContacted: false,
      createdWithinDays: 14
    });
    expect(full.tagsAny).toEqual(["VIP"]);
  });

  it("accepts the 'none' owner sentinel and rejects unknown keys / bad shapes", () => {
    expect(segmentFiltersSchema.parse({ ownerEmployeeId: "none" }).ownerEmployeeId).toBe(
      "none"
    );
    expect(segmentFiltersSchema.safeParse({ bogus: true }).success).toBe(false);
    expect(segmentFiltersSchema.safeParse({ tagsAny: [] }).success).toBe(false);
    expect(segmentFiltersSchema.safeParse({ lastInteractionWithinDays: 0 }).success).toBe(
      false
    );
    expect(segmentFiltersSchema.safeParse({ type: "alien" }).success).toBe(false);
  });
});

describe("matchesSegment", () => {
  it("empty filters match every contact", () => {
    expect(matchesSegment(facts(), {}, NOW)).toBe(true);
  });

  it("tagsAny matches case-insensitively on ANY listed tag", () => {
    expect(matchesSegment(facts(), { tagsAny: ["vip"] }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { tagsAny: ["Won", "new lead"] }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { tagsAny: ["Won"] }, NOW)).toBe(false);
  });

  it("type must equal exactly", () => {
    expect(matchesSegment(facts(), { type: "customer" }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { type: "tester" }, NOW)).toBe(false);
  });

  it("ownerEmployeeId: specific member vs the 'none' sentinel", () => {
    const owner = "00000000-0000-0000-0000-0000000000aa";
    expect(matchesSegment(facts(), { ownerEmployeeId: owner }, NOW)).toBe(true);
    expect(
      matchesSegment(facts(), { ownerEmployeeId: "00000000-0000-0000-0000-0000000000bb" }, NOW)
    ).toBe(false);
    expect(matchesSegment(facts(), { ownerEmployeeId: "none" }, NOW)).toBe(false);
    expect(
      matchesSegment(facts({ ownerEmployeeId: null }), { ownerEmployeeId: "none" }, NOW)
    ).toBe(true);
    expect(
      matchesSegment(facts({ ownerEmployeeId: null }), { ownerEmployeeId: owner }, NOW)
    ).toBe(false);
  });

  it("lastChannel matches case-insensitively; a null channel never matches", () => {
    expect(matchesSegment(facts(), { lastChannel: "SMS" }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { lastChannel: "voice" }, NOW)).toBe(false);
    expect(matchesSegment(facts({ lastChannel: null }), { lastChannel: "sms" }, NOW)).toBe(
      false
    );
  });

  it("lastInteractionWithinDays: recent passes, stale and never fail", () => {
    expect(matchesSegment(facts(), { lastInteractionWithinDays: 3 }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { lastInteractionWithinDays: 1 }, NOW)).toBe(false);
    expect(
      matchesSegment(facts({ lastInteractionAt: null }), { lastInteractionWithinDays: 3 }, NOW)
    ).toBe(false);
    // An unparseable timestamp behaves like "never".
    expect(
      matchesSegment(
        facts({ lastInteractionAt: "junk" }),
        { lastInteractionWithinDays: 3 },
        NOW
      )
    ).toBe(false);
  });

  it("lastInteractionOlderThanDays: overdue passes, recent fails, never counts as overdue", () => {
    expect(matchesSegment(facts(), { lastInteractionOlderThanDays: 1 }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { lastInteractionOlderThanDays: 5 }, NOW)).toBe(false);
    expect(
      matchesSegment(
        facts({ lastInteractionAt: null }),
        { lastInteractionOlderThanDays: 5 },
        NOW
      )
    ).toBe(true);
  });

  it("neverContacted filters both directions", () => {
    expect(matchesSegment(facts(), { neverContacted: true }, NOW)).toBe(false);
    expect(matchesSegment(facts(), { neverContacted: false }, NOW)).toBe(true);
    const fresh = facts({ totalInteractions: 0 });
    expect(matchesSegment(fresh, { neverContacted: true }, NOW)).toBe(true);
    expect(matchesSegment(fresh, { neverContacted: false }, NOW)).toBe(false);
  });

  it("createdWithinDays: new rows pass, old and unparseable fail", () => {
    expect(matchesSegment(facts(), { createdWithinDays: 14 }, NOW)).toBe(true);
    expect(matchesSegment(facts(), { createdWithinDays: 7 }, NOW)).toBe(false);
    expect(
      matchesSegment(facts({ createdAt: "junk" }), { createdWithinDays: 14 }, NOW)
    ).toBe(false);
  });

  it("criteria AND together", () => {
    const filters: SegmentFilters = {
      tagsAny: ["VIP"],
      type: "customer",
      lastInteractionOlderThanDays: 1
    };
    expect(matchesSegment(facts(), filters, NOW)).toBe(true);
    expect(matchesSegment(facts({ type: "tester" }), filters, NOW)).toBe(false);
    expect(matchesSegment(facts({ tags: [] }), filters, NOW)).toBe(false);
  });

  it("defaults nowMs to the clock", () => {
    // lastInteraction 2 days ago relative to the REAL clock too.
    const row = facts({
      lastInteractionAt: new Date(Date.now() - 2 * DAY).toISOString(),
      createdAt: new Date(Date.now() - DAY).toISOString()
    });
    expect(matchesSegment(row, { lastInteractionWithinDays: 3 })).toBe(true);
  });
});

describe("describeSegmentFilters", () => {
  it("captions every criterion and falls back to 'all contacts'", () => {
    expect(describeSegmentFilters({})).toBe("all contacts");
    const caption = describeSegmentFilters({
      tagsAny: ["VIP", "Won"],
      type: "customer",
      ownerEmployeeId: "none",
      lastChannel: "sms",
      lastInteractionWithinDays: 7,
      lastInteractionOlderThanDays: 30,
      neverContacted: true,
      createdWithinDays: 14
    });
    expect(caption).toContain("tags: VIP, Won");
    expect(caption).toContain("type: customer");
    expect(caption).toContain("unowned");
    expect(caption).toContain("via sms");
    expect(caption).toContain("active ≤7d");
    expect(caption).toContain("no contact ≥30d");
    expect(caption).toContain("never contacted");
    expect(caption).toContain("created ≤14d");
  });

  it("captions an owned filter and the has-history direction", () => {
    const caption = describeSegmentFilters({
      ownerEmployeeId: "00000000-0000-0000-0000-0000000000aa",
      neverContacted: false
    });
    expect(caption).toContain("owned");
    expect(caption).toContain("has history");
  });
});
