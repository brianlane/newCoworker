import { describe, expect, it } from "vitest";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildFlowAdaptUserText,
  buildFlowCompileUserText,
  extractFlowJson
} from "@/lib/ai-flows/compile";

describe("FLOW_COMPILE_SYSTEM_PROMPT", () => {
  it("documents the schema contract", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"version": 1');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("browse_extract");
  });
});

describe("buildFlowCompileUserText", () => {
  it("trims and labels the description", () => {
    expect(buildFlowCompileUserText("  do a thing  ")).toBe("Automation description:\ndo a thing");
  });
});

describe("buildFlowAdaptUserText", () => {
  it("includes the source definition and the business's concrete details", () => {
    const text = buildFlowAdaptUserText({
      sourceDefinition: { version: 1 },
      ownerPhone: "+14805551234",
      ownerEmail: "owner@biz.com",
      employeeNames: ["Jordan", "Amy"],
      instructions: "only text buyers"
    });
    expect(text).toContain('{"version":1}');
    expect(text).toContain("Owner phone: +14805551234");
    expect(text).toContain("Owner email: owner@biz.com");
    expect(text).toContain("Team members: Jordan, Amy");
    expect(text).toContain("Additional instructions: only text buyers");
  });

  it("falls back to '(none on file)' and omits empty instructions", () => {
    const text = buildFlowAdaptUserText({ sourceDefinition: {} });
    expect(text).toContain("Owner phone: (none on file)");
    expect(text).toContain("Owner email: (none on file)");
    expect(text).toContain("Team members: (none on file)");
    expect(text).not.toContain("Additional instructions:");
  });

  it("treats whitespace-only instructions as empty", () => {
    const text = buildFlowAdaptUserText({ sourceDefinition: {}, instructions: "   " });
    expect(text).not.toContain("Additional instructions:");
  });
});

describe("extractFlowJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractFlowJson('{"version":1}')).toEqual({ version: 1 });
  });
  it("recovers JSON from fenced/prose output", () => {
    const raw = 'Here you go:\n```json\n{"version":1,"steps":[]}\n```\nHope that helps!';
    expect(extractFlowJson(raw)).toEqual({ version: 1, steps: [] });
  });
  it("returns null when there is no object", () => {
    expect(extractFlowJson("sorry, I cannot help")).toBeNull();
  });
  it("returns null when braces are out of order", () => {
    expect(extractFlowJson("} oops {")).toBeNull();
  });
  it("returns null when there is no closing brace", () => {
    expect(extractFlowJson("{ broken")).toBeNull();
  });
  it("returns null when the sliced region is invalid JSON", () => {
    expect(extractFlowJson("prefix { not: valid } suffix")).toBeNull();
  });
});
