/**
 * Active-business resolution for the multi-business (agency) dashboard.
 *
 * Historically every dashboard page and owner-scoped API route resolved "the
 * business" as newest-by-owner_email, which breaks down the moment a login
 * can reach more than one business (an agency owner with N businesses, or a
 * Phase-1 team member). This module is the single replacement:
 *
 *  - `listAccessibleBusinesses(user)` — everything the login can open:
 *    businesses they OWN (owner_email match) plus ACTIVE/INVITED memberships
 *    (business_members, Phase 1). Owner rows win when both exist.
 *  - an `active_business` cookie (set by /api/dashboard/active-business via
 *    the sidebar switcher) picks WHICH accessible business the dashboard
 *    shows; it is validated against the accessible set on every read — a
 *    forged cookie can never reach a business the login has no role on.
 *  - admin view-as keeps its own pinned business id and bypasses both the
 *    cookie and memberships (read-only impersonation, unchanged semantics).
 *
 * Fallback order: view-as pin → valid cookie → newest OWNED business →
 * newest membership business. Null when the login can access nothing.
 */

import { cookies } from "next/headers";
import type { AuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getViewAsBusinessId } from "@/lib/admin/view-as";
import type { BusinessAction, BusinessRole } from "@/lib/authz/policy";
import { can } from "@/lib/authz/policy";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const ACTIVE_BUSINESS_COOKIE = "active_business";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessibleBusiness = {
  businessId: string;
  name: string;
  tier: string;
  role: BusinessRole;
  created_at: string;
};

/**
 * Every business this login can open, owner rows first (then newest-first
 * within each group). Invited-but-unbound memberships count — the invite
 * email is the grant, and the first dashboard render binds them active.
 */
export async function listAccessibleBusinesses(
  user: AuthUser,
  client?: SupabaseClient
): Promise<AccessibleBusiness[]> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return [];
  const db = client ?? (await createSupabaseServiceClient());

  // Case-insensitive owner match: businesses.owner_email is NOT lowercased
  // by schema (unlike business_members.email), and getBusinessRoleForEmail
  // compares case-insensitively — an exact-case eq here would hide owned
  // businesses from the switcher while API calls still treat the login as
  // owner. LIKE metacharacters are escaped so an email like a_b@x.com can't
  // wildcard-match other rows.
  const ownerPattern = email.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const { data: owned, error: ownedErr } = await db
    .from("businesses")
    .select("id, name, tier, created_at")
    .ilike("owner_email", ownerPattern)
    .order("created_at", { ascending: false });
  if (ownedErr) throw new Error(`listAccessibleBusinesses: ${ownedErr.message}`);

  const { data: memberships, error: memErr } = await db
    .from("business_members")
    .select("business_id, role, status, businesses(id, name, tier, created_at)")
    .eq("email", email)
    .neq("status", "revoked");
  if (memErr) throw new Error(`listAccessibleBusinesses: ${memErr.message}`);

  const result: AccessibleBusiness[] = [];
  const seen = new Set<string>();
  for (const row of (owned ?? []) as Array<{
    id: string;
    name: string;
    tier: string;
    created_at: string;
  }>) {
    result.push({
      businessId: row.id,
      name: row.name,
      tier: row.tier,
      role: "owner",
      created_at: row.created_at
    });
    seen.add(row.id);
  }
  type MembershipRow = {
    business_id: string;
    role: BusinessRole;
    businesses: { id: string; name: string; tier: string; created_at: string } | null;
  };
  const memberRows = ((memberships ?? []) as unknown as MembershipRow[])
    .filter((m) => m.businesses && !seen.has(m.business_id))
    .sort((a, b) => (a.businesses!.created_at < b.businesses!.created_at ? 1 : -1));
  for (const m of memberRows) {
    result.push({
      businessId: m.business_id,
      name: m.businesses!.name,
      tier: m.businesses!.tier,
      role: m.role,
      created_at: m.businesses!.created_at
    });
  }
  return result;
}

/** The switcher cookie's value, or null when absent/garbled. */
export async function getActiveBusinessCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    const raw = store.get(ACTIVE_BUSINESS_COOKIE)?.value?.trim() ?? "";
    return UUID_RE.test(raw) ? raw : null;
  } catch {
    // cookies() throws outside a request scope (e.g. some test setups).
    return null;
  }
}

export type ActiveBusinessContext = {
  /** The resolved business id, or null when the login can access nothing. */
  businessId: string | null;
  /** The caller's role on that business (owner for view-as impersonation). */
  role: BusinessRole | null;
  /** Everything the login can switch to (empty during admin view-as). */
  accessible: AccessibleBusiness[];
};

/**
 * Resolve which business the dashboard should show for this login.
 * See the module docblock for the precedence rules.
 */
export async function resolveActiveBusinessContext(
  user: AuthUser,
  client?: SupabaseClient
): Promise<ActiveBusinessContext> {
  // Admin view-as: the pinned business, role owner (read-only is enforced by
  // the write paths' isViewAsActive refusals, not here).
  const viewAsId = await getViewAsBusinessId(user);
  if (viewAsId) {
    return { businessId: viewAsId, role: "owner", accessible: [] };
  }

  const accessible = await listAccessibleBusinesses(user, client);
  if (accessible.length === 0) return { businessId: null, role: null, accessible };

  const cookieId = await getActiveBusinessCookie();
  const fromCookie = cookieId ? accessible.find((b) => b.businessId === cookieId) : undefined;
  const chosen = fromCookie ?? accessible[0];
  return { businessId: chosen.businessId, role: chosen.role, accessible };
}

/**
 * One-call replacement for the legacy "newest business by owner_email"
 * page/route pattern: the active business's id, or null when the login can
 * access nothing. Pages keep their own `businesses` SELECT (preserving each
 * page's column list and inferred row types) filtered by this id instead of
 * `owner_email`.
 */
export async function resolveActiveBusinessId(
  user: AuthUser,
  client?: SupabaseClient
): Promise<string | null> {
  const ctx = await resolveActiveBusinessContext(user, client);
  return ctx.businessId;
}

/**
 * Role-gated variant for API routes that were implicitly owner-only through
 * their `owner_email` filter: resolves the active business but returns null
 * unless the caller's role can perform `action` (e.g. the /api/billing/*
 * routes pass "manage_billing" so team members can't bill the business).
 */
export async function resolveActiveBusinessIdForAction(
  user: AuthUser,
  action: BusinessAction,
  client?: SupabaseClient
): Promise<string | null> {
  const ctx = await resolveActiveBusinessContext(user, client);
  if (!ctx.businessId || !ctx.role) return null;
  return can(ctx.role, action) ? ctx.businessId : null;
}
