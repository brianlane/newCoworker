/**
 * Agents domain rules (src/lib/agents/core.ts): tier caps, output-format
 * resolution, artifact filenames, run prompt layout, and output
 * normalization.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_OUTPUT_MAX_CHARS,
  AGENT_TIER_LIMITS,
  agentLimitForTier,
  buildAgentRunPrompt,
  buildOutputFilename,
  normalizeAgentOutput,
  resolveOutputTarget
} from "@/lib/agents/core";

describe("agentLimitForTier", () => {
  it("maps known tiers and falls back to starter", () => {
    expect(agentLimitForTier("starter")).toBe(AGENT_TIER_LIMITS.starter);
    expect(agentLimitForTier("standard")).toBe(AGENT_TIER_LIMITS.standard);
    expect(agentLimitForTier("enterprise")).toBe(AGENT_TIER_LIMITS.enterprise);
    expect(agentLimitForTier("unknown")).toBe(AGENT_TIER_LIMITS.starter);
    expect(agentLimitForTier(null)).toBe(AGENT_TIER_LIMITS.starter);
    expect(agentLimitForTier(undefined)).toBe(AGENT_TIER_LIMITS.starter);
  });
});

describe("resolveOutputTarget", () => {
  it("always produces markdown for the markdown format", () => {
    for (const mime of ["text/csv", "text/plain", "application/pdf", "text/markdown"]) {
      expect(resolveOutputTarget("markdown", mime)).toMatchObject({
        mime: "text/markdown",
        extension: "md"
      });
    }
  });

  it("echoes csv and plain text in kind for same_as_input", () => {
    expect(resolveOutputTarget("same_as_input", "text/csv")).toEqual({
      mime: "text/csv",
      extension: "csv",
      formatWord: "CSV"
    });
    expect(resolveOutputTarget("same_as_input", "TEXT/PLAIN ")).toEqual({
      mime: "text/plain",
      extension: "txt",
      formatWord: "plain text"
    });
  });

  it("maps markdown and PDF inputs to markdown even for same_as_input", () => {
    expect(resolveOutputTarget("same_as_input", "text/markdown").mime).toBe("text/markdown");
    expect(resolveOutputTarget("same_as_input", "application/pdf").mime).toBe("text/markdown");
  });
});

describe("buildOutputFilename", () => {
  it("swaps the extension and sanitizes the base", () => {
    const target = resolveOutputTarget("same_as_input", "text/csv");
    expect(buildOutputFilename("Leads Export.csv", target)).toBe("Leads_Export.csv");
    expect(buildOutputFilename("intake form.pdf", resolveOutputTarget("markdown", "application/pdf"))).toBe(
      "intake_form.md"
    );
  });

  it("falls back to 'output' for a degenerate name and clips long bases", () => {
    const target = resolveOutputTarget("markdown", "text/plain");
    expect(buildOutputFilename("...", target)).toBe("output.md");
    const long = buildOutputFilename(`${"a".repeat(300)}.txt`, target);
    expect(long.length).toBeLessThanOrEqual(104);
    expect(long.endsWith(".md")).toBe(true);
  });
});

describe("buildAgentRunPrompt", () => {
  it("inlines text attachments with the filename and format word", () => {
    const prompt = buildAgentRunPrompt({
      instructions: "  Summarize the intake form.  ",
      formatWord: "markdown",
      textSections: [{ filename: "intake.txt", text: "Name: Pat" }],
      attachedFilenames: []
    });
    expect(prompt).toContain("Summarize the intake form.");
    expect(prompt).toContain('Attached material (from "intake.txt", may be truncated):');
    expect(prompt).toContain("Name: Pat");
    expect(prompt).toContain("Produce the result as markdown.");
    expect(prompt).not.toContain("is attached");
  });

  it("labels every text section in a multi-file run", () => {
    const prompt = buildAgentRunPrompt({
      instructions: "Compare the quotes.",
      formatWord: "markdown",
      textSections: [
        { filename: "carrier-a.txt", text: "Premium: $1,200" },
        { filename: "carrier-b.txt", text: "Premium: $1,350" }
      ],
      attachedFilenames: []
    });
    expect(prompt).toContain('Attached material (from "carrier-a.txt", may be truncated):');
    expect(prompt).toContain('Attached material (from "carrier-b.txt", may be truncated):');
    expect(prompt.indexOf("carrier-a.txt")).toBeLessThan(prompt.indexOf("carrier-b.txt"));
  });

  it("announces attached files when no text is inlined (PDF path)", () => {
    const one = buildAgentRunPrompt({
      instructions: "Extract the totals.",
      formatWord: "markdown",
      textSections: [],
      attachedFilenames: ["invoice.pdf"]
    });
    expect(one).toContain('The file "invoice.pdf" is attached.');
    expect(one).not.toContain("Attached material");

    const many = buildAgentRunPrompt({
      instructions: "Compare the quotes.",
      formatWord: "markdown",
      textSections: [],
      attachedFilenames: ["carrier-a.pdf", "carrier-b.pdf"]
    });
    expect(many).toContain('The files "carrier-a.pdf", "carrier-b.pdf" are attached.');
  });

  it("mixes text sections and attached files in one prompt", () => {
    const prompt = buildAgentRunPrompt({
      instructions: "Compare.",
      formatWord: "markdown",
      textSections: [{ filename: "notes.txt", text: "Prefers a low deductible" }],
      attachedFilenames: ["quote.pdf"]
    });
    expect(prompt).toContain('Attached material (from "notes.txt", may be truncated):');
    expect(prompt).toContain('The file "quote.pdf" is attached.');
  });
});

describe("normalizeAgentOutput", () => {
  it("strips a whole-reply code fence but keeps inner fences", () => {
    expect(normalizeAgentOutput("```markdown\n# Title\n\n```js\ncode\n```\n```")).toBe(
      "# Title\n\n```js\ncode\n```"
    );
    expect(normalizeAgentOutput("```\nplain\n```")).toBe("plain");
  });

  it("leaves unfenced output alone and clips to the artifact cap", () => {
    expect(normalizeAgentOutput("  # Title  ")).toBe("# Title");
    expect(normalizeAgentOutput("x".repeat(AGENT_OUTPUT_MAX_CHARS + 5000)).length).toBe(
      AGENT_OUTPUT_MAX_CHARS
    );
  });
});
