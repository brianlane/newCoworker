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

import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifySupabaseAccessToken } from "@/lib/mcp/auth";
import { recordMcpConnectorSeen } from "@/lib/mcp/connector-status";
import { registerMcpTools } from "@/lib/mcp/registry";

export const dynamic = "force-dynamic";
// Claude's client-side tool timeout is 300s; let long tool calls finish.
export const maxDuration = 300;

// mcp-handler 2.x takes (initializeServer, options) — the old third argument
// is gone, and each of its keys is now either a default or handled above:
//   basePath   — the handler no longer routes; it serves whatever request the
//                host framework hands it, so this file's own path IS the mount.
//   disableSse — 2.x is stateless Streamable HTTP only; the SSE transport it
//                switched off no longer exists.
//   maxDuration — a Vercel concern, carried by the `maxDuration` export above.
const handler = createMcpHandler((server) => registerMcpTools(server), {
  serverInfo: { name: "new-coworker", version: "1.0.0" }
});

const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  const user = await verifySupabaseAccessToken(bearerToken);
  if (!user) return undefined;
  // Connection-status stamp: the first authenticated request is the moment
  // the connector provably works end to end (OAuth alone can succeed while
  // the edge blocks Anthropic's POSTs). Debounced inside; never throws.
  await recordMcpConnectorSeen(user.userId);
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
