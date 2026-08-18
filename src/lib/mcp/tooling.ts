/**
 * Shared plumbing for MCP tool definitions.
 *
 * Tools are declared as plain data (name + title + description + behavior
 * annotations + zod shape + handler) in src/lib/mcp/tools/*, and the registry
 * loops them onto the McpServer. Handlers return plain JSON-serializable
 * values; `runMcpTool` wraps them into MCP text-content results and converts
 * `McpToolError` into model-facing `isError` results (anything else is logged
 * and returned as a generic failure so internals never leak to the model).
 */

import type { z } from "zod";
import { McpToolError, type McpAuthUser } from "@/lib/mcp/auth";

export type McpTextResult = {
  content: Array<{ type: "text"; text: string }>;
  /**
   * The same payload as `content`, unstringified, for clients that can read
   * data rather than parse prose. Required whenever the tool declares an
   * `outputSchema`: the SDK answers "has an output schema but no structured
   * content was provided" and fails the call otherwise.
   */
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

/**
 * The MCP spec's tool behavior hints, which clients use to decide what needs
 * a confirmation prompt and what can run unattended.
 *
 * All three are REQUIRED here even though the spec makes them optional.
 * Omitted or wrong annotations are the single most-cited reason OpenAI
 * rejects a plugin, and an optional field is one a new tool forgets. The
 * meanings are narrower than they sound:
 *
 * - `readOnlyHint`: the tool does not modify anything.
 * - `destructiveHint`: only meaningful when not read-only. True means the
 *   update may be destructive; false means it is purely ADDITIVE. Replacing
 *   an existing value is therefore not additive, even when it is reversible.
 * - `openWorldHint`: the tool reaches an open set of entities outside the
 *   system (a customer's phone, a third-party calendar) rather than a closed,
 *   known one (our own database).
 */
export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

/**
 * Named behavior presets, so a tool declares intent rather than three
 * booleans whose combination is easy to get subtly wrong.
 *
 * **Annotate what the call SETS IN MOTION, not what its own code touches.**
 * That distinction is the whole difficulty here, and getting it wrong reads
 * as reassuring rather than as a bug. `create_contact` looks like a row
 * insert, but it fires `contact_created`, which enqueues matching AiFlow runs,
 * which can text a customer. `trigger_flow` and `run_flow` start an
 * owner-authored flow whose `update_contact` step can carry `removeTags`, so
 * a call that looks additive can delete CRM state. All three understate
 * themselves if you annotate the function body.
 *
 * The line that keeps this from swallowing everything: a tool is only
 * responsible for what THIS call sets going. `set_flow_enabled` changes
 * eligibility for runs that some later, independent trigger causes, so it
 * stays local; `trigger_flow` enqueues a run right now, so it does not.
 *
 * Deliberately NOT derived from the tool name, for the same reason. A prefix
 * heuristic gets wrong exactly the cases that matter: `calendar_find_slots` is
 * read-only but reaches Vagaro/Nango/Calendly/CalDAV, and `create_contact`
 * looks like the most innocuous write in the set.
 */
export const TOOL_BEHAVIOR = {
  /** Reads our own data. */
  readLocal: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  /** Reads through a third party (a connected calendar). */
  readExternal: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  /** Adds to our own data, and sets nothing outside in motion. */
  writeLocal: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  /** Additive, but the effect leaves the system: a text, a booking, an automation. */
  writeExternal: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  /** Replaces or removes existing data of ours, with no outside effect. */
  mutateLocal: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  /** Can both destroy existing data and reach outside. The flow runners. */
  mutateExternal: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
} as const satisfies Record<string, McpToolAnnotations>;

export type McpToolDef = {
  name: string;
  /** Human-readable label clients show instead of the snake_case name. */
  title: string;
  description: string;
  annotations: McpToolAnnotations;
  schema: z.ZodRawShape;
  /**
   * What the handler returns, so a client can consume the result as data.
   *
   * Object-rooted and REQUIRED, for a blunt reason: the SDK validates every
   * successful result against this, so a schema that disagrees with its
   * handler turns a working tool into an error result. That makes the schema
   * a promise the handler has to keep, and the per-tool tests check the
   * handler's real output against it rather than a fixture.
   *
   * Keep to plainly representable constructs. Conversion to JSON Schema is
   * memoised at REGISTRATION, so an unrepresentable one (a `.transform()`,
   * a `.refine()`) throws when the server is built and takes down every
   * request rather than one tool.
   */
  outputSchema: z.ZodType<Record<string, unknown>>;
  handler: (args: Record<string, unknown>, auth: McpAuthUser) => Promise<unknown>;
};

/** Type-safe declaration helper: infers handler args from the zod shape. */
export function defineMcpTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  annotations: McpToolAnnotations;
  schema: Shape;
  outputSchema: z.ZodType<Record<string, unknown>>;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    auth: McpAuthUser
  ) => Promise<unknown>;
}): McpToolDef {
  return def as unknown as McpToolDef;
}

/**
 * Serialize a handler's return value for the model AND for the client.
 *
 * The text block stays byte-identical to what it always was, so Claude's
 * behavior does not change; `structuredContent` is added alongside it, which
 * is what the spec recommends for compatibility. A non-object return would
 * have nothing legal to put in `structuredContent` (it is an object field),
 * so it degrades to text only rather than emitting something the wire
 * rejects. Every tool here returns an object, so that path is a guard, not a
 * behavior.
 */
export function jsonResult(data: unknown): McpTextResult {
  const content = [{ type: "text" as const, text: JSON.stringify(data, null, 2) }];
  const isPlainObject = typeof data === "object" && data !== null && !Array.isArray(data);
  return isPlainObject
    ? { content, structuredContent: data as Record<string, unknown> }
    : { content };
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
    return errorResult(`The ${def.name} tool hit an internal error, try again shortly.`);
  }
}
