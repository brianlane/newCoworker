/**
 * Override MEMORY_CAPTURE_TIMEOUT_MS on a tenant VPS's chat-worker and
 * recreate the container. A debugging aid for when extraction is timing out
 * and you want more headroom WITHOUT a full redeploy. Note: the value is
 * written into /opt/chat-worker/.env, which survives redeploys (rsync
 * --exclude .env) but is reset to the code default by deploy-client.sh.
 *
 * Usage:
 *   tsx debug/bump-timeout.ts [businessId] [timeoutMs]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TIMEOUT_MS = process.argv[3] ?? "120000";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

const remote = `
set -uo pipefail
cd /opt/chat-worker
grep -q '^MEMORY_CAPTURE_TIMEOUT_MS=' .env \
  && sed -i 's/^MEMORY_CAPTURE_TIMEOUT_MS=.*/MEMORY_CAPTURE_TIMEOUT_MS=${TIMEOUT_MS}/' .env \
  || echo 'MEMORY_CAPTURE_TIMEOUT_MS=${TIMEOUT_MS}' >> .env
echo "== .env capture vars =="
grep -E 'MEMORY_CAPTURE|OLLAMA_BASE_URL' .env
docker compose up -d --force-recreate
sleep 3
docker logs chat-worker --tail 3 2>&1 | tail -3
`;
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 120_000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
process.exit(res.exitCode === 0 ? 0 : 1);
