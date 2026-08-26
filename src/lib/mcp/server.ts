/**
 * The MCP route handlers, built once per client.
 *
 * This used to live inline in src/app/api/mcp/route.ts. It moved here for two
 * reasons: a second client is coming and the glue should not be copy-pasted,
 * and `src/app/**` is outside the coverage gate while `src/lib/**` is at 100%.
 * The auth wrapper and the 401 shaping are exactly the code where a silent
 * failure is most expensive, and until now none of it was covered.
 */

import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifySupabaseAccessToken } from "@/lib/mcp/auth";
import { mcpResourceMetadataPath, type McpClient } from "@/lib/mcp/routes";
import { registerMcpTools } from "@/lib/mcp/registry";

/**
 * Both assistants cap a tool call around 300s; let long ones finish.
 *
 * Each route file must repeat this as a LITERAL in its `maxDuration` export.
 * Next reads route segment config statically and rejects an imported value
 * ("Invalid segment configuration export detected"), a failure that appears
 * only in `next build`, not in tsc or the unit tests. This stays the source of
 * truth and tests/mcp-server.test.ts reads the route files to catch drift.
 */
export const MCP_MAX_DURATION_SECONDS = 300;

/**
 * Server-level guidance ChatGPT reads on `initialize`.
 *
 * Only the first 512 characters are prioritized, so the load-bearing parts
 * come first: what this is, that it acts as the signed-in owner within their
 * role, and the confirmation rule. The last one is not decoration. Several
 * tools here reach real customers (a text goes out, a booking is made, an
 * automation starts), and the behavior annotations tell a client a call is
 * consequential without telling it to ask first.
 *
 * Product term is "AI coworker", never "AI receptionist" (product-terminology rule).
 */
export const CHATGPT_MCP_INSTRUCTIONS = [
  "New Coworker is an AI coworker for businesses.",
  "Use these tools to look up customers, read text conversations and call summaries, check the day's tasks, send a text, and book appointments, always on behalf of the signed-in owner and limited to their team role.",
  "Confirm with the user before anything that reaches a customer: sending a text or WhatsApp message, booking an appointment, or starting an automation.",
  "If a tool reports that the account has multiple businesses, call list_businesses and pass business_id explicitly.",
  "Times in messages always carry a named timezone, never a bare clock time."
].join(" ");

export type McpRouteHandlers = {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  DELETE: (req: Request) => Promise<Response>;
};

/**
 * A bearer that cannot possibly be a Supabase JWT, rejected before we spend a
 * network round trip on it.
 *
 * Not premature optimization: the WAF rule in front of these routes skips bot
 * protection (the vendors' egress ranges are large and rotate, so path-scoped
 * skipping is what is maintainable), which means an unauthenticated flood
 * reaches the origin. Without this check each junk request costs a Supabase
 * verification call, and that is the cheapest way to hurt us here.
 */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Add the MCP-shaped pointer to an auth failure.
 *
 * `mcp-handler` answers a failed bearer with a bare OAuth error object and a
 * `WWW-Authenticate` header. ChatGPT additionally looks for the same challenge
 * inside the JSON body at `_meta["mcp/www_authenticate"]`, and without it the
 * client can show a dead "couldn't connect" instead of offering to
 * re-authorize. Claude reads the header and is unaffected either way.
 */
export async function withMcpAuthMeta(res: Response): Promise<Response> {
  const challenge = res.headers.get("www-authenticate");
  if (res.status !== 401 || !challenge) return res;

  const body = await res.clone().text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's HTML error page). Pass it through untouched rather
    // than inventing a body the client did not get from us.
    return res;
  }

  const meta = { ...(payload._meta as Record<string, unknown> | undefined) };
  // A value the library one day supplies itself wins, so this never
  // double-writes a future SDK's own field.
  meta["mcp/www_authenticate"] ??= challenge;

  return Response.json(
    { ...payload, _meta: meta },
    { status: res.status, headers: res.headers }
  );
}

/**
 * Build the GET/POST/DELETE handlers for one client's MCP endpoint.
 *
 * `instructions` is the server-level guidance a client reads on `initialize`;
 * only the first 512 characters are prioritized, so lead with the important
 * part.
 */
export function createMcpRouteHandlers(options: {
  client: McpClient;
  instructions?: string;
}): McpRouteHandlers {
  const handler = createMcpHandler((server) => registerMcpTools(server), {
    serverInfo: { name: "new-coworker", version: "1.0.0" },
    ...(options.instructions ? { instructions: options.instructions } : {})
  });

  const verifyToken = async (
    _req: Request,
    bearerToken?: string
  ): Promise<AuthInfo | undefined> => {
    if (!bearerToken || !looksLikeJwt(bearerToken)) return undefined;
    const user = await verifySupabaseAccessToken(bearerToken);
    if (!user) return undefined;
    // No connection-status stamp here. This point knows the user and the
    // client but NOT the business, and a status row without one is what
    // painted an admin's own connector onto every tenant's dashboard tile.
    // The stamp lives in mcpBusinessRoleOutcome (src/lib/mcp/auth.ts), where
    // the business is resolved and the call is authorized.
    return {
      token: bearerToken,
      clientId: user.userId,
      scopes: [],
      extra: { userId: user.userId, email: user.email, client: options.client }
    };
  };

  const authHandler = withMcpAuth(handler, verifyToken, {
    required: true,
    // The PATH-INSERTED metadata document, RFC 9728's canonical form for a
    // resource that lives at a path, and per client so each endpoint points
    // at the document that names it.
    resourceMetadataPath: mcpResourceMetadataPath(options.client)
  });

  const wrapped = async (req: Request): Promise<Response> =>
    withMcpAuthMeta(await authHandler(req));

  return { GET: wrapped, POST: wrapped, DELETE: wrapped };
}
