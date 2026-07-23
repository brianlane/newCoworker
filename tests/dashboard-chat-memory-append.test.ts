/**
 * Owner business-memory append helper
 * (src/lib/dashboard-chat/memory-append.ts): pure dedupe/build/archive rules
 * plus the IO orchestration with injected deps — semantics must match the
 * owner-append adapter route it was factored from.
 *
 * The load-bearing invariant pinned here: memory overflow is ARCHIVED, never
 * destroyed. Every prior line survives in either the new active memory_md or
 * memory_archive_md.
 */
import { describe, expect, it, vi } from "vitest";

import {
  MEMORY_ARCHIVE_MD_MAX_CHARS,
  MEMORY_MD_MAX_CHARS,
  SECTION_CHUNK_MAX_CHARS,
  appendOwnerMemoryBullets,
  buildNextMemory,
  chunkMemorySection,
  dedupKey,
  existingMemoryKeys,
  normalizeBulletLines,
  splitMemorySections
} from "@/lib/dashboard-chat/memory-append";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-14T12:00:00Z");

function deps(memoryMd: string | null, archiveMd = "") {
  const saveConfig = vi.fn(
    async (_businessId: string, _patch: { memory_md?: string; memory_archive_md?: string }) =>
      undefined
  );
  const scheduleSync = vi.fn();
  return {
    fetchConfig: vi.fn(async () =>
      memoryMd === null
        ? null
        : ({ memory_md: memoryMd, memory_archive_md: archiveMd } as never)
    ),
    saveConfig: saveConfig as never,
    scheduleSync: scheduleSync as never,
    now: () => NOW,
    saveSpy: saveConfig,
    syncSpy: scheduleSync
  };
}

/** A dated capture section exactly as the append path writes them. */
function section(date: string, bullets: string[]): string {
  return ["---", "", `### Owner chat (${date})`, "", ...bullets.map((b) => `- ${b}`)].join("\n");
}

describe("normalizeBulletLines", () => {
  it("splits lines, strips list markers, drops empties, caps at 25", () => {
    expect(normalizeBulletLines("- one\n* two\n\n  three  \n")).toEqual(["one", "two", "three"]);
    expect(normalizeBulletLines(Array.from({ length: 30 }, (_, i) => `r${i}`).join("\n"))).toHaveLength(
      25
    );
  });
});

describe("dedupKey / existingMemoryKeys", () => {
  it("normalizes case, markers, trailing punctuation, whitespace", () => {
    expect(dedupKey("- Never  discuss Budget. ")).toBe(dedupKey("never discuss budget"));
  });

  it("collects keys from markdown list lines only (skipping punctuation-only lines)", () => {
    const keys = existingMemoryKeys("# Head\n- Rule one\ntext line\n* Rule two.\n- ...");
    expect(keys.has(dedupKey("rule one"))).toBe(true);
    expect(keys.has(dedupKey("rule two"))).toBe(true);
    expect(keys.size).toBe(2);
  });
});

describe("splitMemorySections", () => {
  it("splits at headings, keeping a --- separator attached to its following heading", () => {
    const md = [
      "- preamble rule",
      section("2026-01-01", ["a"]),
      section("2026-02-01", ["b"])
    ].join("\n");
    const sections = splitMemorySections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe("- preamble rule");
    expect(sections[1]).toContain("### Owner chat (2026-01-01)");
    expect(sections[1]).toContain("- a");
    expect(sections[1].startsWith("---")).toBe(true);
    expect(sections[2]).toContain("### Owner chat (2026-02-01)");
    // Lossless: rejoining the sections reproduces every line.
    expect(sections.join("\n")).toBe(md);
  });

  it("keeps hand-written content under a plain heading as one section", () => {
    const sections = splitMemorySections("## Hours\n- closed Sundays\n## Team\n- Amy");
    expect(sections).toEqual(["## Hours\n- closed Sundays", "## Team\n- Amy"]);
  });

  it("keeps a document-LEADING --- separator attached to its heading", () => {
    const md = [section("2026-06-01", ["june rule"]), section("2026-07-01", ["july rule"])].join("\n");
    const sections = splitMemorySections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("- june rule");
    expect(sections[1]).toContain("- july rule");
    expect(sections.join("\n")).toBe(md);
  });

  it("returns [] for whitespace-only input", () => {
    expect(splitMemorySections("   \n \n")).toEqual([]);
  });
});

describe("chunkMemorySection", () => {
  it("returns small sections whole", () => {
    expect(chunkMemorySection("## H\n- a")).toEqual(["## H\n- a"]);
  });

  it("splits an oversized section at line boundaries into bounded chunks", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- rule ${i} ${"pad ".repeat(10)}`);
    const chunks = chunkMemorySection(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SECTION_CHUNK_MAX_CHARS);
      // Never cuts mid-line.
      expect(lines.join("\n")).toContain(chunk);
    }
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  it("keeps an oversized single line whole (a bullet is never cut in half)", () => {
    const giant = `- ${"x".repeat(SECTION_CHUNK_MAX_CHARS + 500)}`;
    expect(chunkMemorySection(giant)).toEqual([giant]);
  });

  it("produces no chunks for a blank-lines-only oversized section", () => {
    expect(chunkMemorySection("\n".repeat(SECTION_CHUNK_MAX_CHARS + 10))).toEqual([]);
  });
});

describe("buildNextMemory", () => {
  it("returns prior untouched for no lines", () => {
    expect(buildNextMemory("prior", [], NOW, "arch")).toEqual({
      next: "prior",
      wanted: "prior",
      nextArchive: "arch",
      keptPrior: "prior",
      archived: false
    });
  });

  it("appends a dated block and trims the leading break on empty prior (default clock/archive)", () => {
    const { next, nextArchive, archived } = buildNextMemory("", ["one"]);
    expect(next.startsWith("---")).toBe(true);
    expect(next).toMatch(/### Owner chat \(\d{4}-\d{2}-\d{2}\)/);
    expect(next).toContain("- one");
    expect(nextArchive).toBe("");
    expect(archived).toBe(false);
  });

  it("archives the oldest sections past the cap instead of destroying them", () => {
    const old = section("2026-01-01", ["oldest rule about January"]);
    const fillers = Array.from({ length: 7 }, (_, i) =>
      section(`2026-02-0${i + 1}`, [`filler ${i} ${"pad".repeat(700)}`])
    );
    const prior = [old, ...fillers].join("\n");
    expect(prior.length).toBeGreaterThan(MEMORY_MD_MAX_CHARS);

    const { next, wanted, nextArchive, keptPrior, archived } = buildNextMemory(
      prior,
      ["new rule"],
      NOW
    );
    expect(wanted.length).toBeGreaterThan(MEMORY_MD_MAX_CHARS);
    expect(next.length).toBeLessThanOrEqual(MEMORY_MD_MAX_CHARS);
    expect(next.endsWith("- new rule")).toBe(true);
    expect(archived).toBe(true);
    // The oldest section moved to the archive — not destroyed.
    expect(nextArchive).toContain("oldest rule about January");
    expect(next).not.toContain("oldest rule about January");
    // keptPrior is exactly the surviving prior portion.
    expect(next.startsWith(`${keptPrior}\n`)).toBe(true);
    // Lossless: every prior bullet is in next or the archive.
    for (const line of prior.split("\n")) {
      if (line.startsWith("- ")) {
        expect(next.includes(line) || nextArchive.includes(line)).toBe(true);
      }
    }
  });

  it("archives a giant single-line memory wholesale (nothing head-sliced)", () => {
    const prior = "x".repeat(MEMORY_MD_MAX_CHARS);
    const { next, nextArchive, keptPrior, archived } = buildNextMemory(prior, ["new rule"], NOW);
    expect(archived).toBe(true);
    expect(keptPrior).toBe("");
    expect(next.startsWith("---")).toBe(true);
    expect(next).toContain("- new rule");
    expect(nextArchive).toBe(prior);
  });

  it("appends evictions to an existing archive with a separator", () => {
    const prior = "x".repeat(MEMORY_MD_MAX_CHARS);
    const { nextArchive } = buildNextMemory(prior, ["new rule"], NOW, "- old archived rule");
    expect(nextArchive.startsWith("- old archived rule\n\n")).toBe(true);
    expect(nextArchive.endsWith(prior)).toBe(true);
  });

  it("drops the OLDEST archive content only past the archive cap", () => {
    const priorArchive = "A".repeat(MEMORY_ARCHIVE_MD_MAX_CHARS);
    const prior = "x".repeat(MEMORY_MD_MAX_CHARS);
    const { nextArchive } = buildNextMemory(prior, ["new rule"], NOW, priorArchive);
    expect(nextArchive.length).toBe(MEMORY_ARCHIVE_MD_MAX_CHARS);
    // The newly evicted content (newest) survives at the tail.
    expect(nextArchive.endsWith(prior)).toBe(true);
  });

  it("handles a whitespace-only oversized prior without archiving anything", () => {
    const prior = " ".repeat(MEMORY_MD_MAX_CHARS + 10);
    const { next, nextArchive, archived } = buildNextMemory(prior, ["new rule"], NOW, "arch");
    expect(archived).toBe(false);
    expect(nextArchive).toBe("arch");
    expect(next.startsWith("---")).toBe(true);
  });

  it("does not archive when trimming trailing whitespace already makes it fit", () => {
    const prior = `- rule${" ".repeat(MEMORY_MD_MAX_CHARS)}`;
    const { next, nextArchive, archived, keptPrior } = buildNextMemory(prior, ["new rule"], NOW);
    expect(archived).toBe(false);
    expect(nextArchive).toBe("");
    expect(keptPrior).toBe("- rule");
    expect(next.startsWith("- rule\n")).toBe(true);
    expect(next.endsWith("- new rule")).toBe(true);
  });
});

describe("appendOwnerMemoryBullets", () => {
  it("returns a no-op for whitespace-only input without touching IO", async () => {
    const d = deps("");
    const res = await appendOwnerMemoryBullets(BIZ, "   \n  ", d);
    expect(res.appended).toBe(false);
    expect(d.saveSpy).not.toHaveBeenCalled();
  });

  it("appends brand-new lines under a dated heading and schedules the sync", async () => {
    const d = deps("- existing rule");
    const res = await appendOwnerMemoryBullets(BIZ, "New rule one\nNew rule two", d);
    expect(res).toMatchObject({
      appended: true,
      savedBullets: ["New rule one", "New rule two"],
      skippedDuplicates: 0,
      truncated: false,
      archivedChars: 0
    });
    const written = d.saveSpy.mock.calls[0][1].memory_md as string;
    expect(written).toContain("- existing rule");
    expect(written).toContain("### Owner chat (2026-07-14)");
    expect(written).toContain("- New rule one");
    // No overflow → the archive column is not touched at all.
    expect(d.saveSpy.mock.calls[0][1]).not.toHaveProperty("memory_archive_md");
    expect(d.syncSpy).toHaveBeenCalledWith(BIZ);
  });

  it("handles a null config row as empty memory (default clock)", async () => {
    const d = deps(null);
    // Omit the injected clock — the helper stamps today's real date.
    const res = await appendOwnerMemoryBullets(BIZ, "Only rule", {
      fetchConfig: d.fetchConfig,
      saveConfig: d.saveConfig,
      scheduleSync: d.scheduleSync
    });
    expect(res.appended).toBe(true);
    const written = d.saveSpy.mock.calls[0][1].memory_md as string;
    expect(written.startsWith("---")).toBe(true);
    expect(written).toMatch(/### Owner chat \(\d{4}-\d{2}-\d{2}\)/);
  });

  it("collapses within-batch duplicates and skips lines already in memory", async () => {
    const d = deps("- Never discuss budget");
    const res = await appendOwnerMemoryBullets(
      BIZ,
      "never discuss budget.\nNever discuss budget\nFresh rule",
      d
    );
    expect(res.savedBullets).toEqual(["Fresh rule"]);
    expect(res.skippedDuplicates).toBe(2);
  });

  it("all-duplicates: reports skipped without writing (archive size passthrough)", async () => {
    const d = deps("- Rule A\n- Rule B", "- archived rule");
    const res = await appendOwnerMemoryBullets(BIZ, "Rule A\nRule B", d);
    expect(res).toMatchObject({
      appended: false,
      savedBullets: [],
      skippedDuplicates: 2,
      archivedChars: "- archived rule".length
    });
    expect(d.saveSpy).not.toHaveBeenCalled();
    expect(d.syncSpy).not.toHaveBeenCalled();
  });

  it("archives evicted sections on overflow and reports the archive size", async () => {
    const old = section("2026-01-01", ["oldest escalation rule"]);
    const fillers = Array.from({ length: 7 }, (_, i) =>
      section(`2026-02-0${i + 1}`, [`filler ${i} ${"pad".repeat(700)}`])
    );
    const prior = [old, ...fillers].join("\n");
    const d = deps(prior);
    const res = await appendOwnerMemoryBullets(BIZ, "Brand new rule", d);
    expect(res.appended).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.archivedChars).toBeGreaterThan(0);
    const patch = d.saveSpy.mock.calls[0][1] as {
      memory_md: string;
      memory_archive_md?: string;
    };
    expect(patch.memory_md.length).toBeLessThanOrEqual(MEMORY_MD_MAX_CHARS);
    expect(patch.memory_md).toContain("- Brand new rule");
    expect(patch.memory_archive_md).toContain("oldest escalation rule");
  });

  it("rescues a restated line whose only active copy would be archived away", async () => {
    // Prior memory: the restated rule sits at the HEAD, followed by enough
    // filler that appending pushes the head into the archive.
    const filler = Array.from({ length: 400 }, (_, i) => `- filler rule ${i} ${"pad".repeat(8)}`).join(
      "\n"
    );
    const prior = `- Escalate urgent issues to Amy\n${filler}`.slice(0, MEMORY_MD_MAX_CHARS - 10);
    const d = deps(prior);
    const res = await appendOwnerMemoryBullets(BIZ, "Escalate urgent issues to Amy", d);
    expect(res.appended).toBe(true);
    expect(res.savedBullets).toEqual(["Escalate urgent issues to Amy"]);
    expect(res.truncated).toBe(true);
    const written = d.saveSpy.mock.calls[0][1].memory_md as string;
    expect(written.length).toBeLessThanOrEqual(MEMORY_MD_MAX_CHARS);
    expect(written).toContain("- Escalate urgent issues to Amy");
  });
});
