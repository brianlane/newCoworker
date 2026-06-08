import { describe, expect, it } from "vitest";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
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
