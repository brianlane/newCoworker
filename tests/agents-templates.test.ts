/**
 * Agent templates (src/lib/agents/templates.ts): the prebuilt quote
 * templates stay within the create-form limits, carry the objectivity
 * guardrail, and resolve by id.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AGENT_NAME_MAX_CHARS
} from "@/lib/agents/core";
import { AGENT_TEMPLATES, getAgentTemplate } from "@/lib/agents/templates";

describe("AGENT_TEMPLATES", () => {
  it("ships the two quote templates with unique ids", () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("quote_comparison");
    expect(ids).toContain("quote_request_package");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template fits the agent create-form limits", () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length).toBeLessThanOrEqual(AGENT_NAME_MAX_CHARS);
      expect(t.instructions.length).toBeLessThanOrEqual(AGENT_INSTRUCTIONS_MAX_CHARS);
      expect(t.instructions.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(["markdown", "same_as_input"]).toContain(t.outputFormat);
    }
  });

  it("both quote templates carry the no-recommendations guardrail", () => {
    const comparison = getAgentTemplate("quote_comparison")!;
    expect(comparison.instructions).toMatch(/Do NOT recommend/);
    expect(comparison.instructions).toMatch(/licensed\/qualified staff/);
    expect(comparison.instructions).toMatch(/Never invent facts/);

    const request = getAgentTemplate("quote_request_package")!;
    expect(request.instructions).toMatch(/never invent, estimate/);
    expect(request.instructions).toMatch(/no advice or recommendations/i);
  });

  it("the comparison template demands honest gaps instead of guessed values", () => {
    expect(getAgentTemplate("quote_comparison")!.instructions).toMatch(/not stated/);
  });
});

describe("getAgentTemplate", () => {
  it("resolves known ids and returns null for unknown ones", () => {
    expect(getAgentTemplate("quote_comparison")?.name).toBe("Quote comparison");
    expect(getAgentTemplate("nope")).toBeNull();
  });
});
