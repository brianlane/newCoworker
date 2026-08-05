/**
 * MCP tool registry: the full connector tool set, and the loop that wires
 * it onto an McpServer instance.
 *
 * The route handler (src/app/api/mcp/route.ts) authenticates the bearer
 * BEFORE the server runs (withMcpAuth, required) and stashes the verified
 * identity in AuthInfo.extra; each tool callback re-reads it from
 * `ctx.http.authInfo` so tools always run as a concrete (userId, email).
 *
 * Note on the auth path: under @modelcontextprotocol/sdk 1.x the verified
 * token sat at the TOP level of the handler's second argument
 * (`extra.authInfo`). @modelcontextprotocol/server 2.x nests it under the
 * transport that carried it (`ctx.http.authInfo`), because a stdio server
 * has no such thing. The read below is deliberately written against the 2.x
 * shape; getting it wrong does not fail the build (the context is narrowed
 * from `unknown`), it silently fails every tool call closed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuthUser } from "@/lib/mcp/auth";
import {
  errorResult,
  runMcpTool,
  type McpTextResult,
  type McpToolDef
} from "@/lib/mcp/tooling";
import { readTools } from "@/lib/mcp/tools/read";
import { smsTools } from "@/lib/mcp/tools/sms";
import { calendarTools } from "@/lib/mcp/tools/calendar";
import { contactTools } from "@/lib/mcp/tools/contacts";
import { employeeTools } from "@/lib/mcp/tools/employees";
import { flowTools } from "@/lib/mcp/tools/flows";
import { agentTools } from "@/lib/mcp/tools/agents";
import { notificationTools } from "@/lib/mcp/tools/notifications";

export const allMcpTools: McpToolDef[] = [
  ...readTools,
  ...smsTools,
  ...calendarTools,
  ...contactTools,
  ...employeeTools,
  ...flowTools,
  ...agentTools,
  ...notificationTools
];

/**
 * Extract the verified caller from the server's per-request context
 * (`ctx.http.authInfo.extra`). Returns null when absent/malformed —
 * unreachable behind `withMcpAuth({ required: true })`, but the tool must
 * fail closed rather than run unauthenticated.
 */
export function authFromContext(ctx: unknown): McpAuthUser | null {
  const info = (
    ctx as { http?: { authInfo?: { extra?: Record<string, unknown> } } } | null
  )?.http?.authInfo?.extra;
  const userId = typeof info?.userId === "string" ? info.userId : "";
  const email = typeof info?.email === "string" ? info.email : "";
  return userId && email ? { userId, email } : null;
}

export function registerMcpTools(server: McpServer): void {
  for (const def of allMcpTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: z.object(def.schema) },
      async (args: Record<string, unknown>, ctx: unknown): Promise<McpTextResult> => {
        const auth = authFromContext(ctx);
        if (!auth) return errorResult("Unauthenticated — reconnect the New Coworker connector.");
        return runMcpTool(def, args, auth);
      }
    );
  }
}
