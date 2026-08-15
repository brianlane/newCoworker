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
 * Rotation: {@link rotateVpsSshKey} stamps `rotated_at` on a row so a
 * replacement can be inserted without violating the one-active-row-per-VPS
 * partial unique index. Its only caller today is the VPS-adoption path,
 * which rotates out an existing-but-unusable row (missing public-key id or
 * private key) before minting a fresh keypair. A broader operator-driven
 * rotation workflow remains future work.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { convertPkcs8Ed25519PemToOpenssh } from "@/lib/hostinger/keypair";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-encryption";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VpsSshKeyRow = {
  id: string;
  business_id: string;
  /**
   * Generic provider box id (column name is historical): Hostinger numeric
   * VM id as text, OVH service name, or a `byos-<businessId>` sentinel.
   */
  hostinger_vps_id: string;
  hostinger_public_key_id: number | null;
  public_key: string;
  private_key_pem: string;
  fingerprint_sha256: string;
  ssh_username: string;
  /** Which provider runs the box: 'hostinger' (default) | 'ovh' | 'byos'. */
  provider: string;
  /** Physical region of the box: 'us' (default) | 'ca'. */
  region: string;
  /**
   * Public IP/hostname for byos/ovh boxes (no live provider IP lookup).
   * Null for hostinger rows: their IP is resolved live from the API.
   */
  host: string | null;
  /**
   * `SHA256:…` fingerprint of the box's SSH host key, captured on first
   * connect and verified strictly afterwards (G7 pinning, see
   * src/lib/hostinger/ssh-pinned.ts). Null = not yet captured.
   */
  host_key_fingerprint?: string | null;
  created_at: string;
  rotated_at: string | null;
};

/**
 * Apply the PKCS#8 → OpenSSH-format migration on every key read.
 *
 * Why on every read (vs. a one-shot table migration):
 *   * `vps_ssh_keys` rows persisted before the OpenSSH-format export
 *     switch are unencrypted PKCS#8 ed25519 PEMs, which `node:crypto`
 *     and `ssh -i` can both parse, but `ssh2` 1.17 (the library
 *     backing `sshExec`) cannot, returning
 *     `Cannot parse privateKey: Unsupported key format`.
 *   * Any production read path that hands `private_key_pem` to
 *     `sshExec` therefore fails on legacy rows. That includes the
 *     lifecycle backup/restore (`data-migration.ts`), change-plan,
 *     and admin re-bootstraps.
 *   * The conversion is idempotent (`convertPkcs8Ed25519PemToOpenssh`
 *     short-circuits when given an already-OpenSSH PEM), so applying
 *     it on every read is safe: fresh rows pay zero cost.
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
  // App-layer decryption FIRST (security review G5): rows written after the
  // SECRETS_ENCRYPTION_KEY rollout store AES-256-GCM ciphertext; legacy
  // plaintext rows pass through. Deliberately OUTSIDE the try below: an
  // encrypted row that cannot be decrypted (missing/wrong key) must fail
  // closed with the typed SecretEncryptionError, never fall through to
  // sshExec with ciphertext as a "PEM".
  const plaintextPem = decryptSecret(row.private_key_pem);
  try {
    return {
      ...row,
      private_key_pem: convertPkcs8Ed25519PemToOpenssh(plaintextPem)
    };
  } catch {
    // Don't fail the entire read on a malformed PEM. A row whose
    // private_key_pem can't be parsed by node:crypto AT ALL is broken
    // beyond what this migration can fix; surface the (decrypted) value
    // and let the downstream `sshExec` fail with the more-specific
    // "Cannot parse privateKey" error so operators see what's wrong.
    // This branch also lets test fixtures pass placeholder strings
    // ("PEM", "stub-pem") without forcing every test to hand-roll a
    // real ed25519 PEM.
    return { ...row, private_key_pem: plaintextPem };
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
  /** Defaults to 'hostinger' (the historical fleet). */
  provider?: string;
  /** Defaults to 'us'. */
  region?: string;
  /** Public IP/hostname; only meaningful for byos/ovh rows. */
  host?: string | null;
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
      // At-rest app-layer encryption (G5); plaintext pass-through until
      // SECRETS_ENCRYPTION_KEY is configured.
      private_key_pem: encryptSecret(input.private_key_pem),
      fingerprint_sha256: input.fingerprint_sha256,
      ssh_username: input.ssh_username ?? "root",
      provider: input.provider ?? "hostinger",
      region: input.region ?? "us",
      host: input.host ?? null
    })
    .select()
    .single();

  if (error) throw new Error(`insertVpsSshKey: ${error.message}`);
  // Return the caller-usable row: every read path decrypts via migrateRow,
  // and the orchestrator uses the returned row's PEM directly for SSH.
  return { ...(data as VpsSshKeyRow), private_key_pem: input.private_key_pem };
}

/**
 * Point an existing key row at a new owning business.
 *
 * Used by the VPS-adoption path (fleet economics Phase B): when a pooled VM
 * is adopted for a new tenant, its active `vps_ssh_keys` row (minted for the
 * PREVIOUS tenant or an earlier partial adopt) is reused as-is (the keypair
 * still authenticates), but the row must follow the box to the new business,
 * or every business-scoped lookup (`getActiveVpsSshKeyForBusiness`: backups,
 * restores, admin console) would miss it or hit the old tenant.
 */
export async function reassignVpsSshKeyBusiness(
  id: string,
  businessId: string,
  client?: SupabaseClient
): Promise<VpsSshKeyRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_ssh_keys")
    .update({ business_id: businessId })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`reassignVpsSshKeyBusiness: ${error.message}`);
  return migrateRow(data as VpsSshKeyRow) as VpsSshKeyRow;
}

/**
 * Update the persisted placement (host + region) of a key row. Only
 * meaningful for byos/ovh rows, whose host has no live provider lookup,
 * used by the BYOS re-prepare path when the operator corrects the address
 * or the region. Both fields are written together so the row can never
 * describe a Canadian tenant on a key still labeled 'us' (or vice versa).
 * The host-key pin is CLEARED alongside: a corrected address points at a
 * different machine (different host key), so a stale pin would hard-fail
 * every strict connection to the new box.
 */
export async function updateVpsSshKeyPlacement(
  id: string,
  placement: { host: string; region: string },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_ssh_keys")
    .update({ host: placement.host, region: placement.region, host_key_fingerprint: null })
    .eq("id", id);
  if (error) throw new Error(`updateVpsSshKeyPlacement: ${error.message}`);
}

/**
 * Record (or clear, with null) the box's SSH host-key fingerprint. Set on
 * the first successful connection after a (re)provision; cleared by flows
 * that re-image a box under an existing row (adopt/recreate, BYOS host
 * changes) because re-imaging regenerates host keys.
 */
export async function updateVpsSshKeyHostKeyFingerprint(
  id: string,
  fingerprintSha256: string | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_ssh_keys")
    .update({ host_key_fingerprint: fingerprintSha256 })
    .eq("id", id);
  if (error) throw new Error(`updateVpsSshKeyHostKeyFingerprint: ${error.message}`);
}

/**
 * Retire a key row by stamping `rotated_at`. Required before inserting a
 * replacement row for the same VPS: the `vps_ssh_keys_one_active_per_vps`
 * partial unique index allows only one active (rotated_at IS NULL) row per
 * box, so an insert without this rotation fails outright.
 */
export async function rotateVpsSshKey(id: string, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_ssh_keys")
    .update({ rotated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(`rotateVpsSshKey: ${error.message}`);
}

/**
 * Retire every active key row for a BOX a tenant has moved off, at cutover.
 *
 * {@link rotateVpsSshKey} covers the other rotation case: replacing a row for
 * a box we are keeping. Nothing covered the case where the tenant moves to
 * DIFFERENT hardware, because the one-active-row index is per-VPS, so a new
 * box is a new key, the insert never collides, and the old row stayed
 * `rotated_at IS NULL` forever. `listActiveVpsSshKeys` then kept handing dead
 * boxes to fleet tooling: a chat-worker rollout on 2026-08-14 reported
 * "4/9 succeeded", the five failures all being superseded boxes, and PR #1060
 * deployed a voice-bridge change against a retired box and reported success.
 * {@link newestKeyPerBusiness} exists to paper over the same symptom.
 *
 * Called by every path that moves a tenant to different hardware:
 * `migrate-size` (admin hardware change), `term-renewal-sweep` (the nightly
 * cron), `change-plan-orchestrator` (paid plan change), and the
 * `debug/migrate-vps-size.ts` operator script.
 *
 * Call this at teardown, never earlier: the migration paths back the old box
 * up over SSH first, and that lookup (`getActiveVpsSshKey(oldVmId)`) needs
 * the row still active. Callers treat a failure as non-fatal, since a stale
 * row is bookkeeping noise and must not fail an otherwise-good cutover.
 *
 * Returns the number of rows retired (0 when the box already had none, which
 * is the idempotent re-run case).
 */
export async function retireVpsSshKeysForVps(
  hostingerVpsId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  // `.select()` the write back: a PostgREST update matching zero rows is not
  // an error, so without it a no-op is indistinguishable from a retirement.
  const { data, error } = await db
    .from("vps_ssh_keys")
    .update({ rotated_at: new Date().toISOString() })
    .eq("hostinger_vps_id", hostingerVpsId)
    .is("rotated_at", null)
    .select("id");

  if (error) throw new Error(`retireVpsSshKeysForVps: ${error.message}`);
  return ((data as Array<{ id: string }> | null) ?? []).length;
}

/**
 * Load the currently-active (unrotated) keypair for a VPS. Returns null when
 * no key exists, callers must branch because we never want to return a stale
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

/**
 * Load every currently-active (unrotated) VPS keypair, one per provisioned
 * tenant box. Used by fleet-wide operational tooling (e.g.
 * `debug/update-all-vps.ts`) that needs to SSH to all running VPS instances
 * to roll out a worker update. Ordered newest-first for stable, predictable
 * iteration.
 *
 * Returns an empty array when no VPS has been provisioned. Each row is run
 * through {@link migrateRow} so the `private_key_pem` is in ssh2-loadable
 * OpenSSH format, exactly like the single-row getters above.
 *
 * NOTE: every row carries a PLAINTEXT private key, same trust model as the
 * rest of this module. Service-role only; never expose to a client.
 */
export async function listActiveVpsSshKeys(
  client?: SupabaseClient
): Promise<VpsSshKeyRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_ssh_keys")
    .select("*")
    .is("rotated_at", null)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listActiveVpsSshKeys: ${error.message}`);
  const rows = (data as VpsSshKeyRow[] | null) ?? [];
  // Each row from the query is non-null, so migrateRow never returns null
  // here (it only short-circuits to null on a null input). Cast keeps the
  // array element type without an unreachable null-filter branch.
  return rows.map((row) => migrateRow(row) as VpsSshKeyRow);
}

/**
 * Collapse a list of active key rows to ONE row per business: the newest by
 * `created_at`, which is the same row {@link getActiveVpsSshKeyForBusiness}
 * resolves for that business.
 *
 * Why this exists. `listActiveVpsSshKeys` returns one row per provisioned
 * BOX, and a tenant that has been re-provisioned or migrated used to carry
 * several unrotated rows (nine rows across four tenants when this was
 * written). {@link retireVpsSshKeysForVps} now retires the old row at
 * cutover, so the duplicates should no longer accumulate, but keep this
 * collapse: it is the correct selection rule for a per-tenant rollout
 * regardless, and it stays right for rows predating that fix or left behind
 * by a cutover that failed before teardown. The
 * chat-worker rollout wants every box, so it iterates that list directly. The
 * per-tenant sidecar rollouts (voice-bridge, aiflow-render) instead deploy to
 * the tenant's CURRENT box, so a fleet sweep for them has to pick the same
 * row the single-tenant path would, or it deploys to a retired box and
 * reports success (PR #1060 shipped a voice-bridge change; reading the raw
 * nine rows as "three boxes per tenant" is what made the fleet sweep look
 * ambiguous).
 *
 * Sorts defensively rather than trusting the caller's ordering: the query
 * above already returns newest-first, but a caller passing a filtered or
 * re-ordered array must still get the newest per business. Rows with an
 * unparseable `created_at` sort last, so a real timestamp always wins.
 *
 * Pure: no IO, so the selection rule is unit-testable without a database.
 * Returned in stable business-id order for predictable iteration and logs.
 */
export function newestKeyPerBusiness(rows: readonly VpsSshKeyRow[]): VpsSshKeyRow[] {
  const newest = new Map<string, VpsSshKeyRow>();
  for (const row of rows) {
    const current = newest.get(row.business_id);
    if (!current || createdAtMs(row) > createdAtMs(current)) {
      newest.set(row.business_id, row);
    }
  }
  return [...newest.values()].sort((a, b) => a.business_id.localeCompare(b.business_id));
}

/** `created_at` as epoch ms; -Infinity when unparseable, so it sorts last. */
function createdAtMs(row: VpsSshKeyRow): number {
  const ms = Date.parse(row.created_at);
  return Number.isNaN(ms) ? -Infinity : ms;
}
