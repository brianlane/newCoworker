/**
 * RFC 9728 Protected Resource Metadata for the MCP server at /api/mcp.
 *
 * MCP clients (Claude, ChatGPT) hit /api/mcp without a token, get a 401 whose
 * WWW-Authenticate header points at the path-inserted twin of this route, and
 * read `authorization_servers` to discover the OAuth 2.1 issuer, our
 * Supabase Auth project, where they self-register (DCR) and run the PKCE
 * authorization flow.
 *
 * This bare location stays because older clients probe it directly. It must
 * answer with the SAME `resource` as the twin: two documents disagreeing
 * about what the protected resource is, is the bug this route used to have.
 */

import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  // Built per request: the metadata names the host the client actually
  // reached, and a missing env should fail the request, not the build.
  return Response.json(buildMcpProtectedResourceMetadata(req), {
    headers: { "access-control-allow-origin": "*" }
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
