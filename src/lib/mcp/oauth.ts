/**
 * OAuth discovery constants for the MCP connector.
 */

/** Supabase Auth's OAuth 2.1 issuer for this project (RFC 8414 `issuer`). */
export function supabaseAuthIssuer(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()?.replace(/\/+$/, "");
  if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return `${base}/auth/v1`;
}
