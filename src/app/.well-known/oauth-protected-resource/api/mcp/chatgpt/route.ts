/**
 * RFC 9728 metadata for the resource at /api/mcp/chatgpt, and the location
 * that route's 401 challenge points at.
 *
 * A separate document from the Claude endpoint's because it names a different
 * `resource`. ChatGPT echoes that value back as the RFC 8707 `resource`
 * parameter, so it has to describe the endpoint the client actually reached.
 */

import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth";
import { MCP_ROUTES } from "@/lib/mcp/routes";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return Response.json(
    buildMcpProtectedResourceMetadata(req, MCP_ROUTES.chatgpt),
    { headers: { "access-control-allow-origin": "*" } }
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
