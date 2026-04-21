/**
 * Persistence for per-VPS SSH keypairs.
 *
 * ⚠️ Every row here contains a PLAINTEXT PKCS#8 private key. Reads go through
 * the service role only (see the migration in
 * `supabase/migrations/20260423000000_vps_ssh_keys.sql`). Never expose the
 * private_key_pem column through a PostgREST view, RPC, or client-side read.
 *
 * Access pattern:
 *  - Orchestrator writes once per VPS provision (via {@link insertVpsSshKey}).
 *  - Orchestrator reads to re-SSH for redeploys (via {@link getActiveVpsSshKey}).
 *  - Admin endpoint reads for break-glass console access.
 *  - Rotation inserts a new row and stamps `rotated_at` on the predecessor.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VpsSshKeyRow = {
  id: string;
  business_id: string;
  hostinger_vps_id: string;
  hostinger_public_key_id: number | null;
  public_key: string;
  private_key_pem: string;
  fingerprint_sha256: string;
  ssh_username: string;
  created_at: string;
  rotated_at: string | null;
};

export type InsertVpsSshKeyInput = {
  business_id: string;
  hostinger_vps_id: string;
  hostinger_public_key_id?: number | null;
  public_key: string;
  private_key_pem: string;
  fingerprint_sha256: string;
  ssh_username?: string;
};

export async function insertVpsSshKey(
  input: InsertVpsSshKeyInput,
  client?: SupabaseClient
): Promise<VpsSshKeyRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_ssh_keys")
    .insert({
      business_id: input.business_id,
      hostinger_vps_id: input.hostinger_vps_id,
      hostinger_public_key_id: input.hostinger_public_key_id ?? null,
      public_key: input.public_key,
      private_key_pem: input.private_key_pem,
      fingerprint_sha256: input.fingerprint_sha256,
      ssh_username: input.ssh_username ?? "root"
    })
    .select()
    .single();

  if (error) throw new Error(`insertVpsSshKey: ${error.message}`);
  return data as VpsSshKeyRow;
}

/**
 * Load the currently-active (unrotated) keypair for a VPS. Returns null when
 * no key exists — callers must branch because we never want to return a stale
 * (rotated) key as "active".
 */
export async function getActiveVpsSshKey(
  hostingerVpsId: string,
  client?: SupabaseClient
): Promise<VpsSshKeyRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_ssh_keys")
    .select("*")
    .eq("hostinger_vps_id", hostingerVpsId)
    .is("rotated_at", null)
    .maybeSingle();

  if (error) throw new Error(`getActiveVpsSshKey: ${error.message}`);
  return (data as VpsSshKeyRow | null) ?? null;
}

export async function getActiveVpsSshKeyForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<VpsSshKeyRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_ssh_keys")
    .select("*")
    .eq("business_id", businessId)
    .is("rotated_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getActiveVpsSshKeyForBusiness: ${error.message}`);
  return (data as VpsSshKeyRow | null) ?? null;
}

/** Mark a key as rotated; used after provisioning a replacement. */
export async function markVpsSshKeyRotated(
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_ssh_keys")
    .update({ rotated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`markVpsSshKeyRotated: ${error.message}`);
}
