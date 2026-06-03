/**
 * Roll the latest `origin/main` chat-worker out to EVERY active VPS instance.
 *
 * Iterates all unrotated rows in `vps_ssh_keys` (one per provisioned tenant),
 * resolves each box's IP via the Hostinger API, and runs the same idempotent
 * worker-update sequence used by debug/deploy-worker.ts. Sequential by
 * default (gentle on the Hostinger API and easy to read in logs); pass
 * --concurrency=N to fan out.
 *
 * Usage:
 *   tsx debug/update-all-vps.ts                 # update all, sequential
 *   tsx debug/update-all-vps.ts --concurrency=3 # update all, 3 at a time
 *   tsx debug/update-all-vps.ts --dry-run       # list targets, do nothing
 *
 * Exit code: 0 only when every VPS updated cleanly; 1 if any failed (the
 * per-VPS failures are summarized at the end so one bad box doesn't hide the
 * rest).
 */
import { loadEnv, makeHostingerClient, resolveVpsIp, UPDATE_WORKER_REMOTE } from "./_shared.ts";

loadEnv();

function parseConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  if (!arg) return 1;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
const CONCURRENCY = parseConcurrency();
const DRY_RUN = process.argv.includes("--dry-run");

const { listActiveVpsSshKeys } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const keys = await listActiveVpsSshKeys();
console.log(`[update-all] found ${keys.length} active VPS instance(s)`);
if (keys.length === 0) process.exit(0);

const client = makeHostingerClient();

type Outcome = { businessId: string; vpsId: string; ip?: string; ok: boolean; detail: string };

async function updateOne(key: (typeof keys)[number]): Promise<Outcome> {
  const base = { businessId: key.business_id, vpsId: key.hostinger_vps_id };
  let ip: string;
  try {
    ip = await resolveVpsIp(client, key);
  } catch (err) {
    return { ...base, ok: false, detail: `ip-resolve-failed: ${(err as Error).message}` };
  }

  console.log(`\n========== ${key.business_id} (vps ${key.hostinger_vps_id} @ ${ip}) ==========`);
  if (DRY_RUN) {
    console.log("[update-all] dry-run — skipping SSH");
    return { ...base, ip, ok: true, detail: "dry-run" };
  }

  try {
    const res = await sshExec({
      host: ip,
      username: key.ssh_username || "root",
      privateKeyPem: key.private_key_pem,
      command: UPDATE_WORKER_REMOTE,
      timeoutMs: 12 * 60 * 1000,
      // Prefix each box's output so interleaved (concurrent) logs stay readable.
      onStdout: (c) => process.stdout.write(prefix(key.business_id, c)),
      onStderr: (c) => process.stderr.write(prefix(key.business_id, c))
    });
    const ok = res.exitCode === 0;
    return { ...base, ip, ok, detail: ok ? "ok" : `exitCode=${res.exitCode} signal=${res.signal ?? "none"}` };
  } catch (err) {
    return { ...base, ip, ok: false, detail: `ssh-failed: ${(err as Error).message}` };
  }
}

function prefix(businessId: string, chunk: string): string {
  const tag = `[${businessId.slice(0, 8)}] `;
  return chunk.replace(/\n(?!$)/g, `\n${tag}`);
}

// Simple fixed-size worker pool: pull from a shared index so at most
// CONCURRENCY updates run at once.
const results: Outcome[] = [];
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= keys.length) return;
    results[i] = await updateOne(keys[i]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()));

console.log("\n================ SUMMARY ================");
let failed = 0;
for (const r of results) {
  const status = r.ok ? "OK  " : "FAIL";
  if (!r.ok) failed++;
  console.log(`  [${status}] ${r.businessId} (vps ${r.vpsId}${r.ip ? ` @ ${r.ip}` : ""}) — ${r.detail}`);
}
console.log(`[update-all] ${results.length - failed}/${results.length} succeeded`);
process.exit(failed === 0 ? 0 : 1);
