/**
 * One-shot: SSH-tarball /opt/rowboat/{vault,memory} for a business onto
 * Supabase Storage (data_backups + business-backups bucket). Fail-closed —
 * exits non-zero if the backup cannot be verified.
 *
 * Usage:
 *   npx tsx debug/backup-business-data.ts --business <uuid>
 *   npx tsx debug/backup-business-data.ts --business <uuid> --vm <hostingerVmId>
 *
 * When --vm is given, the SSH key is pinned to that VPS id (required when
 * the business has more than one historical key row, or when we are about
 * to re-image this specific box).
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business");
if (!BUSINESS_ID) {
  console.error("usage: backup-business-data.ts --business <uuid> [--vm <hostingerVmId>]");
  process.exit(1);
}
const vmRaw = argValue("--vm");
const VM_ID = vmRaw !== null ? Number(vmRaw) : null;
if (vmRaw !== null && (!Number.isInteger(VM_ID) || VM_ID! <= 0)) {
  console.error("--vm requires a numeric Hostinger virtual machine id");
  process.exit(1);
}

const { makeHostingerClient } = await import("./_shared.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { getActiveVpsSshKey, getActiveVpsSshKeyForBusiness } = await import(
  "../src/lib/db/vps-ssh-keys.ts"
);
const { backupBusinessData } = await import("../src/lib/hostinger/data-migration.ts");
const { getDataBackup, DATA_BACKUP_BUCKET } = await import("../src/lib/db/data-backups.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, hostinger_vps_id")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`business ${BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}

const targetVmId =
  VM_ID !== null
    ? VM_ID
    : biz.hostinger_vps_id && /^\d+$/.test(biz.hostinger_vps_id)
      ? Number.parseInt(biz.hostinger_vps_id, 10)
      : null;
if (targetVmId === null) {
  console.error("no resolvable VM id, pass --vm <id>");
  process.exit(1);
}

const sshKey =
  VM_ID !== null
    ? await getActiveVpsSshKey(String(VM_ID))
    : await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!sshKey?.private_key_pem) {
  console.error(`no active SSH key for vm=${targetVmId} / business=${BUSINESS_ID}`);
  process.exit(1);
}

const vm = await hostinger.getVirtualMachine(targetVmId);
const ip = vm.ipv4?.[0]?.address ?? null;
if (!ip) {
  console.error(`VM ${targetVmId} has no IPv4 (state=${vm.state})`);
  process.exit(1);
}

console.log(`== backupBusinessData ==`);
console.log(`business : ${biz.name} (${biz.id})`);
console.log(`vm       : ${targetVmId} state=${vm.state} ip=${ip}`);
console.log(`key      : ${sshKey.id} (hostinger_vps_id=${sshKey.hostinger_vps_id})`);

const result = await backupBusinessData(
  { businessId: BUSINESS_ID, vpsHost: ip },
  { sshKeyLookup: async () => sshKey }
);

console.log(
  `[backup] ok: ${result.storagePath} (${result.sizeBytes} bytes, sha256=${result.sha256.slice(0, 16)}…)`
);

const row = await getDataBackup(BUSINESS_ID);
if (!row) {
  console.error("[verify] FAIL: data_backups row missing after backup");
  process.exit(1);
}
if (row.size_bytes !== result.sizeBytes || row.sha256 !== result.sha256) {
  console.error("[verify] FAIL: data_backups row does not match backup result", row);
  process.exit(1);
}
if (row.size_bytes < 100) {
  console.error(`[verify] FAIL: backup suspiciously small (${row.size_bytes} bytes)`);
  process.exit(1);
}

const { data: blob, error: dlErr } = await db.storage
  .from(DATA_BACKUP_BUCKET)
  .download(row.storage_path);
if (dlErr || !blob) {
  console.error(`[verify] FAIL: Storage object missing: ${dlErr?.message ?? "null blob"}`);
  process.exit(1);
}
const buf = Buffer.from(await blob.arrayBuffer());
if (buf.byteLength !== row.size_bytes) {
  console.error(
    `[verify] FAIL: Storage size mismatch (row=${row.size_bytes}, object=${buf.byteLength})`
  );
  process.exit(1);
}

console.log(
  `[verify] ok: data_backups + Storage object (${buf.byteLength} bytes, sha=${row.sha256.slice(0, 16)}…)`
);
