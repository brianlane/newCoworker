/**
 * Path-suffixed twin of /.well-known/oauth-protected-resource (RFC 9728
 * path-inserted form for a resource at /api/mcp). Newer MCP clients try
 * this location directly instead of the WWW-Authenticate pointer, so both
 * must answer with the same metadata.
 */

import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler
} from "mcp-handler";
import { supabaseAuthIssuer } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return protectedResourceHandler({ authServerUrls: [supabaseAuthIssuer()] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
