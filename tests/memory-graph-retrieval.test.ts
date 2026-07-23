/**
 * Graph retrieval (src/lib/memory/graph-retrieval.ts): entity matching by
 * question terms and caller phone, 1-hop neighborhood rendering, budget
 * packing, and the degrade-to-empty error contract.
 */
import { describe, expect, it, vi } from "vitest";

import type { MemoryEntityRow, MemoryFactRow } from "@/lib/memory/graph-db";
import {
  GRAPH_CONTEXT_MAX_CHARS,
  matchGraphEntities,
  retrieveGraphContext
} from "@/lib/memory/graph-retrieval";

const BIZ = "11111111-1111-4111-8111-111111111111";

function entity(overrides: Partial<MemoryEntityRow> = {}): MemoryEntityRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    business_id: BIZ,
    kind: "person",
    canonical_name: "Amy Laidlaw",
    aliases: ["Amy"],
    phones: ["602-695-1142"],
    emails: ["amy@example.com"],
    customer_e164: null,
    source: "owner_chat",
    trust: 3,
    attributed_to: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function fact(overrides: Partial<MemoryFactRow> = {}): MemoryFactRow {
  return {
    id: "ffffffff-0000-4000-8000-000000000001",
    business_id: BIZ,
    subject_entity_id: "aaaaaaaa-0000-4000-8000-000000000001",
    predicate: "phone",
    object_entity_id: null,
    object_value: "602-695-1142",
    source_text: "- bullet",
    stated_at: "2026-07-01T00:00:00Z",
    active: true,
    superseded_by: null,
    source: "owner_chat",
    trust: 3,
    attributed_to: null,
    created_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const ORG = entity({
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  kind: "organization",
  canonical_name: "HomeSmart",
  aliases: [],
  phones: [],
  emails: []
});

describe("matchGraphEntities", () => {
  it("matches on name and alias term hits", () => {
    expect(matchGraphEntities([entity(), ORG], "who is amy?", undefined)).toHaveLength(1);
    expect(matchGraphEntities([entity(), ORG], "tell me about homesmart", undefined)).toEqual([ORG]);
  });

  it("matches the caller's phone across formatting", () => {
    const matched = matchGraphEntities([entity(), ORG], "zzz nothing", "+16026951142");
    expect(matched).toHaveLength(1);
    expect(matched[0].canonical_name).toBe("Amy Laidlaw");
  });

  it("returns [] when neither terms nor caller match", () => {
    expect(matchGraphEntities([entity()], "zzz", "+15550001111")).toEqual([]);
    expect(matchGraphEntities([entity()], "zzz", undefined)).toEqual([]);
  });

  it("never seeds on substrings of name words (the ⊄ Theresa, are ⊄ Warehouse)", () => {
    const theresa = entity({
      id: "aaaaaaaa-0000-4000-8000-000000000010",
      canonical_name: "Theresa Warehouse",
      aliases: [],
      phones: [],
      emails: []
    });
    expect(matchGraphEntities([theresa], "what are the hours?", undefined)).toEqual([]);
    expect(matchGraphEntities([theresa], "who is theresa?", undefined)).toHaveLength(1);
  });
});

describe("retrieveGraphContext", () => {
  function deps(entities: MemoryEntityRow[], facts: MemoryFactRow[]) {
    return {
      listEntities: vi.fn(async () => entities),
      listFacts: vi.fn(async () => facts)
    };
  }

  it("renders identity lines + literal and edge facts for the matched neighborhood", async () => {
    const edge = fact({
      id: "ffffffff-0000-4000-8000-000000000002",
      predicate: "works_at",
      object_entity_id: ORG.id,
      object_value: null
    });
    const result = await retrieveGraphContext(BIZ, "what is amy's phone?", {
      ...deps([entity(), ORG], [fact(), edge])
    });
    expect(result.matchedEntities).toBe(1);
    expect(result.facts).toBe(2);
    expect(result.context).toContain("- Amy Laidlaw (person) — aka Amy; phone 602-695-1142; email amy@example.com");
    // The org rides in through the 1-hop edge and gets an identity line.
    expect(result.context).toContain("- HomeSmart (organization)");
    expect(result.context).toContain("- Amy Laidlaw phone: 602-695-1142");
    expect(result.context).toContain("- Amy Laidlaw works_at HomeSmart");
  });

  it("includes facts where the matched entity is the OBJECT", async () => {
    const inbound = fact({
      id: "ffffffff-0000-4000-8000-000000000003",
      subject_entity_id: ORG.id,
      predicate: "escalation_target",
      object_entity_id: entity().id,
      object_value: null
    });
    const result = await retrieveGraphContext(BIZ, "who is amy?", {
      ...deps([entity(), ORG], [inbound])
    });
    expect(result.context).toContain("- HomeSmart escalation_target Amy Laidlaw");
  });

  it("returns empty for no entities and no matches", async () => {
    const none = await retrieveGraphContext(BIZ, "amy?", { ...deps([], []) });
    expect(none).toEqual({ context: "", matchedEntities: 0, facts: 0 });

    const noMatch = await retrieveGraphContext(BIZ, "zzz", { ...deps([entity()], [fact()]) });
    expect(noMatch).toEqual({ context: "", matchedEntities: 0, facts: 0 });
  });

  it("reports real match counts even when the budget fits nothing (no-match vs no-room)", async () => {
    const noFit = await retrieveGraphContext(BIZ, "amy?", {
      ...deps([entity()], [fact()]),
      charBudget: 3
    });
    expect(noFit).toEqual({ context: "", matchedEntities: 1, facts: 0 });
  });

  it("packs within the budget and reports only the RENDERED fact count", async () => {
    const facts = Array.from({ length: 30 }, (_, i) =>
      fact({
        id: `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`,
        predicate: `note_${i}`,
        object_value: `value ${i} ${"pad".repeat(30)}`
      })
    );
    const result = await retrieveGraphContext(BIZ, "amy?", {
      ...deps([entity()], facts),
      charBudget: 500
    });
    expect(result.context.length).toBeLessThanOrEqual(500);
    // 30 facts matched but only what fit was rendered — the count must say
    // what the prompt actually carried.
    expect(result.facts).toBeGreaterThan(0);
    expect(result.facts).toBeLessThan(30);
    const factLines = result.context.split("\n").filter((l) => /note_\d+/.test(l));
    expect(factLines).toHaveLength(result.facts);
  });

  it("renders a bare identity line when the entity has no contact details or facts", async () => {
    const bare = entity({ aliases: [], phones: [], emails: [] });
    const result = await retrieveGraphContext(BIZ, "amy?", { ...deps([bare], []) });
    expect(result.context).toBe("- Amy Laidlaw (person)");
    expect(result.facts).toBe(0);
  });

  it("renders trust ≤ 1 facts as attributed unverified claims, packed after higher-trust facts", async () => {
    const ownerFact = fact({ id: "ffffffff-0000-4000-8000-000000000011", predicate: "phone" });
    const claim = fact({
      id: "ffffffff-0000-4000-8000-000000000012",
      predicate: "roof_status",
      object_value: "replaced in 2019",
      trust: 1,
      attributed_to: "+14805551234"
    });
    const anonClaim = fact({
      id: "ffffffff-0000-4000-8000-000000000013",
      predicate: "budget",
      object_value: "about 500k",
      trust: 0,
      attributed_to: null,
      source: "webchat"
    });
    const result = await retrieveGraphContext(BIZ, "amy?", {
      ...deps([entity()], [claim, ownerFact, anonClaim])
    });
    // Owner fact reads plain; claims carry attribution + (unverified).
    expect(result.context).toContain("- Amy Laidlaw phone: 602-695-1142");
    expect(result.context).not.toContain("phone: 602-695-1142 — claimed");
    expect(result.context).toContain(
      "- Amy Laidlaw roof_status: replaced in 2019 — claimed by +14805551234 (unverified)"
    );
    // No attributed_to → the source stands in.
    expect(result.context).toContain(
      "- Amy Laidlaw budget: about 500k — claimed by webchat (unverified)"
    );
    // Higher trust packs first even though the claim was listed first.
    expect(result.context.indexOf("phone: 602-695-1142")).toBeLessThan(
      result.context.indexOf("roof_status")
    );
  });

  it("renders an empty literal object as an empty value (null object_value)", async () => {
    const nullValue = fact({ object_value: null });
    const result = await retrieveGraphContext(BIZ, "amy?", { ...deps([entity()], [nullValue]) });
    expect(result.context).toContain("- Amy Laidlaw phone:");
  });

  it("degrades to empty on IO failure instead of throwing", async () => {
    const result = await retrieveGraphContext(BIZ, "amy?", {
      listEntities: vi.fn(async () => {
        throw new Error("db down");
      }),
      listFacts: vi.fn(async () => [])
    });
    expect(result).toEqual({ context: "", matchedEntities: 0, facts: 0 });

    const nonError = await retrieveGraphContext(BIZ, "amy?", {
      listEntities: vi.fn(async () => {
        throw "string failure";
      }),
      listFacts: vi.fn(async () => [])
    });
    expect(nonError).toEqual({ context: "", matchedEntities: 0, facts: 0 });
  });

  it("uses the default budget when none is passed", async () => {
    const result = await retrieveGraphContext(BIZ, "amy?", { ...deps([entity()], [fact()]) });
    expect(result.context.length).toBeLessThanOrEqual(GRAPH_CONTEXT_MAX_CHARS);
    expect(result.context.length).toBeGreaterThan(0);
  });
});
