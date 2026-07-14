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
      inputFilename: "intake.txt",
      formatWord: "markdown",
      inputText: "Name: Pat"
    });
    expect(prompt).toContain("Summarize the intake form.");
    expect(prompt).toContain('Attached material (from "intake.txt", may be truncated):');
    expect(prompt).toContain("Name: Pat");
    expect(prompt).toContain("Produce the result as markdown.");
  });

  it("announces an attached file when no text is inlined (PDF path)", () => {
    const prompt = buildAgentRunPrompt({
      instructions: "Extract the totals.",
      inputFilename: "invoice.pdf",
      formatWord: "markdown"
    });
    expect(prompt).toContain('The file "invoice.pdf" is attached.');
    expect(prompt).not.toContain("Attached material");
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
