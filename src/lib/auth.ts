import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthUser = {
  userId: string;
  email: string | null;
  isAdmin: boolean;
};

export async function getAuthUser(): Promise<AuthUser | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
      return null;
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    const isAdmin =
      !!adminEmail &&
      !!data.user.email &&
      data.user.email.toLowerCase() === adminEmail.toLowerCase();

    return {
      userId: data.user.id,
      email: data.user.email ?? null,
      isAdmin
    };
  } catch {
    return null;
  }
}

export async function requireAuth(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) {
    const err = Object.assign(new Error("Authentication required"), { status: 401 });
    throw err;
  }
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireAuth();
  if (!user.isAdmin) {
    const err = Object.assign(new Error("Admin access required"), { status: 403 });
    throw err;
  }
  return user;
}

export async function requireOwner(businessId: string): Promise<AuthUser> {
  const user = await requireAuth();
  if (user.isAdmin) return user;

  if (!user.email) {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    throw err;
  }

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("businesses")
    .select("id")
    .eq("id", businessId)
    .eq("owner_email", user.email)
    .single();

  if (!data) {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    throw err;
  }

  return user;
}

export async function verifySignupIdentity(userId: string, email: string): Promise<boolean> {
  try {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const db = await createSupabaseServiceClient();
    const { data, error } = await db.auth.admin.getUserById(userId);

    if (error || !data?.user?.email) return false;
    return data.user.email.toLowerCase() === email.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Resolves a Supabase auth user's id by their email. Used by the grace-
 * sweep cron and admin delete/force-refund routes, which need to disable
 * the owner's auth user but only have the business's `owner_email`.
 *
 * Fast path: `find_auth_user_id_by_email` SECURITY DEFINER RPC (migration
 * `20260503000000_find_auth_user_by_email.sql`). Index-backed single
 * lookup against `auth.users.email`, constant-time per call.
 *
 * Fallback: older deployments that haven't applied the migration yet
 * land in a bounded `auth.admin.listUsers` scan — capped at
 * `PAGE_CAP * perPage` total users scanned — so a nonexistent email
 * can't linearly scan the entire auth directory. This used to read
 * `PAGE_CAP = 500` (100K users) despite a docblock claiming 10 pages;
 * we've tightened it back to match the docblock.
 *
 * Returns `null` when no user matches — callers should treat that as a
 * benign "already deleted" state rather than an error, since the same
 * grace-sweep row can be retried if an earlier run already removed the
 * user.
 */
export async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  // Fast path: SECURITY DEFINER RPC backed by `auth.users.email` index.
  try {
    const { data, error } = await db.rpc("find_auth_user_id_by_email", {
      p_email: target
    });
    if (!error && typeof data === "string" && data.length > 0) {
      return data;
    }
    // PostgREST surfaces "function does not exist" with PGRST202 on
    // older instances that haven't applied the migration yet. Swallow
    // and fall through to the listUsers fallback so staging/dev don't
    // hard-break. Any OTHER rpc error is a true lookup failure and we
    // return null (same contract as before — "not found").
    if (error && error.code !== "PGRST202") {
      return null;
    }
  } catch {
    // Network / unexpected runtime error: fall through to fallback.
  }

  // Legacy fallback: bounded admin.listUsers scan. The hard cap is
  // deliberately small (10 pages × 200 per page = 2,000 users) because
  // any production deployment large enough to exceed this should have
  // the RPC applied. The prior 500-page cap meant a single miss on a
  // nonexistent email burned up to 100,000 auth API calls.
  const PAGE_CAP = 10;
  const perPage = 200;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const users = data?.users ?? [];
    if (users.length === 0) return null;
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (users.length < perPage) return null;
  }
  return null;
}
