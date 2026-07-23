/**
 * Ranked memory retrieval (src/lib/memory/retrieval.ts): section/chunk
 * splitting across active + archive, term-overlap scoring, budget packing,
 * and the newest-active fallback that keeps memory in the prompt when
 * nothing matches the question.
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_CONTEXT_MAX_CHARS,
  memoryBlocks,
  scoreMemoryBlock,
  selectMemoryForQuestion
} from "@/lib/memory/retrieval";

/** A dated capture section exactly as the append path writes them. */
function section(date: string, bullets: string[]): string {
  return ["---", "", `### Owner chat (${date})`, "", ...bullets.map((b) => `- ${b}`)].join("\n");
}

describe("memoryBlocks", () => {
  it("orders archive blocks before active blocks, oldest first", () => {
    const archive = section("2026-01-01", ["archived escalation rule"]);
    const active = [section("2026-06-01", ["june rule"]), section("2026-07-01", ["july rule"])].join(
      "\n"
    );
    const blocks = memoryBlocks(active, archive);
    expect(blocks.map((b) => b.source)).toEqual(["archive", "active", "active"]);
    expect(blocks[0].text).toContain("archived escalation rule");
    expect(blocks[2].text).toContain("july rule");
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
  });

  it("chunks an oversized un-headed section and skips blank chunks", () => {
    const wall = Array.from({ length: 150 }, (_, i) => `- rule ${i} ${"pad ".repeat(10)}`).join("\n");
    const blocks = memoryBlocks(wall, "");
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.trim().length).toBeGreaterThan(0);
  });

  it("returns [] when both documents are empty", () => {
    expect(memoryBlocks("", "")).toEqual([]);
  });

  it("drops an all-blank chunk from an oversized run of whitespace lines", () => {
    // A section padded with thousands of space-only lines chunks into an
    // entirely-blank middle block — it must not become a scoreable block.
    const md = `### H\n${"   \n".repeat(1_500)}- tail rule`;
    const blocks = memoryBlocks(md, "");
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.trim().length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.text.includes("- tail rule"))).toBe(true);
  });
});

describe("scoreMemoryBlock", () => {
  it("scores term overlap with a heading bonus", () => {
    const block = "## Hours\n- closed on Sundays";
    expect(scoreMemoryBlock(block, "what are your hours?")).toBe(3); // heading 2 + body 1
    expect(scoreMemoryBlock(block, "are you open sundays?")).toBe(1); // body only
    expect(scoreMemoryBlock(block, "do you install pools?")).toBe(0);
  });

  it("returns 0 when the question has no scoreable terms", () => {
    expect(scoreMemoryBlock("- anything", "a b??")).toBe(0);
  });
});

describe("selectMemoryForQuestion", () => {
  const archive = section("2026-01-01", ["Escalate urgent plumbing issues to Amy Laidlaw"]);
  const active = [
    section("2026-06-01", ["We are closed on Sundays"]),
    section("2026-07-01", ["Always mention free estimates"])
  ].join("\n");

  it("selects the matching section, including from the archive", () => {
    const sel = selectMemoryForQuestion(active, archive, "who handles urgent plumbing?");
    expect(sel.fallback).toBe(false);
    expect(sel.context).toContain("Escalate urgent plumbing issues to Amy Laidlaw");
    expect(sel.fromArchive).toBe(1);
    // Irrelevant sections stay out of the prompt.
    expect(sel.context).not.toContain("free estimates");
  });

  it("renders multiple matches in chronological order regardless of score order", () => {
    const sel = selectMemoryForQuestion(
      active,
      archive,
      "urgent plumbing on sundays free estimates"
    );
    expect(sel.selected).toBe(3);
    const iArchive = sel.context.indexOf("urgent plumbing");
    const iJune = sel.context.indexOf("closed on Sundays");
    const iJuly = sel.context.indexOf("free estimates");
    expect(iArchive).toBeGreaterThanOrEqual(0);
    expect(iJune).toBeGreaterThan(iArchive);
    expect(iJuly).toBeGreaterThan(iJune);
  });

  it("prefers the newer block on score ties when the budget only fits one", () => {
    const older = section("2026-05-01", ["team lunch every friday"]);
    const newer = section("2026-07-01", ["team lunch moved to thursday"]);
    const both = [older, newer].join("\n");
    const budget = newer.length + 10; // fits exactly one section
    const sel = selectMemoryForQuestion(both, "", "when is the team lunch?", budget);
    expect(sel.selected).toBe(1);
    expect(sel.context).toContain("thursday");
  });

  it("skips blocks that do not fit and packs the next relevant one", () => {
    const big = section("2026-06-01", [`giant hours note ${"x".repeat(3_000)}`]);
    const small = section("2026-07-01", ["hours: 9-5 weekdays"]);
    const sel = selectMemoryForQuestion([big, small].join("\n"), "", "what are your hours?", 500);
    expect(sel.selected).toBe(1);
    expect(sel.context).toContain("9-5 weekdays");
  });

  it("falls back to the newest ACTIVE sections when nothing matches", () => {
    const sel = selectMemoryForQuestion(active, archive, "zzz qqq nothing");
    expect(sel.fallback).toBe(true);
    expect(sel.context).toContain("free estimates");
    expect(sel.context).toContain("closed on Sundays");
    // The archive never rides the fallback — only ranked matches pull it in.
    expect(sel.fromArchive).toBe(0);
    expect(sel.context).not.toContain("Escalate urgent");
  });

  it("fallback packs newest-first when the budget cannot hold everything", () => {
    const june = section("2026-06-01", ["We are closed on Sundays"]);
    const july = section("2026-07-01", ["Always mention free estimates"]);
    const budget = july.length + 10;
    const sel = selectMemoryForQuestion([june, july].join("\n"), "", "zzz", budget);
    expect(sel.selected).toBe(1);
    expect(sel.context).toContain("free estimates");
    expect(sel.context).not.toContain("Sundays");
  });

  it("returns empty for zero budget, empty memory, and a fallback that fits nothing", () => {
    expect(selectMemoryForQuestion(active, archive, "hours?", 0)).toEqual({
      context: "",
      selected: 0,
      fromArchive: 0,
      fallback: false
    });
    expect(selectMemoryForQuestion("", "", "hours?")).toEqual({
      context: "",
      selected: 0,
      fromArchive: 0,
      fallback: false
    });
    // A single giant bullet line (no headings): one unsplittable block.
    const giantOnly = `- x${"y".repeat(2_500)}`;
    const none = selectMemoryForQuestion(giantOnly, "", "zzz", 100);
    expect(none.context).toBe("");
    expect(none.fallback).toBe(true);
  });

  it("uses the default budget constant when none is passed", () => {
    const sel = selectMemoryForQuestion(active, "", "sundays?");
    expect(sel.context.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    expect(sel.context).toContain("Sundays");
  });
});
