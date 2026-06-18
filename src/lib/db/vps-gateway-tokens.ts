/**
 * Per-tenant Rowboat/VPS gateway tokens.
 *
 * Replaces the single platform-wide `ROWBOAT_GATEWAY_TOKEN` with a distinct
 * token per business so a compromise of one tenant VPS can't impersonate
 * another. Schema: `supabase/migrations/20260619020000_vps_gateway_tokens.sql`.
 * This module is the only reader/writer of `vps_gateway_tokens` from app code.
 *
 * The token is used two ways by the VPS:
 *   1. Bearer auth on VPS -> app calls (voice tools, nango proxy, custom
 *      credentials/call, aiflows, provisioning progress) — resolved here via
 *      the sha256 index (`resolveGatewayTokenBinding`).
 *   2. The HMAC secret Rowboat signs its tool-call JWT with, AND the API key
 *      the platform sends when calling the tenant's Rowboat — both need the
 *      plaintext token (`getActiveGatewayTokenForBusiness`).
 *
 * Storing the plaintext is acceptable: the row is service_role-only (RLS on,
 * no policies), identical posture to `vps_ssh_keys` / integration secrets, and
 * each VPS only ever holds its OWN token — the central app DB is the trusted
 * store and is never placed on a tenant box.
 */
import { createHash, randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Lowercase hex SHA-256 — the lookup index for the bearer path. */
export function gatewayTokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 256 bits of entropy, URL/header-safe (base64url). */
export function generateGatewayToken(): string {
  return randomBytes(32).toString("base64url");
}

export type GatewayTokenBinding = { businessId: string; token: string };

/**
 * Resolve the active per-tenant token row for a presented bearer token.
 * Returns null when the token isn't a known per-tenant token (the caller then
 * falls back to the legacy shared env token during the transition).
 */
export async function resolveGatewayTokenBinding(
  token: string,
  client?: SupabaseClient
): Promise<GatewayTokenBinding | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_gateway_tokens")
    .select("business_id, token")
    .eq("token_sha256", gatewayTokenSha256(trimmed))
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`resolveGatewayTokenBinding: ${error.message}`);
  if (!data) return null;
  return { businessId: data.business_id as string, token: data.token as string };
}

/**
 * Return the active per-tenant token (plaintext) for a business, used for
 * HMAC JWT verification and as the outbound Rowboat API key. Returns null when
 * the business has no per-tenant token yet (caller falls back to the shared env
 * token).
 */
export async function getActiveGatewayTokenForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_gateway_tokens")
    .select("token")
    .eq("business_id", businessId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getActiveGatewayTokenForBusiness: ${error.message}`);
  return data ? (data.token as string) : null;
}

export type IssueGatewayTokenOptions = {
  /** Human-readable note (e.g. "provisioning", "seed:existing-shared"). */
  label?: string;
  /** Use a specific token value instead of minting one (e.g. seeding an existing VPS token). */
  token?: string;
  /** Revoke any prior active tokens for the business first. Default true. */
  revokeExisting?: boolean;
};

/**
 * Mint + store a per-tenant token, returning the plaintext. By default revokes
 * any prior active token for the business (rotation). Idempotent-friendly:
 * `getOrIssueGatewayToken` is preferred on the provisioning path so a
 * re-provision doesn't churn the token.
 */
export async function issueGatewayToken(
  businessId: string,
  options: IssueGatewayTokenOptions = {},
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const token = options.token ?? generateGatewayToken();
  if (options.revokeExisting !== false) {
    const { error: revErr } = await db
      .from("vps_gateway_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .is("revoked_at", null);
    if (revErr) throw new Error(`issueGatewayToken(revoke): ${revErr.message}`);
  }
  const { error } = await db.from("vps_gateway_tokens").insert({
    business_id: businessId,
    token,
    token_sha256: gatewayTokenSha256(token),
    label: options.label ?? null
  });
  if (error) throw new Error(`issueGatewayToken(insert): ${error.message}`);
  return token;
}

/**
 * Resolve the business's active per-tenant token, minting one if absent.
 * Used by the provisioning path so a stable token flows to the VPS across
 * re-provisions (only the first provision mints).
 */
export async function getOrIssueGatewayToken(
  businessId: string,
  options: IssueGatewayTokenOptions = {},
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const existing = await getActiveGatewayTokenForBusiness(businessId, db);
  if (existing) return existing;
  return issueGatewayToken(businessId, { ...options, revokeExisting: false }, db);
}
