import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthUser = {
  userId: string;
  email: string | null;
  /**
   * When present (always from `getAuthUser`), trimmed E.164 or provider format;
   * `null` if the auth user has no phone. Optional so tests can omit the field.
   */
  phone?: string | null;
  isAdmin: boolean;
};

/**
 * Resolve the signed-in auth user from the request cookies.
 *
 * Wrapped in React `cache()` so that within a single server request (the
 * dashboard layout + the page + any nested server components, or a route
 * handler that calls both `getAuthUser` and `requireOwner`) we make ONE
 * `auth.getUser()` round-trip instead of 2-3 sequential ones. Each
 * `/auth/v1/user` call is a network hop to Supabase Auth that validates the
 * JWT server-side, so collapsing the duplicates is the biggest per-render
 * TTFB win. Outside of a request scope (e.g. unit tests) `cache` is a
 * pass-through and does not memoize, so per-test mocks still apply.
 */
export const getAuthUser = cache(async function getAuthUser(): Promise<AuthUser | null> {
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

    const phoneRaw = data.user.phone?.trim() ?? "";
    return {
      userId: data.user.id,
      email: data.user.email ?? null,
      phone: phoneRaw.length > 0 ? phoneRaw : null,
      isAdmin
    };
  } catch {
    return null;
  }
});

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
    if (!error) {
      // RPC is present and returned a definitive answer. Trust it: a
      // non-empty string is a hit, null/empty is a genuine miss. The
      // SQL is `select id from auth.users where lower(email)=... limit 1`
      // so a `null` result means "no such user". Falling through to
      // the paginated listUsers scan in the miss case would burn up to
      // PAGE_CAP * perPage (2,000) admin API calls per nonexistent
      // email — exactly the regression this RPC was added to fix.
      return typeof data === "string" && data.length > 0 ? data : null;
    }
    // PostgREST surfaces "function does not exist" with PGRST202 on
    // older instances that haven't applied the migration yet. Swallow
    // and fall through to the listUsers fallback so staging/dev don't
    // hard-break. Any OTHER rpc error is a true lookup failure and we
    // return null (same contract as before — "not found").
    if (error.code !== "PGRST202") {
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

/**
 * Strict variant of `findAuthUserIdByEmail` that throws on lookup
 * failure instead of collapsing it into a "no user found" result.
 *
 * Use at security gates where a silent miss on a transient DB error
 * would silently open the gate. The pre-payment account-uniqueness
 * check at `/api/checkout` is the canonical caller: refusing the
 * checkout when we cannot determine email availability is strictly
 * safer than letting a paid Stripe session bind to an email we
 * couldn't verify is unclaimed (which would re-open the
 * registration-injection surface that motivated this gate).
 *
 * Returns `true` iff the email definitively maps to an existing
 * auth user, `false` iff it definitively does not. Throws on every
 * other condition (RPC error, listUsers error, scan exhausted
 * without a definitive answer).
 */
export async function authUserExistsByEmail(email: string): Promise<boolean> {
  const target = email.trim().toLowerCase();
  if (!target) return false;

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  // Fast path: SECURITY DEFINER RPC. Treat any RPC error other than
  // "function does not exist" (PGRST202) as a hard failure — silent
  // null on, say, a replica timeout would let an attacker bypass
  // the uniqueness gate by retrying until a transient miss landed.
  const { data, error } = await db.rpc("find_auth_user_id_by_email", {
    p_email: target
  });
  if (!error) {
    return typeof data === "string" && data.length > 0;
  }
  if (error.code !== "PGRST202") {
    throw new Error(`Auth-user lookup failed: ${error.message ?? "unknown error"}`);
  }

  // Legacy fallback for deployments without the RPC migration. Same
  // bounded scan as `findAuthUserIdByEmail`, but listUsers errors
  // and exhausted-scan-without-answer both throw rather than being
  // swallowed.
  const PAGE_CAP = 10;
  const perPage = 200;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const { data: pageData, error: pageError } = await db.auth.admin.listUsers({ page, perPage });
    if (pageError) {
      throw new Error(`Auth-user lookup failed: ${pageError.message ?? "unknown error"}`);
    }
    const users = pageData?.users ?? [];
    if (users.length === 0) return false;
    if (users.find((u) => (u.email ?? "").toLowerCase() === target)) return true;
    if (users.length < perPage) return false;
  }
  throw new Error(
    "Auth-user lookup failed: paginated scan reached the cap without a definitive miss; refuse rather than risk a false negative"
  );
}
