/**
 * Admin "view as": lets the (single) admin drive the owner dashboard as any
 * tenant, so tier-specific UI (starter vs standard perks, BYON / carrier
 * registration, billing states…) can be inspected AND operated without
 * owning a test account per tier.
 *
 * Mechanism: an httpOnly cookie carrying the target business id, set by
 * POST /api/admin/view-as (admin-only) and honored ONLY when the signed-in
 * user is the admin, a forged cookie on a non-admin session is inert
 * because every read re-checks `user.isAdmin` server-side.
 *
 * Dashboard pages resolve their business by `owner_email`; the resolver here
 * maps the impersonated business back to its owner's email so those queries
 * need only swap `user.email` for `resolveDashboardOwnerEmail(user)`.
 *
 * ## View-as is FULL access, not read-only
 *
 * Impersonation used to refuse every mutation (an `isViewAsActive` 403 on
 * ~50 routes) because the tenant-facing write paths resolved "the" business
 * from the SIGNED-IN user's email, so an admin's save would have landed on
 * the admin's own business. That hazard is gone: business-scoped writes now
 * resolve through `resolveActiveBusinessContext`, which honors the view-as
 * pin, or take an explicit `businessId` guarded by `requireBusinessRole`
 * (admins pass). The admin is a support operator and needs to be able to
 * perform any action for any tenant, so the refusals are gone with it.
 *
 * Two things that stay true, and the reason `resolveViewAsTargetUser` below
 * exists:
 *
 *  - A handful of routes are USER-scoped, not business-scoped (login email,
 *    UI locale, account deletion's auth-user teardown). "Any action for any
 *    user" means those must act on the IMPERSONATED OWNER's auth user, never
 *    on the admin's own account. Deleting the admin's login while they
 *    clean up a tenant is not a permission question, it is the wrong row.
 *  - Supabase's `auth.oauth` API only ever acts on the caller's own grants,
 *    so the connector Disconnect (src/app/api/integrations/mcp/route.ts)
 *    still skips the revoke when the admin is not the connected login. That
 *    is a platform limit, not a policy gate.
 *
 * Entering view-as is audited (`logAdminAction` "view_as"), which is what
 * ties any subsequent tenant-surface write back to the operator.
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { findAuthUserIdByEmail, type AuthUser } from "@/lib/auth";
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
  /**
   * Set iff the admin is actively impersonating a tenant. `selfOwned` marks
   * the special case where the impersonated business's owner IS the admin
   * (the internal HQ tenant): the dashboard renders exactly as it would for
   * the plain owner, and the banner says so rather than claiming the admin
   * is looking at someone else's account. It also means the user-scoped
   * routes need no retargeting: the impersonated owner already IS the
   * signed-in user.
   */
  viewAs: { businessId: string; name: string; tier: string; selfOwned: boolean } | null;
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
async function resolveViewAsContextUncached(user: AuthUser): Promise<ViewAsContext> {
  const viewAsId = await getViewAsBusinessId(user);
  if (!viewAsId) return { ownerEmail: user.email, viewAs: null };

  const db = await createSupabaseServiceClient();
  const { data } = await db
    .from("businesses")
    .select("id, name, tier, owner_email")
    .eq("id", viewAsId)
    .maybeSingle();
  if (!data?.owner_email) return { ownerEmail: user.email, viewAs: null };

  // Self-impersonation: the impersonated business's owner IS the admin (the
  // internal HQ tenant). The dashboard resolves to the same business either
  // way, so the banner says "your own business" and the user-scoped routes
  // skip their owner lookup. The context is still returned so the layout
  // keeps the admin on /dashboard with the banner (and its exit) instead of
  // bouncing them to /admin/dashboard.
  const selfOwned =
    typeof user.email === "string" &&
    (data.owner_email as string).toLowerCase() === user.email.toLowerCase();

  // Dashboard pages resolve "the" business as the NEWEST row under
  // owner_email, so view-as is effectively "view as this OWNER". When the
  // owner has multiple businesses, mirror the pages' newest-row pick here so
  // the banner names the business the pages will actually render, not the
  // (possibly older) row the admin clicked.
  const { data: newest } = await db
    .from("businesses")
    .select("id, name, tier")
    .eq("owner_email", data.owner_email as string)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const effective = (newest ?? data) as { id: string; name: string | null; tier: string | null };

  return {
    ownerEmail: data.owner_email as string,
    viewAs: {
      businessId: effective.id,
      name: effective.name ?? "",
      tier: effective.tier ?? "starter",
      selfOwned
    }
  };
}

/**
 * Per-request memo. Under view-as this costs two `businesses` reads, and a
 * single dashboard render pass now asks for it from several places at once:
 * the layout (banner + owner-email lookups), the settings shell, the
 * notifications page, and `resolveViewAsTargetUser`. React `cache()` keys on
 * the `user` object, and every caller gets the SAME object within a request
 * because `getAuthUser` is itself `cache()`d, so they share one resolution.
 * Outside a request scope (unit tests) `cache` is a pass-through and does not
 * memoize, same as the active-business resolver.
 */
export const resolveViewAsContext = cache(
  async (user: AuthUser): Promise<ViewAsContext> => resolveViewAsContextUncached(user)
);

/** Shorthand for pages that only need the effective email. */
export async function resolveDashboardOwnerEmail(user: AuthUser): Promise<string | null> {
  return (await resolveViewAsContext(user)).ownerEmail;
}

/**
 * Which auth user a USER-scoped action should act on.
 *
 * Most tenant-facing writes are business-scoped and need nothing from here:
 * they resolve the business through `resolveActiveBusinessContext` (view-as
 * aware) or take an explicit `businessId`. A few are keyed on the auth user
 * itself: the login email (`/api/account/email`), the UI locale
 * (`/api/account/locale`), the auth-user teardown inside
 * `/api/account/delete`, the clickwrap ledger (`/api/legal/accept`). For
 * those, "admin performs the action for this tenant" means the impersonated
 * OWNER's auth user, not the admin's own.
 *
 * Returns:
 *  - `impersonating: false` with the signed-in user's own id/email, for a
 *    normal owner, a teammate, or an admin who is not in view-as (including
 *    self-owned view-as, where the owner already IS the signed-in user);
 *  - `impersonating: true` with the impersonated owner's auth user id and
 *    email;
 *  - `impersonating: true` with `userId: null` when the tenant's
 *    `owner_email` has no auth user behind it (a pending/placeholder owner,
 *    or a login already deleted). Callers MUST refuse in that case: falling
 *    back to the signed-in user would silently apply the change to the
 *    admin's own account, which is the exact wrong-row bug this resolver
 *    exists to prevent.
 */
export type ViewAsTargetUser = {
  /** The auth user id to act on, or null when the owner has no login. */
  userId: string | null;
  /** The email that goes with `userId` (the tenant's owner_email under view-as). */
  email: string | null;
  /** True iff this is a FOREIGN tenant, i.e. the target is not the caller. */
  impersonating: boolean;
};

export async function resolveViewAsTargetUser(user: AuthUser): Promise<ViewAsTargetUser> {
  const { ownerEmail, viewAs } = await resolveViewAsContext(user);
  if (!viewAs || viewAs.selfOwned || !ownerEmail) {
    return { userId: user.userId, email: user.email, impersonating: false };
  }
  // Bounded, index-backed lookup (find_auth_user_id_by_email RPC). A miss
  // returns null rather than throwing so the caller can answer with a clear
  // "this tenant has no login" instead of a 500.
  const userId = await findAuthUserIdByEmail(ownerEmail);
  return { userId, email: ownerEmail, impersonating: true };
}
