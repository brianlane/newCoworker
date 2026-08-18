import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function createSupabaseServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase public env vars");
  }

  const cookieStore = await cookies();

  // Use getAll/setAll (not deprecated get/set/remove). The legacy API only reads
  // a fixed small number of chunked cookies; large sessions (big JWT / metadata)
  // span more chunks and corrupt auth storage ("Cannot create property 'user' on string").
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component, cookies are read-only; ignore writes.
        }
      },
    },
  });
}

export async function createSupabaseServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase service role env vars");
  }

  const { createClient } = await import("@supabase/supabase-js");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });
}

/**
 * Service client with the experimental passkey admin API switched on.
 *
 * `auth.admin.passkey.{listPasskeys,deletePasskey}` throw unless the client was
 * built with `experimental: { passkey: true }` (same flag the browser client
 * sets for the tenant-facing passkey card). Deliberately a SEPARATE factory
 * rather than adding the flag to `createSupabaseServiceClient`: that one is
 * used by nearly every server path in the app, and flipping an experimental
 * flag for all of them to serve two routes is a much wider blast radius than
 * the feature deserves.
 *
 * Note there is no admin CREATE for passkeys, and there cannot be: a WebAuthn
 * credential is minted by the user's own authenticator after a user-verification
 * gesture, so enrolling one "for" somebody else is not a permission we lack, it
 * is a thing that does not exist. Operators can list and revoke.
 */
export async function createSupabaseAdminPasskeyClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase service role env vars");
  }

  const { createClient } = await import("@supabase/supabase-js");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, experimental: { passkey: true } }
  });
}
