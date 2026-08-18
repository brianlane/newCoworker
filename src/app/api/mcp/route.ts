/**
 * /api/mcp, the Claude connector's remote MCP server (Streamable HTTP).
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

import { createMcpRouteHandlers } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
// Written as a literal, not as the shared MCP_MAX_DURATION_SECONDS, because
// Next reads route segment config statically and rejects an imported value
// with "Invalid segment configuration export detected" at build time. The
// constant is still the source of truth; tests/mcp-server.test.ts reads this
// file and fails if the two drift.
export const maxDuration = 300;

const handlers = createMcpRouteHandlers({ client: "claude" });

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
