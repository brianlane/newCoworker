/**
 * OAuth discovery constants and metadata for the MCP connector.
 */

import { generateProtectedResourceMetadata, getPublicOrigin } from "mcp-handler";

/** Supabase Auth's OAuth 2.1 issuer for this project (RFC 8414 `issuer`). */
export function supabaseAuthIssuer(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()?.replace(/\/+$/, "");
  if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return `${base}/auth/v1`;
}

/** Where the MCP server is mounted. */
export const MCP_PATH = "/api/mcp";

/**
 * RFC 9728's path-inserted metadata location for a resource at `MCP_PATH`.
 *
 * The 401 challenge points here rather than at the bare
 * `/.well-known/oauth-protected-resource`, because this is the form that
 * unambiguously describes a resource living at a path, and newer clients
 * probe it directly.
 */
export const MCP_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

/**
 * The canonical identifier for our MCP server, the value that goes in
 * `resource` and that a client echoes back as RFC 8707's `resource`
 * parameter.
 *
 * Derived from the REQUEST rather than from `NEXT_PUBLIC_APP_URL` on purpose.
 * The identifier has to match the host the client actually reached, and this
 * app answers on more than one: `newcoworker.com` and `www.newcoworker.com`,
 * plus a different host on every Vercel preview deployment. A hardcoded
 * origin would advertise an identifier that disagrees with the URL the owner
 * pasted into Claude or ChatGPT, which is exactly the mismatch audience
 * validation exists to catch. `getPublicOrigin` reads the forwarded headers,
 * so it sees the public host rather than the internal one.
 */
export function mcpResourceUrl(req: Request): string {
  return `${getPublicOrigin(req)}${MCP_PATH}`;
}

/**
 * The RFC 9728 document both metadata routes serve.
 *
 * `resource` is passed explicitly. Left to `protectedResourceHandler`'s
 * default it is derived by stripping `/.well-known/<segment>` off the request
 * path, which made the two routes disagree: the bare route advertised the
 * whole site as the protected resource while its path-inserted twin
 * advertised `/api/mcp`. Harmless while nothing validated it, and precisely
 * what RFC 8707 starts validating.
 */
export function buildMcpProtectedResourceMetadata(req: Request): Record<string, unknown> {
  return generateProtectedResourceMetadata({
    authServerUrls: [supabaseAuthIssuer()],
    resourceUrl: mcpResourceUrl(req),
    additionalMetadata: {
      // We read the bearer from the Authorization header only; the other two
      // RFC 6750 methods (query parameter and form body) are not accepted.
      bearer_methods_supported: ["header"],
      // Only what is load-bearing. Authorization here is role-based, not
      // scope-based, but `email` is not decorative: every permission check
      // resolves the caller's business role from the email claim, so a token
      // without it cannot be authorized at all.
      scopes_supported: ["openid", "email"]
    }
  });
}
