/**
 * Admin "view as" — lets the (single) admin browse the owner dashboard as any
 * tenant, so tier-specific UI (starter vs standard perks, BYON / carrier
 * registration, billing states…) can be inspected without owning a test
 * account per tier.
 *
 * Mechanism: an httpOnly cookie carrying the target business id, set by
 * POST /api/admin/view-as (admin-only) and honored ONLY when the signed-in
 * user is the admin — a forged cookie on a non-admin session is inert
 * because every read re-checks `user.isAdmin` server-side.
 *
 * Dashboard pages resolve their business by `owner_email`; the resolver here
 * maps the impersonated business back to its owner's email so those queries
 * need only swap `user.email` for `resolveDashboardOwnerEmail(user)`. API
 * routes that mutate on an explicit businessId already pass admins through
 * `requireOwner`, so no change is needed there.
 */

import { cookies } from "next/headers";
import type { AuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const VIEW_AS_COOKIE = "admin_view_as";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The business id the admin is currently viewing as, or null when the cookie
 * is absent/garbled or the user is not the admin. Safe to call from any
 * server component / route handler.
 */
export async function getViewAsBusinessId(user: AuthUser | null): Promise<string | null> {
  if (!user?.isAdmin) return null;
  try {
    const store = await cookies();
    const raw = store.get(VIEW_AS_COOKIE)?.value?.trim() ?? "";
    return UUID_RE.test(raw) ? raw : null;
  } catch {
    // cookies() throws outside a request scope (e.g. some test setups).
    return null;
  }
}

export type ViewAsContext = {
  /** Email to use in `owner_email` dashboard lookups. */
  ownerEmail: string | null;
  /** Set iff the admin is actively impersonating a tenant. */
  viewAs: { businessId: string; name: string; tier: string } | null;
};

/**
 * Resolve the effective owner email for dashboard business lookups.
 *
 * - Normal owner: their own email (identity pass-through, zero extra I/O).
 * - Admin with a valid view-as cookie: the impersonated business's
 *   owner_email, plus the business identity for the banner.
 * - Admin whose cookie points at a deleted business: falls back to the
 *   admin's own email (dashboard renders its normal "no business" state).
 */
export async function resolveViewAsContext(user: AuthUser): Promise<ViewAsContext> {
  const viewAsId = await getViewAsBusinessId(user);
  if (!viewAsId) return { ownerEmail: user.email, viewAs: null };

  const db = await createSupabaseServiceClient();
  const { data } = await db
    .from("businesses")
    .select("id, name, tier, owner_email")
    .eq("id", viewAsId)
    .maybeSingle();
  if (!data?.owner_email) return { ownerEmail: user.email, viewAs: null };

  return {
    ownerEmail: data.owner_email as string,
    viewAs: {
      businessId: data.id as string,
      name: (data.name as string) ?? "",
      tier: (data.tier as string) ?? "starter"
    }
  };
}

/** Shorthand for pages that only need the effective email. */
export async function resolveDashboardOwnerEmail(user: AuthUser): Promise<string | null> {
  return (await resolveViewAsContext(user)).ownerEmail;
}
