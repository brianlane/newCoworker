/**
 * Per-tenant Rowboat/VPS gateway tokens.
 *
 * Replaces the single platform-wide `ROWBOAT_GATEWAY_TOKEN` with a distinct
 * token per business so a compromise of one tenant VPS can't impersonate
 * another. Schema: `supabase/migrations/20260629020000_vps_gateway_tokens.sql`.
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
 * Latest non-revoked token (plaintext) for a business — INCLUDING a pending
 * (not-yet-deployed) one. Used by provisioning to REUSE a token across deploy
 * retries so a failed deploy doesn't churn the secret. Returns null when the
 * business has no per-tenant token at all.
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

/**
 * Latest non-revoked token (plaintext) that has been CONFIRMED on the VPS
 * (`deployed_at` set). Used for the outbound Rowboat bearer, so the app never
 * gets "ahead" of the box: until a freshly minted token is confirmed deployed,
 * callers fall back to the shared env token (which the VPS is still using).
 * Returns null when the business has no confirmed per-tenant token yet.
 */
export async function getDeployedGatewayTokenForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_gateway_tokens")
    .select("token")
    .eq("business_id", businessId)
    .is("revoked_at", null)
    .not("deployed_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getDeployedGatewayTokenForBusiness: ${error.message}`);
  return data ? (data.token as string) : null;
}

/**
 * Resolve the business that owns Rowboat project `projectId`. The JWT's project
 * claim is `business_configs.rowboat_project_id`, which can be re-pointed per tenant
 * and defaults to the business UUID — so we look it up in the config first and fall
 * back to treating `projectId` as the business id (the >99% case). Both tool-call
 * dispatch AND per-tenant token resolution MUST go through this so a re-pointed
 * project can't authenticate as one business but run tools against another.
 */
export async function resolveBusinessIdForRowboatProject(
  projectId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: cfg, error } = await db
    .from("business_configs")
    .select("business_id")
    .eq("rowboat_project_id", projectId)
    .maybeSingle();
  if (error) throw new Error(`resolveBusinessIdForRowboatProject: ${error.message}`);
  return cfg ? (cfg.business_id as string) : projectId;
}

export type ProjectGatewayTokens = {
  /** Every non-revoked token (pending AND confirmed) for the owning business. */
  tokens: string[];
  /**
   * Whether AT LEAST ONE of those tokens is CONFIRMED deployed (`deployed_at` set).
   * This gates JWT exclusivity: a project with no confirmed token yet is still being
   * signed by its VPS with the shared secret (the deploy that injects the per-tenant
   * token hasn't finished), so the shared secret must still be accepted. Once any
   * token is confirmed the box has switched to it and the shared secret is rejected.
   */
  hasConfirmed: boolean;
};

/**
 * Non-revoked tokens (plaintext) for the business that owns Rowboat project
 * `projectId`, plus whether any is confirmed-deployed. Used for tool-call JWT
 * verification: the VPS starts signing with a freshly deployed token the instant
 * deploy-client.sh restarts Rowboat — before the app confirms it — and during a
 * rotation an old (confirmed) and new (pending) token briefly coexist. Verifying
 * against EVERY non-revoked token (pending or confirmed) removes that window. The
 * `hasConfirmed` flag lets the caller keep accepting the shared secret until the
 * tenant's first token is actually live on the box (see `resolveRowboatWebhookClaims`).
 *
 * `projectId` is the JWT's project claim, which is `business_configs.rowboat_project_id`
 * (re-pointable per tenant) and defaults to the business UUID — so we resolve the
 * owning business via the config first, falling back to treating `projectId` as the
 * business id (the >99% case).
 */
export async function getActiveGatewayTokensForProject(
  projectId: string,
  client?: SupabaseClient
): Promise<ProjectGatewayTokens> {
  const db = client ?? (await createSupabaseServiceClient());
  const businessId = await resolveBusinessIdForRowboatProject(projectId, db);
  const { data, error } = await db
    .from("vps_gateway_tokens")
    .select("token, deployed_at")
    .eq("business_id", businessId)
    .is("revoked_at", null);
  if (error) throw new Error(`getActiveGatewayTokensForProject(tokens): ${error.message}`);
  const rows = data ?? [];
  return {
    tokens: rows.map((row) => row.token as string),
    hasConfirmed: rows.some((row) => row.deployed_at != null)
  };
}

export type IssueGatewayTokenOptions = {
  /** Human-readable note (e.g. "provisioning"). */
  label?: string;
  /** Use a specific token value instead of minting one (e.g. a real VPS rotation). */
  token?: string;
};

/**
 * Mint + store a PENDING per-tenant token (deployed_at NULL), returning the
 * plaintext. The row is inserted before the VPS deploy so in-deploy progress
 * callbacks can authenticate via the inbound binding; the caller confirms it with
 * `markGatewayTokenDeployed` only after a successful deploy. This is insert-only
 * (no revoke-before-insert), so a failed insert never leaves the business with
 * zero active tokens — the existing one stays untouched.
 */
export async function issueGatewayToken(
  businessId: string,
  options: IssueGatewayTokenOptions = {},
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const token = options.token ?? generateGatewayToken();
  // Never store the shared ROWBOAT_GATEWAY_TOKEN as a per-tenant token: doing so
  // would bind the shared secret to one business and break the legacy fallback
  // for every other tenant still presenting it. Per-tenant tokens are always
  // unique (minted here or supplied explicitly during a real VPS rotation).
  const shared = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (shared !== "" && token === shared) {
    throw new Error(
      "issueGatewayToken: refusing to store the shared ROWBOAT_GATEWAY_TOKEN as a per-tenant token"
    );
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
 * Confirm a token is live on the VPS. Delegates to the `confirm_gateway_token`
 * SQL function so the "revoke other active tokens" + "stamp deployed_at" pair runs
 * in ONE transaction: if the confirm fails, the revoke rolls back, so the business
 * is never left without a confirmed token (and the one-confirmed-token unique index
 * is never violated). Idempotent for an already-confirmed token.
 */
export async function markGatewayTokenDeployed(
  businessId: string,
  token: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("confirm_gateway_token", {
    p_business_id: businessId,
    p_token: token
  });
  if (error) throw new Error(`markGatewayTokenDeployed: ${error.message}`);
}
