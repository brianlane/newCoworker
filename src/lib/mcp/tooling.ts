/**
 * Shared plumbing for MCP tool definitions.
 *
 * Tools are declared as plain data (name + description + zod shape +
 * handler) in src/lib/mcp/tools/*, and the registry loops them onto the
 * McpServer. Handlers return plain JSON-serializable values; `runMcpTool`
 * wraps them into MCP text-content results and converts `McpToolError`
 * into model-facing `isError` results (anything else is logged and
 * returned as a generic failure so internals never leak to the model).
 */

import type { z } from "zod";
import { McpToolError, type McpAuthUser } from "@/lib/mcp/auth";

export type McpTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export type McpToolDef = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, auth: McpAuthUser) => Promise<unknown>;
};

/** Type-safe declaration helper: infers handler args from the zod shape. */
export function defineMcpTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  schema: Shape;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    auth: McpAuthUser
  ) => Promise<unknown>;
}): McpToolDef {
  return def as unknown as McpToolDef;
}

export function jsonResult(data: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): McpTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Execute one tool call: happy path serializes the handler's return value;
 * `McpToolError` surfaces its message to the model; anything else logs and
 * degrades to a generic failure.
 */
export async function runMcpTool(
  def: McpToolDef,
  args: Record<string, unknown>,
  auth: McpAuthUser
): Promise<McpTextResult> {
  try {
    return jsonResult(await def.handler(args, auth));
  } catch (err) {
    if (err instanceof McpToolError) return errorResult(err.message);
    const { logger } = await import("@/lib/logger");
    logger.error("mcp tool failed", {
      tool: def.name,
      userId: auth.userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResult(`The ${def.name} tool hit an internal error — try again shortly.`);
  }
}
