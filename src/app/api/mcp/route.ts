/**
 * /api/mcp — the Claude connector's remote MCP server (Streamable HTTP).
 *
 * Owners add `https://<app>/api/mcp` as a custom connector in Claude;
 * Claude discovers the OAuth authorization server (Supabase Auth, via the
 * 401 challenge → /.well-known/oauth-protected-resource), runs the user
 * through login + consent at /oauth/consent, and then presents the issued
 * access token as a bearer on every request here.
 *
 * Stateless Streamable HTTP only (no session ids, no Redis); the legacy
 * SSE transport is disabled. All tool logic lives in src/lib/mcp/** under
 * the coverage gate — this file is glue.
 */

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifySupabaseAccessToken } from "@/lib/mcp/auth";
import { registerMcpTools } from "@/lib/mcp/registry";

export const dynamic = "force-dynamic";
// Claude's client-side tool timeout is 300s; let long tool calls finish.
export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => registerMcpTools(server),
  { serverInfo: { name: "new-coworker", version: "1.0.0" } },
  { basePath: "/api", disableSse: true, maxDuration: 300 }
);

const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  const user = await verifySupabaseAccessToken(bearerToken);
  if (!user) return undefined;
  return {
    token: bearerToken,
    clientId: user.userId,
    scopes: [],
    extra: { userId: user.userId, email: user.email }
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource"
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
