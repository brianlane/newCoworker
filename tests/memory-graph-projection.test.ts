/**
 * On-box graph projection (src/lib/memory/graph-projection.ts): upstream-
 * style entity notes (frontmatter, Key facts, [[wikilinks]]), graph.jsonl,
 * filename safety, and collision handling — plus the dependency-free ustar
 * packer (src/lib/tar/pack.ts) it ships through, verified by extracting
 * with the system tar.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type { MemoryEntityRow, MemoryFactRow } from "@/lib/memory/graph-db";
import {
  buildGraphJsonl,
  buildGraphProjectionFiles,
  entityFolder,
  noteFileName,
  renderEntityNote
} from "@/lib/memory/graph-projection";
import { packTar } from "@/lib/tar/pack";

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
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
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

function fact(overrides: Partial<MemoryFactRow> = {}): MemoryFactRow {
  return {
    id: "ffffffff-0000-4000-8000-000000000001",
    business_id: BIZ,
    subject_entity_id: entity().id,
    predicate: "phone",
    object_entity_id: null,
    object_value: "602-695-1142",
    source_text: "- bullet",
    stated_at: "2026-07-10T00:00:00Z",
    active: true,
    superseded_by: null,
    created_at: "2026-07-10T00:00:00Z",
    ...overrides
  };
}

describe("entityFolder / noteFileName", () => {
  it("maps kinds to upstream folders (unknown kinds land in Topics)", () => {
    expect(entityFolder("person")).toBe("People");
    expect(entityFolder("organization")).toBe("Organizations");
    expect(entityFolder("service")).toBe("Topics");
    expect(entityFolder("policy")).toBe("Topics");
  });

  it("sanitizes reserved characters, caps byte length, and falls back to the id", () => {
    expect(noteFileName("Amy / Laidlaw: <Realtor>?", "fb")).toBe("Amy Laidlaw Realtor.md");
    expect(noteFileName("///", "fallback-id")).toBe("fallback-id.md");
    const long = noteFileName("Ä".repeat(100), "fb");
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(63); // 60 + ".md"
  });
});

describe("renderEntityNote", () => {
  it("renders frontmatter, key facts with wikilink edges, and mentioned-by backlinks", () => {
    const byId = new Map([
      [entity().id, entity()],
      [ORG.id, ORG]
    ]);
    const edge = fact({
      id: "ffffffff-0000-4000-8000-000000000002",
      predicate: "works_at",
      object_entity_id: ORG.id,
      object_value: null
    });
    const note = renderEntityNote(entity(), [fact(), edge], byId);
    expect(note).toContain("kind: person");
    expect(note).toContain('aliases: ["Amy"]');
    expect(note).toContain('phones: ["602-695-1142"]');
    expect(note).toContain('emails: ["amy@example.com"]');
    expect(note).toContain("updated: 2026-07-20");
    expect(note).toContain("# Amy Laidlaw");
    expect(note).toContain("- phone: 602-695-1142 *(stated 2026-07-10)*");
    expect(note).toContain("- works_at [[HomeSmart]] *(stated 2026-07-10)*");

    const orgNote = renderEntityNote(ORG, [fact(), edge], byId);
    expect(orgNote).toContain("## Mentioned by");
    expect(orgNote).toContain("- [[Amy Laidlaw]] works_at this");
    expect(orgNote).not.toContain("## Key facts");
    // No contact frontmatter lines when the entity has none.
    expect(orgNote).not.toContain("aliases:");
  });

  it("renders an unresolvable edge target as the raw id and null literals as empty", () => {
    const byId = new Map([[entity().id, entity()]]);
    const danglingEdge = fact({
      predicate: "works_at",
      object_entity_id: "not-in-map",
      object_value: null
    });
    const note = renderEntityNote(entity(), [danglingEdge, fact({ object_value: null })], byId);
    expect(note).toContain("- works_at not-in-map");
    expect(note).toContain("- phone:  *(stated 2026-07-10)*");
  });
});

describe("buildGraphJsonl", () => {
  it("emits one line per entity and per fact, and empty for an empty graph", () => {
    const jsonl = buildGraphJsonl([entity(), ORG], [fact()]);
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "entity", name: "Amy Laidlaw", kind: "person" });
    expect(lines[2]).toMatchObject({ type: "fact", predicate: "phone", object_value: "602-695-1142" });
    expect(buildGraphJsonl([], [])).toBe("");
  });
});

describe("buildGraphProjectionFiles", () => {
  it("produces one note per entity in the right folder plus graph.jsonl", () => {
    const files = buildGraphProjectionFiles([entity(), ORG], [fact()]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("People/Amy Laidlaw.md");
    expect(paths).toContain("Organizations/HomeSmart.md");
    expect(paths).toContain("graph.jsonl");
    expect(files).toHaveLength(3);
  });

  it("disambiguates filename collisions with an id suffix", () => {
    const twin = entity({
      id: "aaaaaaaa-0000-4000-8000-000000000009",
      canonical_name: "Amy Laidlaw",
      aliases: [],
      phones: [],
      emails: []
    });
    const files = buildGraphProjectionFiles([entity(), twin], []);
    const paths = files.map((f) => f.path).filter((p) => p.startsWith("People/"));
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths[1]).toContain("(aaaaaaaa)");
  });

  it("keeps every note distinct even when colliding entities share the id prefix", () => {
    const twins = ["01", "02", "03"].map((n) =>
      entity({
        id: `aaaaaaaa-0000-4000-8000-0000000000${n}`,
        canonical_name: "Amy Laidlaw",
        aliases: [],
        phones: [],
        emails: []
      })
    );
    const files = buildGraphProjectionFiles(twins, []);
    const paths = files.map((f) => f.path).filter((p) => p.startsWith("People/"));
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    expect(paths[2]).toContain("(aaaaaaaa-2)");
  });

  it("returns no files for an empty graph", () => {
    expect(buildGraphProjectionFiles([], [])).toEqual([]);
  });
});

describe("packTar", () => {
  it("produces an archive the system tar can extract byte-identically", () => {
    const files = buildGraphProjectionFiles([entity(), ORG], [fact()]);
    const tar = packTar(files);
    const dir = mkdtempSync(join(os.tmpdir(), "kg-tar-"));
    try {
      const tarPath = join(dir, "graph.tar");
      writeFileSync(tarPath, tar);
      execFileSync("tar", ["-xf", tarPath, "-C", dir]);
      for (const file of files) {
        expect(readFileSync(join(dir, file.path), "utf8")).toBe(file.content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pads bodies to 512-byte blocks and appends the end-of-archive marker", () => {
    const tar = packTar([{ path: "a.md", content: "x" }]);
    // header (512) + padded body (512) + 2 trailing zero blocks (1024).
    expect(tar.length).toBe(512 + 512 + 1024);
    expect(tar.subarray(tar.length - 1024).every((b) => b === 0)).toBe(true);
    // A block-aligned body gets no padding.
    const aligned = packTar([{ path: "b.md", content: "y".repeat(512) }]);
    expect(aligned.length).toBe(512 + 512 + 1024);
  });

  it("rejects paths over 100 bytes and empty paths", () => {
    expect(() => packTar([{ path: "p/".padEnd(101, "x"), content: "" }])).toThrow(/1-100 bytes/);
    expect(() => packTar([{ path: "", content: "" }])).toThrow(/1-100 bytes/);
  });
});
