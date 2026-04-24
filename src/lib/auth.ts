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
 * Resolves a Supabase auth user's id by their email via the admin
 * `listUsers` API. Used by the grace-sweep cron, which needs to delete the
 * auth user for a wiped business but only has the business's `owner_email`.
 *
 * Pagination: we iterate pages until we hit either a match or an empty page.
 * For tenants with <100K auth users this lands inside the first page almost
 * always; the outer cap of 10 pages keeps a pathological misconfigured
 * deployment from hammering the auth API.
 *
 * Returns `null` when no user matches — callers should treat that as a
 * benign "already deleted" state rather than an error, since the same
 * grace-sweep row can be retried if an earlier run already removed the user.
 */
export async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  const PAGE_CAP = 500;
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
