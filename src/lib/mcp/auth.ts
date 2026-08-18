/**
 * Authentication + authorization for the Claude connector's MCP server
 * (/api/mcp).
 *
 * Claude obtains a Supabase Auth access token through the OAuth 2.1 flow
 * (Supabase is the authorization server; we host only the consent page at
 * /oauth/consent). Every MCP request presents that token as a bearer, and
 * this module turns it into the SAME authorization context the dashboard
 * uses: a (userId, email) pair role-checked per business through the
 * central permission matrix (src/lib/authz/policy.ts).
 *
 * Verification is delegated to supabase-js `auth.getClaims(token)`, which
 * validates expiry + signature locally against the project JWKS for
 * asymmetric keys and falls back to a `getUser` round-trip for legacy
 * HS256 projects, so the same code path works regardless of the
 * project's JWT signing configuration.
 */

import type { AuthUser } from "@/lib/auth";
import type { BusinessAction, BusinessRole } from "@/lib/authz/policy";

/** The identity behind a verified MCP bearer token. */
export type McpAuthUser = {
  userId: string;
  email: string;
  /**
   * Which assistant is calling, from the route the request arrived on.
   *
   * Only outbound attribution uses it, and it must never influence
   * authorization: permissions come from the caller's team role, and a tool
   * that behaved differently per assistant would be a policy nobody wrote.
   *
   * Optional so the 30-odd tools that do not care, and their tests, are
   * untouched. Absent means the Claude connector, which is what every row
   * predating the second route is.
   */
  client?: "claude" | "chatgpt";
  /**
   * Set ONLY by the dashboard-chat bridge, and only when the platform admin
   * is running a turn under view-as: the business id their view-as cookie
   * pins. `mcpBusinessRoleOutcome` grants owner for exactly that business
   * when the caller's email holds no role on it, so an impersonating admin
   * gets the same bridged toolset as the owner they are standing in for
   * instead of tools that can only refuse.
   *
   * Never derived from request data, and never present on a bearer-token
   * connector request (`verifySupabaseAccessToken` does not set it): the
   * only writer is server code that has already checked `user.isAdmin` and
   * read the httpOnly cookie. It carries the business ID rather than a
   * boolean so the grant cannot leak to a second business inside one turn.
   */
  adminViewAsBusinessId?: string;
};

/**
 * Tool-facing failure: the message is returned to the model verbatim (as an
 * `isError` tool result), so keep it actionable, "call list_businesses",
 * "your role can't do this", never internal detail.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Verify a Supabase access token and extract the caller. Returns null for
 * anything that should 401: bad signature, expired, anon-role tokens (the
 * publishable key is itself a JWT on legacy projects, `role: "anon"`, no
 * sub), or tokens without an email (all business authz is email-based).
 */
export async function verifySupabaseAccessToken(
  token: string
): Promise<McpAuthUser | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey || !token) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await client.auth.getClaims(token);
    if (error || !data?.claims) return null;
    const claims = data.claims as Record<string, unknown>;
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const role = typeof claims.role === "string" ? claims.role : "";
    const email = typeof claims.email === "string" ? claims.email.trim() : "";
    if (!sub || role !== "authenticated" || !email) return null;
    return { userId: sub, email };
  } catch {
    return null;
  }
}

/** The `AuthUser` shape existing helpers expect. MCP callers are never admin. */
export function toAuthUser(auth: McpAuthUser): AuthUser {
  return { userId: auth.userId, email: auth.email, isAdmin: false };
}

/**
 * Role-gate one tool call on one business through the central permission
 * matrix, the MCP twin of `requireBusinessRole` (src/lib/auth.ts), minus
 * the admin bypass (connector callers are always role-checked). Refusals
 * are security-logged like every other authorization surface.
 */
export async function requireMcpBusinessRole(
  auth: McpAuthUser,
  businessId: string,
  action: BusinessAction
): Promise<BusinessRole> {
  const refuse = async (reason: string): Promise<never> => {
    const { logger } = await import("@/lib/logger");
    logger.warn("mcp authorization refused", {
      businessId,
      action,
      userId: auth.userId,
      reason
    });
    throw new McpToolError(
      "You don't have permission to do that on this business. Ask the business owner to adjust your team role."
    );
  };

  const outcome = await mcpBusinessRoleOutcome(auth, businessId, action);
  if (!outcome.allowed) return refuse(outcome.reason);
  return outcome.role;
}

/**
 * The permission check without the throw and without the security log.
 *
 * `requireMcpBusinessRole` is the right shape for a tool acting on ONE
 * business: a refusal is an answer the caller asked for, so it is logged and
 * raised. `search` fans out across every business the account can reach, where
 * hitting one it cannot use is the normal case rather than a refusal. Sharing
 * the throwing version there would emit an "mcp authorization refused" warning
 * per business per query, turning ordinary searches into security-log noise
 * and burying the real refusals.
 */
async function mcpBusinessRoleOutcome(
  auth: McpAuthUser,
  businessId: string,
  action: BusinessAction
): Promise<{ allowed: true; role: BusinessRole } | { allowed: false; reason: string }> {
  const { getBusinessRoleForEmail } = await import("@/lib/db/business-members");
  const emailRole = await getBusinessRoleForEmail(businessId, auth.email);
  // Admin view-as (dashboard bridge only, see `adminViewAsBusinessId`): the
  // operator's own email holds no role on a customer's business, and refusing
  // here would leave every bridged tool declared-but-dead for them.
  const role =
    emailRole ??
    (auth.adminViewAsBusinessId === businessId ? ("owner" as BusinessRole) : null);
  if (!role) return { allowed: false, reason: "no_role" };

  const { can } = await import("@/lib/authz/policy");
  if (!can(role, action)) return { allowed: false, reason: `role_${role}_insufficient` };

  // The dashboard's "Connected" badge is stamped HERE, not at the bearer
  // check, because this is the first point where the business is known, and
  // an allowed call is stronger proof the connector works than a verified
  // token is. Refusals deliberately do not stamp: an assistant that cannot
  // act on a business has not connected to it.
  //
  // ONLY for real connector sessions: `client` is set by authFromContext on
  // every MCP request, and deliberately absent when the inline Gemini
  // surfaces run these handlers through the bridge, a dashboard turn must
  // not light the Claude badge for an owner who never connected Claude
  // (and the bridge's synthetic caller ids would fail the uuid key).
  //
  // Debounced inside, and swallowed here as well as there. The inner catch is
  // the contract, this one makes it structural: every tool call in the
  // product now runs through this line, so bookkeeping that starts throwing
  // would take down the whole connector rather than one badge.
  if (auth.client) {
    const { recordMcpConnectorSeen } = await import("@/lib/mcp/connector-status");
    await recordMcpConnectorSeen(auth.userId, auth.client, businessId).catch(() => undefined);
  }

  return { allowed: true, role };
}

/** May this caller do `action` on this business? Never throws, never logs. */
export async function mcpBusinessRoleAllows(
  auth: McpAuthUser,
  businessId: string,
  action: BusinessAction
): Promise<boolean> {
  return (await mcpBusinessRoleOutcome(auth, businessId, action)).allowed;
}

/** How many businesses one `search` call will fan out across. */
export const MCP_SEARCH_BUSINESS_LIMIT = 5;

/**
 * Which businesses a bare `search` should look in.
 *
 * Deliberately NOT `resolveMcpBusinessId`, which throws when an account can
 * reach more than one business. That is right for a tool that has to act
 * somewhere specific, and exactly wrong for search: it would make a bare
 * `search("Maria")` fail for the accounts that most need it. Explicit wins;
 * otherwise take the accessible businesses, capped, so one query cannot fan
 * out unboundedly.
 */
export async function resolveMcpBusinessIdsForSearch(
  auth: McpAuthUser,
  explicit?: string
): Promise<string[]> {
  if (explicit) return [explicit];
  const { listAccessibleBusinesses } = await import("@/lib/dashboard/active-business");
  const accessible = await listAccessibleBusinesses(toAuthUser(auth));
  if (accessible.length === 0) {
    throw new McpToolError("This account has no businesses on New Coworker.");
  }
  return accessible.slice(0, MCP_SEARCH_BUSINESS_LIMIT).map((b) => b.businessId);
}

/**
 * Resolve which business a tool call targets. An explicit `business_id`
 * wins (it is still role-checked by the caller); otherwise the user's sole
 * accessible business is used, and ambiguity is surfaced back to the model
 * with a pointer at list_businesses.
 */
export async function resolveMcpBusinessId(
  auth: McpAuthUser,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;
  const { listAccessibleBusinesses } = await import("@/lib/dashboard/active-business");
  const accessible = await listAccessibleBusinesses(toAuthUser(auth));
  if (accessible.length === 0) {
    throw new McpToolError("This account has no businesses on New Coworker.");
  }
  if (accessible.length > 1) {
    throw new McpToolError(
      "This account can access multiple businesses, call list_businesses and pass business_id explicitly."
    );
  }
  return accessible[0].businessId;
}
