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
import { searchTools } from "@/lib/mcp/tools/search";
import { businessProfileTools } from "@/lib/mcp/tools/business-profile";
import { businessKnowledgeTools } from "@/lib/mcp/tools/business-knowledge";
import { coworkerToolSettingsTools } from "@/lib/mcp/tools/coworker-tool-settings";
import {
  MCP_WIDGETS,
  MCP_WIDGET_MIME,
  widgetMetaForTool
} from "@/lib/mcp/widgets";

export const allMcpTools: McpToolDef[] = [
  // First, because they are the entry point a model should reach for: find
  // the thing, then read it, instead of guessing among the rest.
  ...searchTools,
  ...readTools,
  ...smsTools,
  ...calendarTools,
  ...contactTools,
  ...employeeTools,
  ...flowTools,
  ...agentTools,
  ...notificationTools,
  ...businessProfileTools,
  ...businessKnowledgeTools,
  ...coworkerToolSettingsTools
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
  // Unrecognised or absent reads as Claude: every row predating the second
  // route is a Claude send, and a bad value must not invent a new source.
  const client = info?.client === "chatgpt" ? "chatgpt" : "claude";
  return userId && email ? { userId, email, client } : null;
}

/**
 * Register the inline widgets as `ui://` resources.
 *
 * Separate from the tools because they are a different MCP primitive: a
 * resource is fetched once and reused, while a tool runs per call. The tools
 * that draw into one point at it through `_meta`.
 */
export function registerMcpWidgets(server: McpServer): void {
  for (const widget of MCP_WIDGETS) {
    server.registerResource(
      widget.name,
      widget.uri,
      { title: widget.title, mimeType: MCP_WIDGET_MIME },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: MCP_WIDGET_MIME, text: widget.html }]
      })
    );
  }
}

export function registerMcpTools(server: McpServer): void {
  registerMcpWidgets(server);

  for (const def of allMcpTools) {
    server.registerTool(
      def.name,
      {
        // `title` is a TOP-LEVEL field on the wire, not `annotations.title`
        // (the spec has both). Verified against a real tools/list response.
        title: def.title,
        description: def.description,
        annotations: def.annotations,
        inputSchema: z.object(def.schema),
        outputSchema: def.outputSchema,
        // Present only for the handful of tools that render inline. Spread so
        // the key is absent rather than undefined for the rest, since an
        // explicit undefined _meta is a different thing on the wire.
        ...(widgetMetaForTool(def.name) ? { _meta: widgetMetaForTool(def.name) } : {})
      },
      async (args: Record<string, unknown>, ctx: unknown): Promise<McpTextResult> => {
        const auth = authFromContext(ctx);
        if (!auth) return errorResult("Unauthenticated, reconnect the New Coworker connector.");
        return runMcpTool(def, args, auth);
      }
    );
  }
}
