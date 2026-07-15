/**
 * Owner business-memory append helper
 * (src/lib/dashboard-chat/memory-append.ts): pure dedupe/build rules plus
 * the IO orchestration with injected deps — semantics must match the
 * owner-append adapter route it was factored from.
 */
import { describe, expect, it, vi } from "vitest";

import {
  MEMORY_MD_MAX_CHARS,
  appendOwnerMemoryBullets,
  buildNextMemory,
  dedupKey,
  existingMemoryKeys,
  normalizeBulletLines
} from "@/lib/dashboard-chat/memory-append";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-14T12:00:00Z");

function deps(memoryMd: string | null) {
  const saveConfig = vi.fn(async (_businessId: string, _patch: { memory_md?: string }) => undefined);
  const scheduleSync = vi.fn();
  return {
    fetchConfig: vi.fn(async () =>
      memoryMd === null ? null : ({ memory_md: memoryMd } as never)
    ),
    saveConfig: saveConfig as never,
    scheduleSync: scheduleSync as never,
    now: () => NOW,
    saveSpy: saveConfig,
    syncSpy: scheduleSync
  };
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

describe("buildNextMemory", () => {
  it("returns prior untouched for no lines", () => {
    expect(buildNextMemory("prior", [], NOW)).toEqual({ next: "prior", wanted: "prior" });
  });

  it("appends a dated block and trims the leading break on empty prior", () => {
    const { next } = buildNextMemory("", ["one"], NOW);
    expect(next.startsWith("---")).toBe(true);
    expect(next).toContain("### Owner chat (2026-07-14)");
    expect(next).toContain("- one");
  });

  it("tail-truncates past the cap", () => {
    const prior = "x".repeat(MEMORY_MD_MAX_CHARS);
    const { next, wanted } = buildNextMemory(prior, ["new rule"], NOW);
    expect(wanted.length).toBeGreaterThan(MEMORY_MD_MAX_CHARS);
    expect(next.length).toBe(MEMORY_MD_MAX_CHARS);
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
      truncated: false
    });
    const written = d.saveSpy.mock.calls[0][1].memory_md as string;
    expect(written).toContain("- existing rule");
    expect(written).toContain("### Owner chat (2026-07-14)");
    expect(written).toContain("- New rule one");
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

  it("all-duplicates: reports skipped without writing", async () => {
    const d = deps("- Rule A\n- Rule B");
    const res = await appendOwnerMemoryBullets(BIZ, "Rule A\nRule B", d);
    expect(res).toMatchObject({ appended: false, savedBullets: [], skippedDuplicates: 2 });
    expect(d.saveSpy).not.toHaveBeenCalled();
    expect(d.syncSpy).not.toHaveBeenCalled();
  });

  it("rescues a restated line whose only copy would be truncated away", async () => {
    // Prior memory: the restated rule sits at the HEAD, followed by enough
    // filler that appending pushes the head past the cap.
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
