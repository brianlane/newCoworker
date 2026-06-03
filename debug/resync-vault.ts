/**
 * Force a vault → VPS re-seed (Supabase `business_configs` → on-VPS vault files
 * + MongoDB agent `instructions`). Use to recover a tenant whose agent prompt
 * has drifted from Supabase (see debug/check-vault-sync.ts), or to backfill the
 * fleet after the post-response-sync fix.
 *
 * Usage:
 *   tsx debug/resync-vault.ts <businessId>   # one tenant
 *   tsx debug/resync-vault.ts --all          # every active VPS tenant
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { syncVaultToVps } = await import("../src/lib/vps/sync-vault.ts");
const { listActiveVpsSshKeys } = await import("../src/lib/db/vps-ssh-keys.ts");

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx debug/resync-vault.ts <businessId> | --all");
  process.exit(2);
}

const businessIds =
  arg === "--all"
    ? (await listActiveVpsSshKeys()).map((k) => k.business_id)
    : [arg];

console.log(`[resync] ${businessIds.length} tenant(s)`);

let failures = 0;
for (const businessId of businessIds) {
  const res = await syncVaultToVps(businessId);
  if (res.ok) {
    console.log(
      `  [OK  ] ${businessId} — ip=${res.publicIp} project=${res.projectId} instructions=${res.instructionsLength} chars`
    );
  } else {
    failures++;
    console.log(`  [FAIL] ${businessId} — ${res.reason}${res.detail ? `: ${res.detail}` : ""}`);
  }
}

console.log(`[resync] ${businessIds.length - failures}/${businessIds.length} succeeded`);
process.exit(failures === 0 ? 0 : 1);
