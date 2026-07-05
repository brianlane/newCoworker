/**
 * Persistence for `api_keys` — hashed bearer credentials for the public
 * REST API. See src/lib/public-api/keys.ts for the credential format; this
 * module never sees plaintext keys, only SHA-256 hashes.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ApiKeyRow = {
  id: string;
  business_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** Cap per business so a runaway integration can't mint unbounded rows. */
export const MAX_ACTIVE_API_KEYS_PER_BUSINESS = 10;

export async function insertApiKey(
  input: { businessId: string; name: string; keyPrefix: string; keyHash: string },
  client?: SupabaseClient
): Promise<ApiKeyRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("api_keys")
    .insert({
      business_id: input.businessId,
      name: input.name,
      key_prefix: input.keyPrefix,
      key_hash: input.keyHash
    })
    .select()
    .single();
  if (error) throw new Error(`insertApiKey: ${error.message}`);
  return data as ApiKeyRow;
}

/** Active (non-revoked) keys for the dashboard list. Hash omitted. */
export async function listApiKeys(
  businessId: string,
  client?: SupabaseClient
): Promise<Omit<ApiKeyRow, "key_hash">[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("api_keys")
    .select("id, business_id, name, key_prefix, created_at, last_used_at, revoked_at")
    .eq("business_id", businessId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listApiKeys: ${error.message}`);
  return (data as Omit<ApiKeyRow, "key_hash">[] | null) ?? [];
}

export async function countActiveApiKeys(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .is("revoked_at", null);
  if (error) throw new Error(`countActiveApiKeys: ${error.message}`);
  return count ?? 0;
}

/**
 * Revoke a key. Scoped by business id so an owner can never revoke another
 * tenant's key even with a guessed uuid. Returns false when nothing matched.
 */
export async function revokeApiKey(
  businessId: string,
  keyId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("business_id", businessId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`revokeApiKey: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length > 0;
}

/** Resolve an ACTIVE key row by its hash — the public-API auth lookup. */
export async function findActiveApiKeyByHash(
  keyHash: string,
  client?: SupabaseClient
): Promise<ApiKeyRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("api_keys")
    .select("*")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`findActiveApiKeyByHash: ${error.message}`);
  return (data as ApiKeyRow | null) ?? null;
}

/**
 * Best-effort last-used stamp; auth must never fail because a telemetry
 * write did.
 */
export async function touchApiKeyLastUsed(
  keyId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  await db
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyId);
}
