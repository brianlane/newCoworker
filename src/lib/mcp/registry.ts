/**
 * MCP tool registry: the full connector tool set, and the loop that wires
 * it onto an McpServer instance.
 *
 * The route handler (src/app/api/mcp/route.ts) authenticates the bearer
 * BEFORE the server runs (withMcpAuth, required) and stashes the verified
 * identity in AuthInfo.extra; each tool callback re-reads it from
 * `extra.authInfo` so tools always run as a concrete (userId, email).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { flowTools } from "@/lib/mcp/tools/flows";
import { agentTools } from "@/lib/mcp/tools/agents";
import { notificationTools } from "@/lib/mcp/tools/notifications";

export const allMcpTools: McpToolDef[] = [
  ...readTools,
  ...smsTools,
  ...calendarTools,
  ...contactTools,
  ...flowTools,
  ...agentTools,
  ...notificationTools
];

/**
 * Extract the verified caller from the SDK's per-request extra. Returns
 * null when absent/malformed — unreachable behind `withMcpAuth({ required:
 * true })`, but the tool must fail closed rather than run unauthenticated.
 */
export function authFromExtra(extra: unknown): McpAuthUser | null {
  const info = (extra as { authInfo?: { extra?: Record<string, unknown> } } | null)
    ?.authInfo?.extra;
  const userId = typeof info?.userId === "string" ? info.userId : "";
  const email = typeof info?.email === "string" ? info.email : "";
  return userId && email ? { userId, email } : null;
}

export function registerMcpTools(server: McpServer): void {
  for (const def of allMcpTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      async (args: Record<string, unknown>, extra: unknown): Promise<McpTextResult> => {
        const auth = authFromExtra(extra);
        if (!auth) return errorResult("Unauthenticated — reconnect the New Coworker connector.");
        return runMcpTool(def, args, auth);
      }
    );
  }
}
