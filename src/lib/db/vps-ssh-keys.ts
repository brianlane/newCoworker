/**
 * Persistence for per-VPS SSH keypairs.
 *
 * ⚠️ Every row here contains a PLAINTEXT private key. Reads go through the
 * service role only (see the migration in
 * `supabase/migrations/20260423000000_vps_ssh_keys.sql`). Never expose the
 * `private_key_pem` column through a PostgREST view, RPC, or client-side read.
 *
 * On-the-fly format migration: rows persisted before {@link generateSshKeypair}
 * switched to OpenSSH-format export contain unencrypted PKCS#8 ed25519
 * PEMs. `ssh2` (the library backing `sshExec`) can't parse PKCS#8, so we
 * upgrade the wire format on every read via {@link migrateRow} →
 * {@link convertPkcs8Ed25519PemToOpenssh}. The conversion is idempotent
 * and identity-preserving (same keypair, just re-framed), so the matching
 * public key on the VPS's `~/.ssh/authorized_keys` continues to
 * authenticate. Fresh rows pay zero cost (the migration short-circuits
 * on already-OpenSSH PEMs).
 *
 * Access pattern:
 *  - Orchestrator writes once per VPS provision (via {@link insertVpsSshKey}).
 *  - Orchestrator reads to re-SSH for redeploys (via {@link getActiveVpsSshKey}).
 *  - Lifecycle data-migration reads for backup/restore.
 *  - Admin endpoint reads for break-glass console access.
 *
 * Rotation (stamping `rotated_at` on a predecessor row after a replacement is
 * provisioned) is a planned workflow but is NOT yet wired up. A previous
 * `markVpsSshKeyRotated` helper lived here but was removed because it had no
 * callers — shipping unused exports created a false impression that the
 * rotation path existed. When rotation is implemented, reintroduce a helper
 * alongside the orchestrator call that actually invokes it (and update the
 * partial unique index reasoning in the migration).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { convertPkcs8Ed25519PemToOpenssh } from "@/lib/hostinger/keypair";

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

/**
 * Apply the PKCS#8 → OpenSSH-format migration on every key read.
 *
 * Why on every read (vs. a one-shot table migration):
 *   * `vps_ssh_keys` rows persisted before the OpenSSH-format export
 *     switch are unencrypted PKCS#8 ed25519 PEMs, which `node:crypto`
 *     and `ssh -i` can both parse — but `ssh2` 1.17 (the library
 *     backing `sshExec`) cannot, returning
 *     `Cannot parse privateKey: Unsupported key format`.
 *   * Any production read path that hands `private_key_pem` to
 *     `sshExec` therefore fails on legacy rows. That includes the
 *     lifecycle backup/restore (`data-migration.ts`), change-plan,
 *     and admin re-bootstraps.
 *   * The conversion is idempotent (`convertPkcs8Ed25519PemToOpenssh`
 *     short-circuits when given an already-OpenSSH PEM), so applying
 *     it on every read is safe — fresh rows pay zero cost.
 *   * Re-encoding is identity-preserving (only the wire format
 *     changes; the underlying ed25519 keypair is unchanged), so the
 *     matching public key on the VPS's `~/.ssh/authorized_keys`
 *     continues to authenticate without any VPS-side update.
 */
function migrateRow(row: VpsSshKeyRow | null): VpsSshKeyRow | null {
  if (!row) return null;
  if (typeof row.private_key_pem !== "string" || row.private_key_pem.length === 0) {
    return row;
  }
  try {
    return {
      ...row,
      private_key_pem: convertPkcs8Ed25519PemToOpenssh(row.private_key_pem)
    };
  } catch {
    // Don't fail the entire read on a malformed PEM. A row whose
    // private_key_pem can't be parsed by node:crypto AT ALL is broken
    // beyond what this migration can fix; surface the original row
    // and let the downstream `sshExec` fail with the more-specific
    // "Cannot parse privateKey" error so operators see what's wrong.
    // This branch also lets test fixtures pass placeholder strings
    // ("PEM", "stub-pem") without forcing every test to hand-roll a
    // real ed25519 PEM.
    return row;
  }
}

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
 *
 * The migration enforces at-most-one active row per VPS via a partial unique
 * index (`vps_ssh_keys_one_active_per_vps`). We still use `limit(1)` with
 * `newest-first` ordering as belt-and-suspenders: if the invariant ever gets
 * violated (e.g. by a manual insert that bypassed the index, or during a
 * migration rollback window), callers get the freshest key instead of a
 * PostgREST "multiple rows returned" error that would take the whole
 * orchestrator path offline.
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
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getActiveVpsSshKey: ${error.message}`);
  return migrateRow((data as VpsSshKeyRow | null) ?? null);
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
  return migrateRow((data as VpsSshKeyRow | null) ?? null);
}
