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
