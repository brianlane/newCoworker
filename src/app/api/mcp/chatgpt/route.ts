/**
 * /api/mcp/chatgpt, the ChatGPT app's remote MCP server.
 *
 * Same tools, same OAuth, same per-business role checks as the Claude
 * connector at /api/mcp. A separate route because in stateless Streamable
 * HTTP only `initialize` carries `clientInfo`, so a shared endpoint could not
 * tell the two assistants apart on any later request. See
 * src/lib/mcp/routes.ts for the full reasoning.
 *
 * What differs from /api/mcp: the connection is stamped as `chatgpt` rather
 * than `claude` (so each dashboard card tells the truth), the 401 points at
 * this route's own protected-resource metadata, and the server carries the
 * instructions below.
 */

import { CHATGPT_MCP_INSTRUCTIONS, createMcpRouteHandlers } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
// A literal, not the shared constant: Next reads route segment config
// statically and rejects an imported value at build time. Kept in step with
// MCP_MAX_DURATION_SECONDS by tests/mcp-server.test.ts.
export const maxDuration = 300;

const handlers = createMcpRouteHandlers({
  client: "chatgpt",
  instructions: CHATGPT_MCP_INSTRUCTIONS
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
