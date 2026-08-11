/**
 * /api/mcp — the Claude connector's remote MCP server (Streamable HTTP).
 *
 * Owners add `https://<app>/api/mcp` as a custom connector in Claude; Claude
 * discovers the OAuth authorization server (Supabase Auth, via the 401
 * challenge → the protected-resource metadata), runs the user through login
 * and consent at /oauth/consent, and then presents the issued access token as
 * a bearer on every request here.
 *
 * Everything real lives in src/lib/mcp/server.ts under the coverage gate.
 * This file is the mount point and nothing else.
 */

import { createMcpRouteHandlers, MCP_MAX_DURATION_SECONDS } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const maxDuration = MCP_MAX_DURATION_SECONDS;

const handlers = createMcpRouteHandlers({ client: "claude" });

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
