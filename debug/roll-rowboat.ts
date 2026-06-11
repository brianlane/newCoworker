/**
 * Roll a tenant's Rowboat fork to a specific git ref (SHA or branch) and
 * rebuild/recreate the container, with an HTTP health check at the end.
 *
 * This is how a Rowboat-fork code change (e.g. the newcoworker/start-agent
 * branch) reaches a live tenant box — deploy-client.sh only builds Rowboat at
 * first provision, and update-all-vps.ts/deploy-worker.ts only refresh the
 * chat-worker, so without this script a fork fix never lands on existing
 * tenants short of a full re-provision.
 *
 * Usage:
 *   tsx debug/roll-rowboat.ts <ref> [businessId]
 *
 *   <ref>       Commit SHA or branch on the fork's origin (e.g. 7a73f37... or
 *               newcoworker/start-agent). Checked out detached.
 *   businessId  Defaults to 621a5b0d (Amy).
 *
 * ⚠️ Rebuilds and restarts the LIVE Rowboat container (takes a few minutes;
 * in-flight chats on that box will error during the restart window). Prints
 * ROWBOAT_HTTP_OK / ROWBOAT_HTTP_FAIL at the end.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const REF = process.argv[2];
const BUSINESS_ID = process.argv[3] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

if (!REF) {
  console.error("usage: tsx debug/roll-rowboat.ts <sha-or-branch> [businessId]");
  process.exit(1);
}

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: `set -e
cd /opt/rowboat/src
git fetch origin ${REF}
git checkout --detach ${REF} 2>/dev/null || git checkout --detach FETCH_HEAD
git log --oneline -1
cd /opt/rowboat
docker compose -f docker-compose.yml build rowboat 2>&1 | tail -5
docker compose -f docker-compose.yml up -d rowboat 2>&1 | tail -3
sleep 20
docker compose -f docker-compose.yml ps rowboat
curl -sf --max-time 15 http://127.0.0.1:3000/ >/dev/null && echo ROWBOAT_HTTP_OK || echo ROWBOAT_HTTP_FAIL`,
  timeoutMs: 30 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log("exit", res.exitCode);
process.exit(res.exitCode ?? 0);
