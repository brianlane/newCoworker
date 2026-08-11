/**
 * RFC 9728 path-inserted metadata for the resource at /api/mcp, and the
 * location the 401 challenge points at.
 *
 * This is the canonical form for a resource that lives at a path. The bare
 * /.well-known/oauth-protected-resource route serves the same document for
 * older clients that probe it directly.
 */

import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return Response.json(buildMcpProtectedResourceMetadata(req), {
    headers: { "access-control-allow-origin": "*" }
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
