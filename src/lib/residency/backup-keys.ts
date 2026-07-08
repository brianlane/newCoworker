/**
 * Escrowed passphrases for per-box encrypted residency datastore dumps
 * (Phase B4).
 *
 * The box encrypts its pg_dump locally (AES-256, openssl) and uploads only
 * ciphertext; the passphrase lives centrally in `residency_backup_keys`
 * (service-role-only, same posture as vps_gateway_tokens) so a dead box is
 * still restorable. Disclosed custody trade: a deal wanting zero central
 * escrow rotates the key out and owns DR themselves.
 */

import { createHash, randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  residencyAllowedForTier,
  RESIDENCY_TIER_MESSAGE,
  ResidencyValidationError
} from "@/lib/residency/tier-gate";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** 256 bits, base64url — safe for env vars and openssl -pass pass:… */
export function generateBackupPassphrase(): string {
  return randomBytes(32).toString("base64url");
}

/** Who holds the AES key: platform escrow (restorable) or the customer. */
export type ResidencyBackupCustody = "escrowed" | "customer_held";

export class CustomerHeldBackupKeyError extends Error {
  constructor(businessId: string) {
    super(
      `residency backup key for business ${businessId} is customer_held — the platform ` +
        "dropped the plaintext (fingerprint only) and cannot decrypt or restore. " +
        "The customer owns DR; flip custody back to 'escrowed' (mints a NEW key) to resume platform-managed backups."
    );
    this.name = "CustomerHeldBackupKeyError";
  }
}

/**
 * Resolve the tenant's escrowed backup passphrase, minting one on first
 * use. Insert-then-read on conflict so concurrent provisions converge on a
 * single key (the loser's insert no-ops and re-reads the winner's row).
 *
 * Throws {@link CustomerHeldBackupKeyError} for customer_held rows so no
 * caller (deploy env building, restore tooling) can silently treat "no
 * platform key by design" as "mint one".
 */
export async function getOrCreateResidencyBackupKey(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("residency_backup_keys")
    .select("passphrase, custody")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getOrCreateResidencyBackupKey(read): ${error.message}`);
  if (data) {
    const row = data as { passphrase: string | null; custody?: string | null };
    if (row.custody === "customer_held" || row.passphrase === null) {
      throw new CustomerHeldBackupKeyError(businessId);
    }
    return row.passphrase;
  }

  const passphrase = generateBackupPassphrase();
  const { error: insertError } = await db
    .from("residency_backup_keys")
    .insert({ business_id: businessId, passphrase });
  if (insertError) {
    // Lost a concurrent-mint race (unique PK): the winner's key is canon.
    const { data: winner, error: rereadError } = await db
      .from("residency_backup_keys")
      .select("passphrase, custody")
      .eq("business_id", businessId)
      .maybeSingle();
    if (rereadError || !winner) {
      throw new Error(
        `getOrCreateResidencyBackupKey(insert): ${insertError.message}; reread: ${rereadError?.message ?? "no row"}`
      );
    }
    // Same custody guard as the primary read: the "winner" of the race may
    // have been a concurrent customer_held flip, whose null passphrase must
    // never be returned as a deployable key.
    const winnerRow = winner as { passphrase: string | null; custody?: string | null };
    if (winnerRow.custody === "customer_held" || winnerRow.passphrase === null) {
      throw new CustomerHeldBackupKeyError(businessId);
    }
    return winnerRow.passphrase;
  }
  return passphrase;
}

/**
 * Passphrase for the DEPLOY env (orchestrator / fleet redeploy). Unlike the
 * throwing getter above, customer_held custody resolves to an EMPTY string:
 * deploy-client.sh treats a blank RESIDENCY_BACKUP_PASSPHRASE as "uninstall
 * the platform backup timer", which is exactly the customer_held contract
 * (the customer owns DR end-to-end).
 */
export async function resolveResidencyBackupPassphraseForDeploy(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  try {
    return await getOrCreateResidencyBackupKey(businessId, client);
  } catch (err) {
    if (err instanceof CustomerHeldBackupKeyError) return "";
    throw err;
  }
}

/**
 * Flip passphrase custody for a deal.
 *
 * → 'customer_held': DROP the plaintext (keep only its SHA-256 fingerprint
 *   for the audit trail). Irreversible for that key — the platform can
 *   never again decrypt dumps made with it. The next deploy uninstalls the
 *   platform backup timer.
 * → 'escrowed': mint a FRESH key (the old one is gone by design); the next
 *   deploy reinstalls backups encrypting with the new key.
 */
export async function setResidencyBackupCustody(
  businessId: string,
  custody: ResidencyBackupCustody,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  return custody === "customer_held"
    ? dropToCustomerHeld(businessId, db)
    : remintEscrowed(businessId, db);
}

/**
 * Enterprise gate for the customer_held flip — same server-side posture as
 * updateResidencyBackupDestination's onbox gate (custody is a residency-
 * program lever). Reverting to escrow stays ungated so a downgraded tenant
 * can never be wedged.
 */
async function assertCustomerHeldAllowed(businessId: string, db: SupabaseClient): Promise<void> {
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`setResidencyBackupCustody(tier): ${error.message}`);
  if (!data) throw new Error(`setResidencyBackupCustody: business ${businessId} not found`);
  if (!residencyAllowedForTier((data as { tier?: string }).tier)) {
    throw new ResidencyValidationError(RESIDENCY_TIER_MESSAGE);
  }
}

async function dropToCustomerHeld(businessId: string, db: SupabaseClient): Promise<void> {
  await assertCustomerHeldAllowed(businessId, db);
  const { data, error } = await db
    .from("residency_backup_keys")
    .select("passphrase")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`setResidencyBackupCustody(read): ${error.message}`);
  const current = (data as { passphrase: string | null } | null)?.passphrase ?? null;
  const fingerprint = current
    ? createHash("sha256").update(current).digest("hex")
    : null;
  const { error: upsertError } = await db.from("residency_backup_keys").upsert({
    business_id: businessId,
    passphrase: null,
    passphrase_sha256: fingerprint,
    custody: "customer_held",
    rotated_at: new Date().toISOString()
  });
  if (upsertError) throw new Error(`setResidencyBackupCustody(write): ${upsertError.message}`);
}

/** Back to escrow: the dropped key is unrecoverable — mint fresh. */
async function remintEscrowed(businessId: string, db: SupabaseClient): Promise<void> {
  const { error: upsertError } = await db.from("residency_backup_keys").upsert({
    business_id: businessId,
    passphrase: generateBackupPassphrase(),
    passphrase_sha256: null,
    custody: "escrowed",
    rotated_at: new Date().toISOString()
  });
  if (upsertError) throw new Error(`setResidencyBackupCustody(write): ${upsertError.message}`);
}
