/**
 * Which MCP clients we serve, and where each one connects.
 *
 * One source of truth, because these paths are consumed in four places that
 * must not drift: the route files themselves, the CSRF exemption in
 * src/proxy.ts, the protected-resource metadata, and the connector-status
 * rows the dashboard reads.
 *
 * Why a route per client rather than one shared endpoint: in stateless
 * Streamable HTTP only the `initialize` request carries `clientInfo`. Every
 * later tools/call arrives as an independent request whose only client signal
 * is a User-Agent, so a shared endpoint could not attribute traffic without
 * sniffing one. That guess would end up baked into a "Connected" badge, the
 * per-client server instructions, and the RFC 8707 resource identifier. A
 * separate path is a discriminator that requires no inference at all, and it
 * keeps a change made to satisfy an OpenAI reviewer from touching the live
 * Claude connector.
 */

export const MCP_CLIENTS = ["claude", "chatgpt"] as const;

export type McpClient = (typeof MCP_CLIENTS)[number];

/** Where each client's MCP server is mounted. */
export const MCP_ROUTES: Record<McpClient, string> = {
  claude: "/api/mcp",
  chatgpt: "/api/mcp/chatgpt"
};

/** RFC 9728 path-inserted metadata location for a client's endpoint. */
export function mcpResourceMetadataPath(client: McpClient): string {
  return `/.well-known/oauth-protected-resource${MCP_ROUTES[client]}`;
}

/**
 * Is this pathname one of our MCP endpoints?
 *
 * Deliberately an exact match against the known routes rather than a
 * `startsWith("/api/mcp")` prefix test. The caller is `src/proxy.ts`, where
 * this decides whether to skip CSRF, and a prefix test would silently exempt
 * every future `/api/mcp/*` route we add, including one that authenticates
 * with a session cookie and genuinely needs the check.
 */
export function isMcpRoutePath(pathname: string): boolean {
  return Object.values(MCP_ROUTES).includes(pathname);
}
