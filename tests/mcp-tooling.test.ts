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
  runMcpTool
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
      description: "d",
      schema: { x: z.string() },
      handler: async ({ x }) => ({ x })
    });
    expect(def.name).toBe("demo");
    expect(def.description).toBe("d");
  });

  it("jsonResult pretty-prints; errorResult flags isError", () => {
    expect(jsonResult({ a: 1 })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }]
    });
    expect(errorResult("nope")).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true
    });
  });
});

describe("runMcpTool", () => {
  const okTool = defineMcpTool({
    name: "ok",
    description: "d",
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
      description: "d",
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
      description: "d",
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
      description: "d",
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
