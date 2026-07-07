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

import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** 256 bits, base64url — safe for env vars and openssl -pass pass:… */
export function generateBackupPassphrase(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Resolve the tenant's escrowed backup passphrase, minting one on first
 * use. Insert-then-read on conflict so concurrent provisions converge on a
 * single key (the loser's insert no-ops and re-reads the winner's row).
 */
export async function getOrCreateResidencyBackupKey(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("residency_backup_keys")
    .select("passphrase")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getOrCreateResidencyBackupKey(read): ${error.message}`);
  if (data) return (data as { passphrase: string }).passphrase;

  const passphrase = generateBackupPassphrase();
  const { error: insertError } = await db
    .from("residency_backup_keys")
    .insert({ business_id: businessId, passphrase });
  if (insertError) {
    // Lost a concurrent-mint race (unique PK): the winner's key is canon.
    const { data: winner, error: rereadError } = await db
      .from("residency_backup_keys")
      .select("passphrase")
      .eq("business_id", businessId)
      .maybeSingle();
    if (rereadError || !winner) {
      throw new Error(
        `getOrCreateResidencyBackupKey(insert): ${insertError.message}; reread: ${rereadError?.message ?? "no row"}`
      );
    }
    return (winner as { passphrase: string }).passphrase;
  }
  return passphrase;
}
