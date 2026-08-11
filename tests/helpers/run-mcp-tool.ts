import { expect } from "vitest";
import type { McpAuthUser } from "@/lib/mcp/auth";
import type { McpToolDef } from "@/lib/mcp/tooling";

/**
 * Call a tool's handler the way the tests always did, and additionally hold it
 * to its declared `outputSchema`.
 *
 * Why every call site goes through this rather than a handful of spot checks:
 * declaring an `outputSchema` makes the SDK validate every successful result
 * against it, so a schema that disagrees with its handler does not fail
 * loudly at build time, it turns a working tool into an `isError` result in
 * production. The only way to catch that is to check the schema against what
 * the handler ACTUALLY returns, across the cases the tests already cover, so
 * the assertion rides along with them instead of being a separate fixture
 * nobody updates.
 *
 * Rejections pass straight through untouched: a handler that throws produces
 * no result to validate, and the SDK skips validation on `isError` too.
 */
export async function runTool(
  tool: McpToolDef,
  args: Record<string, unknown>,
  auth: McpAuthUser
): Promise<unknown> {
  const result = await tool.handler(args, auth);

  const parsed = tool.outputSchema.safeParse(result);
  if (!parsed.success) {
    // Print the actual value next to the complaint: the usual cause is a
    // field that is null in reality but not declared nullable, and the
    // difference is invisible from the zod error alone.
    expect.fail(
      `${tool.name} returned a value its outputSchema rejects.\n` +
        `This would be an isError result in production, not a build failure.\n` +
        `Issues: ${JSON.stringify(parsed.error.issues, null, 2)}\n` +
        `Returned: ${JSON.stringify(result, null, 2)}`
    );
  }

  return result;
}
