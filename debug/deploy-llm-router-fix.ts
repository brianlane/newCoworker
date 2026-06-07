/**
 * Hotfix deploy for the llm-router gzip double-encode bug.
 *
 * Symptom: every Gemini chat turn (OwnerCoworker + the SMS Coworker) 500s with
 * `Z_DATA_ERROR: incorrect header check` in the rowboat logs. Root cause: the
 * llm-router copied Google's `content-encoding: gzip` (and stale content-length)
 * onto a body that undici's fetch had ALREADY decompressed, so Rowboat tried to
 * gunzip plaintext. Fix (vps/llm-router/src/{routing,index}.js): drop
 * content-encoding/content-length from the forwarded headers.
 *
 * This pushes the corrected source from THIS working tree (must match merged
 * main) to the box's two llm-router locations and rebuilds only that one
 * container, then verifies the Gemini path returns clean JSON.
 *
 *   - /opt/rowboat/llm-router        — the compose build context (what runs)
 *   - /opt/newcoworker-repo/vps/...  — the re-stage source (so a later
 *                                      bootstrap/deploy doesn't regress)
 *
 * Idempotent: re-running rewrites identical files and rebuilds the same image.
 *
 * Usage: tsx debug/deploy-llm-router-fix.ts [businessId]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexB64 = readFileSync(join(repoRoot, "vps/llm-router/src/index.js")).toString("base64");
const routingB64 = readFileSync(join(repoRoot, "vps/llm-router/src/routing.js")).toString("base64");

const remote = `
set -uo pipefail
DC="docker compose -f /opt/rowboat/docker-compose.yml"

write_pair () {
  d="\$1"
  [ -d "\$d" ] || { echo "(skip \$d — not present)"; return 0; }
  mkdir -p "\$d/src"
  echo '${indexB64}'   | base64 -d > "\$d/src/index.js"
  echo '${routingB64}' | base64 -d > "\$d/src/routing.js"
  echo "wrote \$d/src/{index,routing}.js"
}

echo "===STAGE SOURCE==="
write_pair /opt/rowboat/llm-router
write_pair /opt/newcoworker-repo/vps/llm-router

echo "===SANITY (fix present?)==="
grep -c 'content-encoding' /opt/rowboat/llm-router/src/routing.js || echo "0"

echo "===REBUILD llm-router==="
\$DC up -d --build --force-recreate llm-router 2>&1 | tail -15

echo "===WAIT FOR HEALTH==="
ok=0
for i in \$(seq 1 20); do
  if \$DC exec -T llm-router wget -qO- http://127.0.0.1:11435/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
echo "health_ok=\$ok"

echo "===VERIFY GEMINI VIA ROUTER (headers must NOT carry content-encoding)==="
\$DC exec -T rowboat sh -lc 'wget -S -O- --header="Content-Type: application/json" --header="Authorization: Bearer router" --post-data="{\\"model\\":\\"gemini-2.5-flash-lite\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}" http://llm-router:11435/v1/chat/completions 2>&1 | grep -iE "HTTP/|content-encoding|content-type|\\"content\\"" | head -10' || echo "(call failed)"

echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== llm-router hotfix deploy ==`);
console.log(`vps=${ip} business=${BUSINESS_ID}`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 6 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[deploy-llm-router-fix] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
