/**
 * Identity-section splice core (get/update_business_knowledge).
 *
 * The property that matters most: splicing one section leaves every other
 * byte of the document untouched, and there is no code path that accepts a
 * whole replacement document. The splitter's reassembly (join sections with
 * "\n") must be byte-faithful or the "untouched" guarantee silently lies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at module level so the PRODUCTION default deps (no injection) are a
// real, covered path: the identity editor pipeline modules never run for real
// in unit tests (patchBusinessConfig hits Supabase; the schedulers use
// next/server after()).
vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(async () => ({ identity_md: "## Only\nbody" })),
  patchBusinessConfig: vi.fn(async () => undefined)
}));
vi.mock("@/lib/memory/schedule-longform-extract", () => ({
  scheduleLongFormGraphExtract: vi.fn()
}));
vi.mock("@/lib/vps/schedule-vault-sync", () => ({ scheduleVaultSync: vi.fn() }));

import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleLongFormGraphExtract } from "@/lib/memory/schedule-longform-extract";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import {
  appendIdentitySection,
  KNOWLEDGE_SPLICE_MAX_CHARS,
  readBusinessKnowledge,
  replaceIdentitySection,
  splitIdentitySections,
  updateBusinessKnowledgeCore
} from "@/lib/knowledge-tools/identity-sections";
import { BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS } from "@/lib/vault/business-config-markdown-limits";

const DOC = [
  "Intro line about the business.",
  "",
  "## Services",
  "- Scar revision",
  "- Consultations",
  "",
  "## Pricing",
  "Consults are free.",
  "",
  "### Pricing notes",
  "Custom quotes stay with Selena."
].join("\n");

describe("splitIdentitySections", () => {
  it("splits on headings, keeps an intro block, and reassembles byte-for-byte", () => {
    const sections = splitIdentitySections(DOC);
    expect(sections.map((s) => [s.index, s.heading])).toEqual([
      [0, null],
      [1, "Services"],
      [2, "Pricing"],
      [3, "Pricing notes"]
    ]);
    expect(sections.map((s) => s.content).join("\n")).toBe(DOC);
  });

  it("returns [] for an empty document", () => {
    expect(splitIdentitySections("")).toEqual([]);
  });

  it("folds a whitespace-only leader into the first heading section", () => {
    const doc = "\n\n## Hours\nMon-Fri";
    const sections = splitIdentitySections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Hours");
    expect(sections[0].content).toBe(doc);
  });

  it("handles a document with no headings as one intro section", () => {
    const doc = "Just two devices listed.\nNo structure at all.";
    const sections = splitIdentitySections(doc);
    expect(sections).toEqual([{ index: 0, heading: null, content: doc }]);
  });
});

describe("replaceIdentitySection", () => {
  it("replaces one section's body by heading, preserving its heading line and every other byte", () => {
    const result = replaceIdentitySection(DOC, { heading: "pricing" }, "Consults are $150.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next).toBe(
      [
        "Intro line about the business.",
        "",
        "## Services",
        "- Scar revision",
        "- Consultations",
        "",
        "## Pricing",
        "Consults are $150.",
        "### Pricing notes",
        "Custom quotes stay with Selena."
      ].join("\n")
    );
  });

  it("replaces by index, including the intro block (which has no heading line)", () => {
    const result = replaceIdentitySection(DOC, { index: 0 }, "New intro.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.startsWith("New intro.\n## Services")).toBe(true);
    expect(result.next).toContain("Custom quotes stay with Selena.");
  });

  it("prefers index over heading when both are passed", () => {
    const result = replaceIdentitySection(
      DOC,
      { index: 1, heading: "Pricing" },
      "- Everything"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next).toContain("## Services\n- Everything");
    expect(result.next).toContain("Consults are free.");
  });

  it("refuses a missing heading and lists the sections", () => {
    const result = replaceIdentitySection(DOC, { heading: "Refunds" }, "x");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('No section named "Refunds"')
    });
    if (!result.ok) expect(result.message).toContain("1: Services");
  });

  it("refuses an ambiguous heading and points at section_index", () => {
    const doc = "## Notes\na\n## Notes\nb";
    const result = replaceIdentitySection(doc, { heading: "Notes" }, "c");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("section_index")
    });
  });

  it("refuses a missing index and an unspecified target", () => {
    expect(replaceIdentitySection(DOC, { index: 9 }, "x")).toEqual({
      ok: false,
      message: expect.stringContaining("No section at index 9")
    });
    expect(replaceIdentitySection(DOC, {}, "x")).toEqual({
      ok: false,
      message: expect.stringContaining("section_heading or section_index")
    });
  });

  it("refuses empty content, oversized content, and an oversized result", () => {
    expect(replaceIdentitySection(DOC, { heading: "Pricing" }, "   ")).toEqual({
      ok: false,
      message: expect.stringContaining("empty")
    });
    expect(
      replaceIdentitySection(DOC, { heading: "Pricing" }, "x".repeat(KNOWLEDGE_SPLICE_MAX_CHARS + 1))
    ).toEqual({ ok: false, message: expect.stringContaining("per-edit limit") });
    // The untouched section A stays at ~30k, so a 7k replacement of B's
    // body pushes the reassembled document over the 32k cap.
    const bigDoc = `## A\n${"y".repeat(BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS - 2_000)}\n## B\nshort`;
    const result = replaceIdentitySection(bigDoc, { heading: "B" }, "z".repeat(7_000));
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(String(BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS))
    });
  });

  it("refuses an edit that would blank the whole document (empty-content cap)", () => {
    // Blanking is only reachable through blank content, which the per-splice
    // cap refuses before any document math; a non-blank splice always leaves
    // a non-blank document because every other section survives verbatim.
    const result = replaceIdentitySection("plain text only", { index: 0 }, " ");
    expect(result.ok).toBe(false);
  });

  it("refuses a replace against an empty document, saying the document is empty", () => {
    const result = replaceIdentitySection("", { heading: "Pricing" }, "x");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("the document is empty")
    });
  });

  it("treats a whitespace-only heading as an unspecified target", () => {
    const result = replaceIdentitySection(DOC, { heading: "   " }, "x");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("section_heading or section_index")
    });
  });
});

describe("appendIdentitySection", () => {
  it("appends a heading-led section after the trimmed document end", () => {
    const result = appendIdentitySection(`${DOC}\n\n`, "## Refunds\nStore credit only.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.endsWith("Custom quotes stay with Selena.\n\n## Refunds\nStore credit only.")).toBe(
      true
    );
  });

  it("becomes the whole document when the document is empty", () => {
    const result = appendIdentitySection("", "## Hours\nMon-Fri 9-5");
    expect(result).toEqual({ ok: true, next: "## Hours\nMon-Fri 9-5" });
  });

  it("refuses content that does not start with a markdown heading", () => {
    const result = appendIdentitySection(DOC, "Store credit only.");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("markdown heading")
    });
  });

  it("applies the per-splice caps before the heading check", () => {
    expect(appendIdentitySection(DOC, "   ")).toEqual({
      ok: false,
      message: expect.stringContaining("empty")
    });
    expect(
      appendIdentitySection(DOC, `## X\n${"y".repeat(KNOWLEDGE_SPLICE_MAX_CHARS)}`)
    ).toEqual({ ok: false, message: expect.stringContaining("per-edit limit") });
  });
});

describe("readBusinessKnowledge / updateBusinessKnowledgeCore", () => {
  const getConfig = vi.fn();
  const patchConfig = vi.fn();
  const scheduleGraphExtract = vi.fn();
  const scheduleVault = vi.fn();
  const deps = { getConfig, patchConfig, scheduleGraphExtract, scheduleVault } as never;
  const BIZ = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ identity_md: DOC });
    patchConfig.mockResolvedValue(undefined);
  });

  it("reads the sections and total size; a missing config row reads as empty", async () => {
    expect(await readBusinessKnowledge(BIZ, deps)).toEqual({
      sections: splitIdentitySections(DOC),
      total_chars: DOC.length
    });
    getConfig.mockResolvedValue(null);
    expect(await readBusinessKnowledge(BIZ, deps)).toEqual({ sections: [], total_chars: 0 });
  });

  it("writes a replace through the identity editor's exact pipeline", async () => {
    const result = await updateBusinessKnowledgeCore(
      BIZ,
      { mode: "replace", sectionHeading: "Pricing", content: "Consults are $150." },
      deps
    );
    expect(result.ok).toBe(true);
    const written = vi.mocked(patchConfig).mock.calls[0];
    expect(written[0]).toBe(BIZ);
    const next = (written[1] as { identity_md: string }).identity_md;
    expect(next).toContain("## Pricing\nConsults are $150.");
    expect(next).toContain("- Scar revision");
    // The dashboard editor's exact follow-ups: KG extract (identity, trust-3,
    // unattributed) and the vault sync to the live box.
    expect(scheduleGraphExtract).toHaveBeenCalledWith(BIZ, {
      text: next,
      source: "identity",
      attributedTo: null
    });
    expect(scheduleVault).toHaveBeenCalledWith(BIZ);
    if (result.ok) {
      expect(result.total_chars).toBe(next.length);
      expect(result.sections.some((s) => s.heading === "Pricing")).toBe(true);
    }
  });

  it("appends through the same pipeline, addressing a missing config row as an empty doc", async () => {
    getConfig.mockResolvedValue(null);
    const result = await updateBusinessKnowledgeCore(
      BIZ,
      { mode: "append_section", content: "## Hours\nMon-Fri 9-5" },
      deps
    );
    expect(result).toMatchObject({ ok: true, total_chars: "## Hours\nMon-Fri 9-5".length });
    expect(patchConfig).toHaveBeenCalledWith(BIZ, { identity_md: "## Hours\nMon-Fri 9-5" });
  });

  it("returns the splice refusal untouched and writes nothing", async () => {
    const result = await updateBusinessKnowledgeCore(
      BIZ,
      { mode: "replace", sectionHeading: "Refunds", content: "x" },
      deps
    );
    expect(result.ok).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(scheduleGraphExtract).not.toHaveBeenCalled();
    expect(scheduleVault).not.toHaveBeenCalled();
  });

  it("passes sectionIndex through for index-addressed replaces", async () => {
    const result = await updateBusinessKnowledgeCore(
      BIZ,
      { mode: "replace", sectionIndex: 0, content: "New intro." },
      deps
    );
    expect(result.ok).toBe(true);
    expect((vi.mocked(patchConfig).mock.calls[0][1] as { identity_md: string }).identity_md).toContain(
      "New intro."
    );
  });

  it("uses the production pipeline modules when no deps are injected", async () => {
    const read = await readBusinessKnowledge(BIZ);
    expect(vi.mocked(getBusinessConfig)).toHaveBeenCalledWith(BIZ);
    expect(read.sections[0].heading).toBe("Only");

    const result = await updateBusinessKnowledgeCore(BIZ, {
      mode: "replace",
      sectionHeading: "Only",
      content: "new body"
    });
    expect(result.ok).toBe(true);
    expect(vi.mocked(patchBusinessConfig)).toHaveBeenCalledWith(BIZ, {
      identity_md: "## Only\nnew body"
    });
    expect(vi.mocked(scheduleLongFormGraphExtract)).toHaveBeenCalledWith(BIZ, {
      text: "## Only\nnew body",
      source: "identity",
      attributedTo: null
    });
    expect(vi.mocked(scheduleVaultSync)).toHaveBeenCalledWith(BIZ);
    // The injected-deps tests must not have leaked into the defaults.
    expect(getConfig).not.toHaveBeenCalled();
  });
});
