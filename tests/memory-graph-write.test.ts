/**
 * Memory-graph write logic (src/lib/memory/graph-write.ts): deterministic
 * entity resolution (identity evidence only), alias/phone/email merging onto
 * existing nodes, and fact supersedence — a changed value replaces the old
 * fact instead of accumulating a contradiction.
 */
import { describe, expect, it, vi } from "vitest";

import type { GraphExtraction } from "@/lib/memory/graph-extract";
import type { MemoryEntityRow, MemoryFactRow } from "@/lib/memory/graph-db";
import {
  applyGraphExtraction,
  mergePatch,
  normalizeEmail,
  normalizePhone,
  resolveEntity
} from "@/lib/memory/graph-write";

const BIZ = "11111111-1111-4111-8111-111111111111";

function entityRow(overrides: Partial<MemoryEntityRow> = {}): MemoryEntityRow {
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

function factRow(overrides: Partial<MemoryFactRow> = {}): MemoryFactRow {
  return {
    id: "ffffffff-0000-4000-8000-000000000001",
    business_id: BIZ,
    subject_entity_id: "aaaaaaaa-0000-4000-8000-000000000001",
    predicate: "phone",
    object_entity_id: null,
    object_value: "602-695-1142",
    source_text: "- old bullet",
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

describe("normalizePhone / normalizeEmail", () => {
  it("normalizes phones to last-10 digits and rejects short fragments", () => {
    expect(normalizePhone("+1 (602) 695-1142")).toBe("6026951142");
    expect(normalizePhone("602 695 1142")).toBe("6026951142");
    expect(normalizePhone("123")).toBeNull();
  });

  it("lowercases emails and rejects non-addresses", () => {
    expect(normalizeEmail(" Amy@Example.COM ")).toBe("amy@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("resolveEntity", () => {
  const index = [entityRow()];

  it("honors a verified existing_id claim; ignores bogus and cross-kind claims", () => {
    const extracted = {
      ref: "e1",
      kind: "person" as const,
      name: "Someone Else",
      aliases: [],
      phones: [],
      emails: [],
      existingId: index[0].id
    };
    expect(resolveEntity(extracted, index)?.id).toBe(index[0].id);
    expect(
      resolveEntity({ ...extracted, existingId: "not-a-real-id" }, index)
    ).toBeNull();
    // A claim pointing at a different-kind node is a misclaim, not a merge.
    expect(
      resolveEntity({ ...extracted, kind: "organization" as const }, index)
    ).toBeNull();
  });

  it("never merges across kinds on a shared phone or email (shared main line/inbox)", () => {
    const orgWithSharedContact = {
      ref: "e1",
      kind: "organization" as const,
      name: "Laidlaw Realty",
      aliases: [],
      phones: ["602-695-1142"],
      emails: ["amy@example.com"]
    };
    // The person row shares both the phone and the email — still no match.
    expect(resolveEntity(orgWithSharedContact, index)).toBeNull();
  });

  it("matches on a shared normalized phone number across formatting", () => {
    const extracted = {
      ref: "e1",
      kind: "person" as const,
      name: "Amy L.",
      aliases: [],
      phones: ["(602) 695 1142"],
      emails: []
    };
    expect(resolveEntity(extracted, index)?.id).toBe(index[0].id);
  });

  it("matches on a shared email", () => {
    const extracted = {
      ref: "e1",
      kind: "person" as const,
      name: "A. Laidlaw",
      aliases: [],
      phones: [],
      emails: ["AMY@example.com"]
    };
    expect(resolveEntity(extracted, index)?.id).toBe(index[0].id);
  });

  it("matches an exact name/alias within the same kind only", () => {
    const byName = {
      ref: "e1",
      kind: "person" as const,
      name: "amy laidlaw",
      aliases: [],
      phones: [],
      emails: []
    };
    expect(resolveEntity(byName, index)?.id).toBe(index[0].id);

    const byAlias = { ...byName, name: "Unrelated", aliases: ["AMY"] };
    expect(resolveEntity(byAlias, index)?.id).toBe(index[0].id);

    // Same name, different kind: NOT the same entity.
    const orgAmy = { ...byName, kind: "organization" as const };
    expect(resolveEntity(orgAmy, index)).toBeNull();
  });

  it("skips malformed phones/emails/aliases stored on existing rows", () => {
    const messyRow = entityRow({
      phones: ["123", "602-695-1142"],
      emails: ["not-an-email", "amy@example.com"],
      aliases: ["  ", "Amy"]
    });
    const byPhone = {
      ref: "e1",
      kind: "person" as const,
      name: "X",
      aliases: [],
      phones: ["6026951142"],
      emails: []
    };
    expect(resolveEntity(byPhone, [messyRow])?.id).toBe(messyRow.id);
    const byEmail = { ...byPhone, phones: [], emails: ["amy@example.com"] };
    expect(resolveEntity(byEmail, [messyRow])?.id).toBe(messyRow.id);
    const byAlias = { ...byPhone, phones: [], name: "amy" };
    expect(resolveEntity(byAlias, [messyRow])?.id).toBe(messyRow.id);
  });

  it("refuses an ambiguous bare-name match (two same-kind entities share the alias)", () => {
    const amy1 = entityRow();
    const amy2 = entityRow({
      id: "aaaaaaaa-0000-4000-8000-000000000099",
      canonical_name: "Amy Smith",
      aliases: ["Amy"],
      phones: [],
      emails: []
    });
    const bareAmy = {
      ref: "e1",
      kind: "person" as const,
      name: "Amy",
      aliases: [],
      phones: [],
      emails: []
    };
    // Two candidates → no merge; a unique candidate still resolves.
    expect(resolveEntity(bareAmy, [amy1, amy2])).toBeNull();
    expect(resolveEntity(bareAmy, [amy1])?.id).toBe(amy1.id);
  });

  it("returns null without identity evidence (similar words are not a match)", () => {
    const extracted = {
      ref: "e1",
      kind: "person" as const,
      name: "Amy Smith",
      aliases: [],
      phones: ["480-000-0000"],
      emails: ["other@example.com"]
    };
    expect(resolveEntity(extracted, index)).toBeNull();
  });
});

describe("mergePatch", () => {
  it("adds only genuinely new aliases/phones/emails", () => {
    const patch = mergePatch(
      {
        ref: "e1",
        kind: "person",
        name: "Amy",
        aliases: ["Amy Laidlaw", "Ames"],
        phones: ["6026951142", "480-111-2222"],
        emails: ["amy@example.com", "new@example.com"]
      },
      entityRow()
    );
    // "Amy" and "Amy Laidlaw" are already known names; only "Ames" is new.
    expect(patch.aliases).toEqual(["Amy", "Ames"]);
    expect(patch.phones).toEqual(["602-695-1142", "480-111-2222"]);
    expect(patch.emails).toEqual(["amy@example.com", "new@example.com"]);
  });

  it("returns an empty patch when nothing is new", () => {
    const patch = mergePatch(
      {
        ref: "e1",
        kind: "person",
        name: "Amy",
        aliases: [],
        phones: ["602-695-1142"],
        emails: ["amy@example.com"]
      },
      entityRow()
    );
    expect(patch).toEqual({});
  });
});

describe("applyGraphExtraction", () => {
  function makeDeps(index: MemoryEntityRow[] = [], existingFacts: MemoryFactRow[] = []) {
    let nextId = 100;
    const insertEntity = vi.fn(async (entity: { canonical_name: string; kind: string }) =>
      entityRow({
        id: `aaaaaaaa-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
        canonical_name: entity.canonical_name,
        kind: entity.kind,
        aliases: [],
        phones: [],
        emails: []
      })
    );
    const insertFact = vi.fn(
      async (fact: {
        predicate: string;
        object_entity_id?: string | null;
        object_value?: string | null;
        source_text?: string;
      }) =>
        factRow({
          id: `ffffffff-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
          predicate: fact.predicate
        })
    );
    return {
      listEntities: vi.fn(async () => index),
      insertEntity: insertEntity as never,
      updateEntity: vi.fn(async () => undefined),
      listFacts: vi.fn(async () => existingFacts),
      insertFact: insertFact as never,
      supersedeFacts: vi.fn(async () => undefined),
      touchFact: vi.fn(async () => undefined),
      insertEntitySpy: insertEntity,
      insertFactSpy: insertFact
    };
  }

  const extraction: GraphExtraction = {
    entities: [
      { ref: "e1", kind: "person", name: "Dave Lane", aliases: [], phones: ["602-524-5719"], emails: [] },
      { ref: "e2", kind: "organization", name: "HomeSmart", aliases: [], phones: [], emails: [] }
    ],
    facts: [
      { subjectRef: "e1", predicate: "works_at", objectRef: "e2", sourceIndex: 0 },
      { subjectRef: "e1", predicate: "phone", objectValue: "602-524-5719", sourceIndex: 0 }
    ]
  };

  it("creates new entities and inserts entity-edge + literal facts", async () => {
    const deps = makeDeps();
    const result = await applyGraphExtraction(BIZ, extraction, ["Dave Lane 602-524-5719 works at HomeSmart"], deps);
    expect(result).toEqual({
      entitiesCreated: 2,
      entitiesMerged: 0,
      factsInserted: 2,
      factsSuperseded: 0,
      factsSkipped: 0
    });
    // Edge fact carries the object entity id, literal fact the value.
    const factInserts = deps.insertFactSpy.mock.calls.map((c) => c[0]);
    expect(factInserts[0]).toMatchObject({ predicate: "works_at", object_value: null });
    expect(factInserts[0].object_entity_id).toBeTruthy();
    expect(factInserts[1]).toMatchObject({
      predicate: "phone",
      object_entity_id: null,
      object_value: "602-524-5719",
      source_text: "Dave Lane 602-524-5719 works at HomeSmart"
    });
  });

  it("merges onto an existing node (aliases updated, no duplicate created)", async () => {
    const index = [entityRow()];
    const deps = makeDeps(index);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [
          {
            ref: "e1",
            kind: "person",
            name: "Amy",
            aliases: ["Ames"],
            phones: ["602-695-1142"],
            emails: []
          }
        ],
        facts: []
      },
      ["bullet"],
      deps
    );
    expect(result.entitiesCreated).toBe(0);
    expect(result.entitiesMerged).toBe(1);
    expect(deps.updateEntity).toHaveBeenCalledWith(index[0].id, {
      aliases: ["Amy", "Ames"]
    });
    // The in-memory index reflects the merge for later refs in the batch.
    expect(index[0].aliases).toEqual(["Amy", "Ames"]);
  });

  it("resolves without an update when the extraction adds nothing new", async () => {
    const index = [entityRow()];
    const deps = makeDeps(index);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [
          { ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] }
        ],
        facts: []
      },
      ["bullet"],
      deps
    );
    expect(result.entitiesMerged).toBe(0);
    expect(deps.updateEntity).not.toHaveBeenCalled();
  });

  it("supersedes the old fact when the same (subject, predicate) gets a new value", async () => {
    const index = [entityRow()];
    const old = factRow({ subject_entity_id: index[0].id, object_value: "old-number" });
    const deps = makeDeps(index, [old]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [
          { ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] }
        ],
        facts: [{ subjectRef: "e1", predicate: "phone", objectValue: "480-999-8888", sourceIndex: 0 }]
      },
      ["Amy's new number is 480-999-8888"],
      deps
    );
    expect(result.factsInserted).toBe(1);
    expect(result.factsSuperseded).toBe(1);
    const newFactId = (await deps.insertFactSpy.mock.results[0].value).id;
    expect(deps.supersedeFacts).toHaveBeenCalledWith([old.id], newFactId);
  });

  it("skips a fact whose object is already recorded (case-insensitive literal match)", async () => {
    const index = [entityRow()];
    // An edge row under the same predicate (object_value null) is compared
    // and passed over before the literal match is found.
    const edge = factRow({
      id: "ffffffff-0000-4000-8000-00000000000e",
      subject_entity_id: index[0].id,
      object_entity_id: "aaaaaaaa-0000-4000-8000-00000000000f",
      object_value: null
    });
    const existing = factRow({ subject_entity_id: index[0].id, object_value: "602-695-1142" });
    const deps = makeDeps(index, [edge, existing]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [
          { ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] }
        ],
        facts: [{ subjectRef: "e1", predicate: "phone", objectValue: "602-695-1142", sourceIndex: 0 }]
      },
      ["bullet"],
      deps
    );
    expect(result.factsSkipped).toBe(1);
    expect(result.factsInserted).toBe(0);
    expect(deps.insertFactSpy).not.toHaveBeenCalled();
    expect(deps.supersedeFacts).not.toHaveBeenCalled();
    // Re-stated, not new: recency bumps on the existing row (repeat
    // bookings / owners repeating rules keep stated_at fresh).
    expect(deps.touchFact).toHaveBeenCalledWith(existing.id);
  });

  it("skips an entity-edge fact already recorded (same object entity)", async () => {
    const amy = entityRow();
    const org = entityRow({
      id: "aaaaaaaa-0000-4000-8000-00000000000f",
      kind: "organization",
      canonical_name: "HomeSmart",
      aliases: [],
      phones: [],
      emails: []
    });
    const existingEdge = factRow({
      subject_entity_id: amy.id,
      predicate: "works_at",
      object_entity_id: org.id,
      object_value: null
    });
    const deps = makeDeps([amy, org], [existingEdge]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [
          { ref: "e1", kind: "person", name: "Amy Laidlaw", aliases: [], phones: [], emails: [] },
          { ref: "e2", kind: "organization", name: "HomeSmart", aliases: [], phones: [], emails: [] }
        ],
        facts: [{ subjectRef: "e1", predicate: "works_at", objectRef: "e2", sourceIndex: 0 }]
      },
      ["bullet"],
      deps
    );
    expect(result.factsSkipped).toBe(1);
  });

  it("no-ops on an empty extraction without touching the index", async () => {
    const deps = makeDeps();
    const result = await applyGraphExtraction(BIZ, { entities: [], facts: [] }, [], deps);
    expect(result.factsInserted).toBe(0);
    expect(deps.listEntities).not.toHaveBeenCalled();
  });

  it("merges new phones and emails onto the in-memory index too", async () => {
    const index = [entityRow()];
    const deps = makeDeps(index);
    await applyGraphExtraction(
      BIZ,
      {
        entities: [
          {
            ref: "e1",
            kind: "person",
            name: "Amy",
            aliases: [],
            phones: ["480-111-2222"],
            emails: ["second@example.com"]
          }
        ],
        facts: []
      },
      ["bullet"],
      deps
    );
    expect(index[0].phones).toEqual(["602-695-1142", "480-111-2222"]);
    expect(index[0].emails).toEqual(["amy@example.com", "second@example.com"]);
  });

  it("resolves entities without identity evidence to null names safely (blank alias)", async () => {
    expect(
      resolveEntity(
        { ref: "e1", kind: "person", name: "Nobody", aliases: [""], phones: [], emails: [] },
        [entityRow()]
      )
    ).toBeNull();
  });

  it("drops a fact carrying neither an edge nor a literal object", async () => {
    const deps = makeDeps();
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Solo", aliases: [], phones: [], emails: [] }],
        facts: [{ subjectRef: "e1", predicate: "broken", sourceIndex: 0 }]
      },
      ["bullet"],
      deps
    );
    expect(result.factsInserted).toBe(0);
    expect(deps.insertFactSpy).not.toHaveBeenCalled();
  });

  it("stamps provenance on created entities and facts (defaults to owner)", async () => {
    const deps = makeDeps();
    await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Visitor", aliases: [], phones: [], emails: [] }],
        facts: [{ subjectRef: "e1", predicate: "note", objectValue: "v", sourceIndex: 0 }]
      },
      ["bullet"],
      deps,
      { source: "webchat", trust: 0, attributedTo: "visitor-123" }
    );
    expect(deps.insertEntitySpy.mock.calls[0][0]).toMatchObject({
      source: "webchat",
      trust: 0,
      attributed_to: "visitor-123"
    });
    expect(deps.insertFactSpy.mock.calls[0][0]).toMatchObject({
      source: "webchat",
      trust: 0,
      attributed_to: "visitor-123"
    });

    // Default provenance is owner-canonical.
    const ownerDeps = makeDeps();
    await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Solo", aliases: [], phones: [], emails: [] }],
        facts: []
      },
      ["bullet"],
      ownerDeps
    );
    expect(ownerDeps.insertEntitySpy.mock.calls[0][0]).toMatchObject({
      source: "owner_chat",
      trust: 3,
      attributed_to: null
    });
  });

  it("supersedence respects trust: a lower-trust fact never retires a higher-trust one", async () => {
    const index = [entityRow()];
    const ownerFact = factRow({
      id: "ffffffff-0000-4000-8000-00000000000a",
      subject_entity_id: index[0].id,
      object_value: "owner-stated number",
      trust: 3
    });
    const customerClaim = factRow({
      id: "ffffffff-0000-4000-8000-00000000000b",
      subject_entity_id: index[0].id,
      object_value: "old customer claim",
      trust: 1
    });
    const deps = makeDeps(index, [ownerFact, customerClaim]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] }],
        facts: [{ subjectRef: "e1", predicate: "phone", objectValue: "new customer claim", sourceIndex: 0 }]
      },
      ["caller said the number changed"],
      deps,
      { source: "voice_call", trust: 1, attributedTo: "+14805551234" }
    );
    expect(result.factsInserted).toBe(1);
    // Only the SAME-OR-LOWER trust fact retired; the owner's stays active.
    expect(result.factsSuperseded).toBe(1);
    const newFactId = (await deps.insertFactSpy.mock.results[0].value).id;
    expect(deps.supersedeFacts).toHaveBeenCalledWith([customerClaim.id], newFactId);
  });

  it("a higher-trust fact retires lower-trust claims (owner corrects hearsay)", async () => {
    const index = [entityRow()];
    const claim = factRow({
      id: "ffffffff-0000-4000-8000-00000000000c",
      subject_entity_id: index[0].id,
      object_value: "hearsay value",
      trust: 0
    });
    const deps = makeDeps(index, [claim]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] }],
        facts: [{ subjectRef: "e1", predicate: "phone", objectValue: "owner value", sourceIndex: 0 }]
      },
      ["bullet"],
      deps
    );
    expect(result.factsSuperseded).toBe(1);
    expect(deps.supersedeFacts).toHaveBeenCalledWith([claim.id], expect.any(String));
  });

  it("trust ≤ 1 sources never merge contact points onto canonical entities (trust bump only)", async () => {
    const row = entityRow({ trust: 1 });
    const lowTrustPatch = mergePatch(
      {
        ref: "e1",
        kind: "person",
        name: "Amy",
        aliases: ["Ames"],
        phones: ["480-111-2222"],
        emails: ["new@example.com"]
      },
      row,
      1
    );
    // No aliases/phones/emails merge at trust 1 — claims live as facts.
    expect(lowTrustPatch).toEqual({});

    // A higher-trust touch bumps the recorded trust (and may merge).
    const bumped = mergePatch(
      { ref: "e1", kind: "person", name: "Amy", aliases: [], phones: [], emails: [] },
      row,
      3
    );
    expect(bumped).toEqual({ trust: 3 });
  });

  it("bumps a low-trust entity's recorded trust when a higher-trust source touches it", async () => {
    const row = entityRow({ trust: 0, source: "webchat" });
    const deps = makeDeps([row]);
    const result = await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Amy Laidlaw", aliases: [], phones: [], emails: [] }],
        facts: []
      },
      ["bullet"],
      deps
    );
    expect(result.entitiesMerged).toBe(1);
    expect(deps.updateEntity).toHaveBeenCalledWith(row.id, { trust: 3 });
    expect(row.trust).toBe(3); // in-memory index reflects the bump
  });

  it("falls back to empty source text when the source index is out of range", async () => {
    const deps = makeDeps();
    await applyGraphExtraction(
      BIZ,
      {
        entities: [{ ref: "e1", kind: "person", name: "Solo", aliases: [], phones: [], emails: [] }],
        facts: [{ subjectRef: "e1", predicate: "note", objectValue: "v", sourceIndex: 5 }]
      },
      ["only one bullet"],
      deps
    );
    expect(deps.insertFactSpy.mock.calls[0][0]).toMatchObject({ source_text: "" });
  });
});
