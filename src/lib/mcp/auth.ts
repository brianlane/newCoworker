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
 * HS256 projects — so the same code path works regardless of the
 * project's JWT signing configuration.
 */

import type { AuthUser } from "@/lib/auth";
import type { BusinessAction, BusinessRole } from "@/lib/authz/policy";

/** The identity behind a verified MCP bearer token. */
export type McpAuthUser = {
  userId: string;
  email: string;
};

/**
 * Tool-facing failure: the message is returned to the model verbatim (as an
 * `isError` tool result), so keep it actionable — "call list_businesses",
 * "your role can't do this" — never internal detail.
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
 * publishable key is itself a JWT on legacy projects — `role: "anon"`, no
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
 * matrix — the MCP twin of `requireBusinessRole` (src/lib/auth.ts), minus
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

  const { getBusinessRoleForEmail } = await import("@/lib/db/business-members");
  const role = await getBusinessRoleForEmail(businessId, auth.email);
  if (!role) return refuse("no_role");

  const { can } = await import("@/lib/authz/policy");
  if (!can(role, action)) return refuse(`role_${role}_insufficient`);

  return role;
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
      "This account can access multiple businesses — call list_businesses and pass business_id explicitly."
    );
  }
  return accessible[0].businessId;
}
