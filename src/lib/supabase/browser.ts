import { createBrowserClient } from "@supabase/ssr";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url) {
    throw new Error("Missing Supabase URL environment variable");
  }

  if (!anonKey) {
    throw new Error("Missing Supabase anon key environment variable");
  }

  if (!browserClient) {
    browserClient = createBrowserClient(url, anonKey);
  }

  return browserClient;
}

export function resetSupabaseBrowserClientCache(): void {
  browserClient = null;
}

/**
 * Scrubs stale Supabase auth cookies from the browser before kicking off a
 * fresh auth flow that ends with a callback to /api/auth/callback (signUp,
 * magic-link signInWithOtp, password reset).
 *
 * Why this exists:
 * - The email confirmation link sends the user back to /api/auth/callback.
 *   The browser includes every cookie scoped to our domain on that request.
 *   When chunked auth-token cookies (`sb-<projectref>-auth-token.0`, `.1`,
 *   `.2`, …) from a prior or abandoned session are still present, the
 *   total request headers can exceed Vercel's edge limit (~32 KB). Vercel
 *   responds 494 REQUEST_HEADER_TOO_LARGE BEFORE our middleware or route
 *   handler runs, so we cannot recover server-side — by the time any of
 *   our code runs, the user has already seen a Vercel error page.
 * - The only reliable defense is to ensure stale cookies don't ride into
 *   the new auth flow. Calling this immediately before the SDK call that
 *   triggers the email guarantees the eventual callback request carries at
 *   most a fresh PKCE code-verifier (≈250 B) plus whatever Supabase sets
 *   on the callback response.
 *
 * Safe to call in any context — no-ops on the server, swallows SDK errors
 * (e.g. anonymous users where `signOut` has nothing to do), and falls
 * through to a manual `document.cookie` scrub for any orphaned chunks the
 * SDK doesn't own (different project ref, dangling chunks left by an
 * interrupted prior flow, etc.).
 */
export async function clearStaleSupabaseAuthCookies(): Promise<void> {
  if (typeof document === "undefined") return;

  // Best-effort: ask the SDK to clear locally first. `scope: "local"` skips
  // the network call and silently no-ops for anonymous users.
  try {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // SDK unavailable / env vars missing / no session — fall through to the
    // manual scrub which handles cookies the SDK didn't own anyway.
  }

  // Belt-and-suspenders manual scrub. @supabase/ssr writes its cookies with
  // Path=/ and no Domain attribute, so we expire by writing the same name
  // with Path=/ and Max-Age=0. We only touch `sb-*` so we don't accidentally
  // clear unrelated app cookies.
  for (const raw of document.cookie.split("; ")) {
    if (!raw) continue;
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    if (!name.startsWith("sb-")) continue;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}
