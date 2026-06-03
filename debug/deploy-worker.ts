/**
 * Deploy the latest `origin/main` chat-worker to a SINGLE tenant's VPS.
 *
 * Usage:
 *   tsx debug/deploy-worker.ts <businessId>
 *
 * Defaults to business 621a5b0d (the first/only live tenant) when no id is
 * passed. For a fleet-wide rollout use debug/update-all-vps.ts instead.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp, UPDATE_WORKER_REMOTE } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);
console.log(
  `[deploy] business=${BUSINESS_ID} vpsId=${key.hostinger_vps_id} ip=${ip} user=${key.ssh_username}`
);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: UPDATE_WORKER_REMOTE,
  timeoutMs: 12 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[deploy] exitCode=${res.exitCode} signal=${res.signal ?? "none"}`);
process.exit(res.exitCode === 0 ? 0 : 1);
