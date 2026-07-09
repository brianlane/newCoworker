/**
 * encrypt-secrets-backfill.ts — one-shot: wrap existing plaintext secrets in
 * the AES-256-GCM app-layer envelope (security review G5).
 *
 * Targets:
 *   - vps_ssh_keys.private_key_pem       (every non-empty plaintext row)
 *   - residency_backup_keys.passphrase   (escrowed rows only; customer_held
 *                                         rows carry NULL by design)
 *
 * Idempotent: rows already carrying the `enc:v1:` envelope are skipped, so
 * re-running after a partial failure only converts the remainder.
 *
 * Usage:
 *   npx tsx debug/encrypt-secrets-backfill.ts            # dry-run (default)
 *   npx tsx debug/encrypt-secrets-backfill.ts --apply    # write
 *   npx tsx debug/encrypt-secrets-backfill.ts --genkey   # print a fresh key and exit
 *
 * Env: SUPABASE creds + SECRETS_ENCRYPTION_KEY (repo-root .env). The same
 * key MUST be set in Vercel before running --apply — otherwise the app
 * reads ciphertext it cannot open and every SSH/deploy path fails closed.
 */
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";
import {
  encryptSecret,
  isEncryptedSecret
} from "../src/lib/crypto/secret-encryption.ts";
import { createSupabaseServiceClient } from "../src/lib/supabase/server.ts";

if (process.argv.includes("--genkey")) {
  console.log(randomBytes(32).toString("base64url"));
  process.exit(0);
}

loadEnv();
const APPLY = process.argv.includes("--apply");

if (!process.env.SECRETS_ENCRYPTION_KEY) {
  console.error(
    "SECRETS_ENCRYPTION_KEY is not set. Generate one with --genkey, add it to .env AND Vercel, then re-run."
  );
  process.exit(1);
}

const db = await createSupabaseServiceClient();
let converted = 0;
let skipped = 0;
let failures = 0;

// ── vps_ssh_keys.private_key_pem ─────────────────────────────────────────
{
  const { data, error } = await db.from("vps_ssh_keys").select("id, private_key_pem");
  if (error) {
    console.error(`vps_ssh_keys read failed: ${error.message}`);
    process.exit(1);
  }
  for (const row of (data ?? []) as Array<{ id: string; private_key_pem: string | null }>) {
    if (!row.private_key_pem || isEncryptedSecret(row.private_key_pem)) {
      skipped += 1;
      continue;
    }
    if (!APPLY) {
      console.log(`[dry-run] vps_ssh_keys ${row.id}: would encrypt private_key_pem`);
      converted += 1;
      continue;
    }
    const { error: writeErr } = await db
      .from("vps_ssh_keys")
      .update({ private_key_pem: encryptSecret(row.private_key_pem) })
      .eq("id", row.id)
      // Guard against racing a concurrent write: only convert the exact
      // plaintext we read.
      .eq("private_key_pem", row.private_key_pem);
    if (writeErr) {
      console.error(`vps_ssh_keys ${row.id}: ${writeErr.message}`);
      failures += 1;
    } else {
      console.log(`vps_ssh_keys ${row.id}: encrypted`);
      converted += 1;
    }
  }
}

// ── residency_backup_keys.passphrase ─────────────────────────────────────
{
  const { data, error } = await db
    .from("residency_backup_keys")
    .select("business_id, passphrase, custody");
  if (error) {
    console.error(`residency_backup_keys read failed: ${error.message}`);
    process.exit(1);
  }
  for (const row of (data ?? []) as Array<{
    business_id: string;
    passphrase: string | null;
    custody: string | null;
  }>) {
    if (!row.passphrase || isEncryptedSecret(row.passphrase)) {
      skipped += 1;
      continue;
    }
    if (!APPLY) {
      console.log(`[dry-run] residency_backup_keys ${row.business_id}: would encrypt passphrase`);
      converted += 1;
      continue;
    }
    const { error: writeErr } = await db
      .from("residency_backup_keys")
      .update({ passphrase: encryptSecret(row.passphrase) })
      .eq("business_id", row.business_id)
      .eq("passphrase", row.passphrase);
    if (writeErr) {
      console.error(`residency_backup_keys ${row.business_id}: ${writeErr.message}`);
      failures += 1;
    } else {
      console.log(`residency_backup_keys ${row.business_id}: encrypted`);
      converted += 1;
    }
  }
}

console.log(
  `\n${APPLY ? "converted" : "would convert"}: ${converted}, already-encrypted/empty: ${skipped}, failures: ${failures}`
);
if (failures > 0) process.exit(1);
