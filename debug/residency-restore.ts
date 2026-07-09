/**
 * Residency datastore restore (Phase B4 DR tool).
 *
 * Downloads the newest (or a named) encrypted dump from Supabase Storage,
 * decrypts it with the tenant's escrowed passphrase, and applies it to a
 * box's residency Postgres over SSH — the recovery path when a box dies
 * and is re-provisioned. The dump is `pg_dump --clean --if-exists`, so
 * applying onto the freshly-schema'd datastore converges to the backup
 * state.
 *
 * Usage:
 *   npx tsx debug/residency-restore.ts --business <uuid> [--file <name>] [--list] [--apply]
 *
 * Without --apply: downloads + decrypts to /tmp and verifies the SQL is
 * readable (gzip integrity), but does NOT touch the box.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
import { decryptSecret } from "../src/lib/crypto/secret-encryption.ts";

loadEnv();

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}
const businessId = argValue("--business");
const namedFile = argValue("--file");
const listOnly = args.includes("--list");
const apply = args.includes("--apply");

if (!businessId) {
  console.error(
    "usage: npx tsx debug/residency-restore.ts --business <uuid> [--file <name>] [--list] [--apply]"
  );
  process.exit(2);
}

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { DATA_BACKUP_BUCKET } = await import("../src/lib/db/data-backups.ts");
const db = await createSupabaseServiceClient();

const prefix = `residency/${businessId}`;
const { data: objects, error: listError } = await db.storage
  .from(DATA_BACKUP_BUCKET)
  .list(prefix, { sortBy: { column: "name", order: "desc" }, limit: 50 });
if (listError) {
  console.error(`storage list failed: ${listError.message}`);
  process.exit(1);
}
const files = (objects ?? []).map((o) => o.name).filter((n) => n.endsWith(".sql.gz.enc"));
if (files.length === 0) {
  console.error(`no encrypted dumps under ${DATA_BACKUP_BUCKET}/${prefix}`);
  process.exit(1);
}
if (listOnly) {
  for (const f of files) console.log(f);
  process.exit(0);
}

const chosen = namedFile ?? files[0];
console.log(`[restore] using ${chosen}`);

const { data: blob, error: dlError } = await db.storage
  .from(DATA_BACKUP_BUCKET)
  .download(`${prefix}/${chosen}`);
if (dlError || !blob) {
  console.error(`download failed: ${dlError?.message ?? "no data"}`);
  process.exit(1);
}
const encPath = `/tmp/${chosen}`;
fs.writeFileSync(encPath, Buffer.from(await blob.arrayBuffer()));

const { data: keyRow, error: keyError } = await db
  .from("residency_backup_keys")
  .select("passphrase, custody")
  .eq("business_id", businessId)
  .maybeSingle();
if (keyError || !keyRow) {
  console.error(`escrowed passphrase unavailable: ${keyError?.message ?? "no row"}`);
  process.exit(1);
}
const storedPassphrase = (keyRow as { passphrase: string | null; custody?: string | null })
  .passphrase;
if (storedPassphrase === null) {
  console.error(
    "passphrase is customer_held (platform escrow dropped) — the customer owns DR for these dumps"
  );
  process.exit(1);
}
// Post-G5 rows store the passphrase as an enc:v1: envelope; legacy plaintext
// passes through unchanged.
const passphrase = decryptSecret(storedPassphrase);

const sqlGzPath = encPath.replace(/\.enc$/, "");
const dec = spawnSync(
  "openssl",
  ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:RESIDENCY_BACKUP_PASSPHRASE", "-in", encPath, "-out", sqlGzPath],
  { env: { ...process.env, RESIDENCY_BACKUP_PASSPHRASE: passphrase } }
);
if (dec.status !== 0) {
  console.error(`decrypt failed: ${dec.stderr?.toString() ?? dec.status}`);
  process.exit(1);
}
const gzTest = spawnSync("gzip", ["-t", sqlGzPath]);
if (gzTest.status !== 0) {
  console.error("decrypted payload failed gzip integrity check — wrong key or corrupt object");
  process.exit(1);
}
console.log(`[restore] decrypted + verified: ${sqlGzPath}`);

if (!apply) {
  console.log("[restore] dry run complete (no --apply). The box was not touched.");
  process.exit(0);
}

// Apply over SSH: stream the gzip through psql inside the compose network.
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const key = await getActiveVpsSshKeyForBusiness(businessId);
if (!key) {
  console.error("no active SSH key for business");
  process.exit(1);
}
const hostinger = makeHostingerClient();
const ip = await resolveVpsIp(hostinger, key);
console.log(`[restore] applying to ${ip} (residency-postgres)...`);

const keyPath = `/tmp/residency-restore-key-${businessId}`;
fs.writeFileSync(keyPath, key.private_key_pem, { mode: 0o600 });
const ssh = spawnSync(
  "bash",
  [
    "-c",
    `gunzip -c ${JSON.stringify(sqlGzPath)} | ssh -i ${JSON.stringify(keyPath)} -o StrictHostKeyChecking=accept-new ${key.ssh_username}@${ip} "docker compose -f /opt/data-api/docker-compose.yml exec -T residency-postgres psql -U dataapi -d residency -v ON_ERROR_STOP=1"`
  ],
  { stdio: ["ignore", "inherit", "inherit"] }
);
fs.rmSync(keyPath, { force: true });
if (ssh.status !== 0) {
  console.error(`[restore] psql apply FAILED (exit ${ssh.status}) — datastore may be partial; re-run`);
  process.exit(1);
}
console.log("[restore] DONE — datastore restored from encrypted backup");
