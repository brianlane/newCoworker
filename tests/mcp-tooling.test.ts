import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() }
}));

import { McpToolError } from "@/lib/mcp/auth";
import {
  defineMcpTool,
  errorResult,
  jsonResult,
  runMcpTool,
  TOOL_BEHAVIOR
} from "@/lib/mcp/tooling";
import { logger } from "@/lib/logger";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defineMcpTool / result helpers", () => {
  it("passes the definition through unchanged", () => {
    const def = defineMcpTool({
      name: "demo",
      title: "Demo",
      description: "d",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({}).loose(),
      schema: { x: z.string() },
      handler: async ({ x }) => ({ x })
    });
    expect(def.name).toBe("demo");
    expect(def.title).toBe("Demo");
    expect(def.description).toBe("d");
    expect(def.annotations).toEqual(TOOL_BEHAVIOR.readLocal);
  });

  it("jsonResult pretty-prints AND carries the same payload as data", () => {
    // The text block stays byte-identical to what it always was, so a client
    // reading prose sees no change; structuredContent is added alongside it.
    expect(jsonResult({ a: 1 })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }],
      structuredContent: { a: 1 }
    });
  });

  it("omits structuredContent for a value that cannot legally be one", () => {
    // structuredContent is an object field on the wire. Arrays, primitives and
    // null degrade to text rather than emitting something the transport
    // rejects. No tool returns these, so this is a guard rather than behavior.
    for (const value of [[1, 2], "plain", 42, null]) {
      const result = jsonResult(value);
      expect(result.structuredContent, JSON.stringify(value)).toBeUndefined();
      expect(result.content[0].text).toBe(JSON.stringify(value, null, 2));
    }
  });

  it("errorResult flags isError and never carries structured data", () => {
    // The SDK skips output validation on isError, and the spec forbids
    // structuredContent there, so a refusal must stay text only.
    expect(errorResult("nope")).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true
    });
  });
});

describe("runMcpTool", () => {
  const okTool = defineMcpTool({
    name: "ok",
    title: "Ok",
    description: "d",
    annotations: TOOL_BEHAVIOR.readLocal,
    outputSchema: z.object({}).loose(),
    schema: {},
    handler: async () => ({ fine: true })
  });

  it("serializes the handler's return value", async () => {
    const result = await runMcpTool(okTool, {}, AUTH);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ fine: true });
  });

  it("surfaces McpToolError messages to the model", async () => {
    const tool = defineMcpTool({
      name: "refuses",
      title: "Refuses",
      description: "d",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({}).loose(),
      schema: {},
      handler: async () => {
        throw new McpToolError("no permission");
      }
    });
    const result = await runMcpTool(tool, {}, AUTH);
    expect(result).toEqual({
      content: [{ type: "text", text: "no permission" }],
      isError: true
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs unexpected errors and returns a generic failure", async () => {
    const tool = defineMcpTool({
      name: "boom",
      title: "Boom",
      description: "d",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({}).loose(),
      schema: {},
      handler: async () => {
        throw new Error("db exploded");
      }
    });
    const result = await runMcpTool(tool, {}, AUTH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
    expect(result.content[0].text).not.toContain("db exploded");
    expect(logger.error).toHaveBeenCalledWith(
      "mcp tool failed",
      expect.objectContaining({ tool: "boom", error: "db exploded" })
    );
  });

  it("stringifies non-Error throws for the log", async () => {
    const tool = defineMcpTool({
      name: "weird",
      title: "Weird",
      description: "d",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({}).loose(),
      schema: {},
      handler: async () => {
        throw "plain string";
      }
    });
    const result = await runMcpTool(tool, {}, AUTH);
    expect(result.isError).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "mcp tool failed",
      expect.objectContaining({ error: "plain string" })
    );
  });
});
