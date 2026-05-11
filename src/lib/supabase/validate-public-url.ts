/**
 * Guardrail: if NEXT_PUBLIC_SUPABASE_URL shares the app hostname, GoTrue requests
 * hit this Next.js deployment (e.g. GET /auth/v1/user → HTML error page) and
 * auth-js throws AuthUnknownError ("Unexpected token '<' ...").
 */
export function assertPublicSupabaseUrlIsNotAppOrigin(
  supabaseUrl: string | undefined,
  appUrl: string | undefined,
): void {
  if (!supabaseUrl?.trim() || !appUrl?.trim()) {
    return;
  }
  let supabaseHostname: string;
  let appHostname: string;
  try {
    supabaseHostname = new URL(supabaseUrl.trim()).hostname.replace(/^www\./i, "").toLowerCase();
    appHostname = new URL(appUrl.trim()).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_APP_URL must be valid absolute URLs");
  }
  if (supabaseHostname === appHostname) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must not use the same hostname as NEXT_PUBLIC_APP_URL — Auth REST calls would return HTML from this app.",
    );
  }
}
