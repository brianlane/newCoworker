/**
 * RFC 9728 Protected Resource Metadata for the MCP server at /api/mcp.
 *
 * MCP clients (Claude) hit /api/mcp without a token, get a 401 whose
 * WWW-Authenticate header points here, and read `authorization_servers`
 * to discover the OAuth 2.1 issuer — our Supabase Auth project — where
 * they self-register (DCR) and run the PKCE authorization flow.
 */

import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler
} from "mcp-handler";
import { supabaseAuthIssuer } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // Lazily constructed so a missing env fails the request, not the build.
  return protectedResourceHandler({ authServerUrls: [supabaseAuthIssuer()] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
