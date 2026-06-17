/**
 * Render-only redeploy of the per-tenant AiFlow render service (headless
 * Chromium) to the latest `origin/main`.
 *
 * WHY a dedicated script instead of `scripts/redeploy-deploy-client.ts`:
 * the full deploy-client run rewrites the render container's `.env` from the
 * caller's environment every time (`AIFLOW_RENDER_TOKEN=${AIFLOW_RENDER_TOKEN:-}`,
 * see vps/scripts/deploy-client.sh) AND restarts voice-bridge + chat-worker.
 * Our local `.env` does NOT carry AIFLOW_RENDER_TOKEN (it's a Supabase Edge /
 * orchestrator secret), so a full redeploy would BLANK the render service's
 * bearer and needlessly bounce live voice/chat. This script instead:
 *   - refreshes /opt/newcoworker-repo to origin/main,
 *   - rsyncs ONLY vps/aiflow-render → /opt/aiflow-render (excluding .env), so the
 *     existing AIFLOW_RENDER_TOKEN / AIFLOW_PLATFORM_URL / AIFLOW_GATEWAY_TOKEN
 *     are preserved untouched,
 *   - verifies the Clever-engine code landed (click_text_while_present), and
 *   - rebuilds ONLY the aiflow-render container.
 *
 * Usage:
 *   tsx debug/redeploy-aiflow-render.ts                       # Amy's business (default)
 *   tsx debug/redeploy-aiflow-render.ts --business-id <uuid>
 *   tsx debug/redeploy-aiflow-render.ts --dry-run             # resolve target only
 *
 * Exit code: 0 on a clean rebuild, 1 otherwise.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DRY_RUN = process.argv.includes("--dry-run");

function parseBusinessId(): string {
  const i = process.argv.indexOf("--business-id");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
}
const BUSINESS_ID = parseBusinessId();

// Render-only remote sequence. `set -euo pipefail` so a failed fetch/rsync/build
// aborts instead of falsely reporting success. The `.env` exclusion is what
// preserves the render bearer the worker authenticates with.
const REDEPLOY_RENDER_REMOTE = `
set -euo pipefail
REPO=/opt/newcoworker-repo
DEST=/opt/aiflow-render
echo "== refreshing repo =="
git -C "$REPO" fetch --depth=1 origin main && git -C "$REPO" reset --hard FETCH_HEAD
git -C "$REPO" log --oneline -1
if [ ! -d "$REPO/vps/aiflow-render" ]; then
  echo "ERROR: $REPO/vps/aiflow-render missing in repo" >&2
  exit 1
fi
if [ ! -f "$DEST/.env" ]; then
  echo "ERROR: $DEST/.env missing — this box never ran deploy-client.sh for render (starter tier?). Aborting so we don't deploy render without its token." >&2
  exit 1
fi
echo "== rsync aiflow-render (preserve .env + node_modules) =="
rsync -a --delete --exclude .env --exclude node_modules "$REPO/vps/aiflow-render/" "$DEST/"
echo "== verify Clever-engine code landed =="
if ! grep -q click_text_while_present "$DEST/server.mjs"; then
  echo "ERROR: click_text_while_present not found in synced server.mjs" >&2
  exit 1
fi
echo "click_text_while_present present"
echo "== confirm render token preserved (redacted) =="
grep -E '^AIFLOW_RENDER_TOKEN=' "$DEST/.env" | sed 's/=.*/=<set>/' || echo "WARN: AIFLOW_RENDER_TOKEN not set in $DEST/.env"
echo "== rebuild aiflow-render container only =="
cd "$DEST" && docker compose up -d --build --force-recreate
sleep 4
echo "== render logs (tail) =="
docker logs aiflow-render --tail 25 2>&1 | tail -25
echo "== render health =="
curl -fsS -m 5 http://127.0.0.1:8080/health || echo "(health check not ready yet)"
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) {
  console.error(`No active VPS SSH key for business ${BUSINESS_ID}`);
  process.exit(1);
}

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`Business : ${BUSINESS_ID}`);
console.log(`VPS      : ${key.hostinger_vps_id} @ ${ip}`);
console.log(`User     : ${key.ssh_username || "root"}`);

if (DRY_RUN) {
  console.log("\n[dry-run] target resolved; not connecting.");
  process.exit(0);
}

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: REDEPLOY_RENDER_REMOTE,
  timeoutMs: 12 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});

console.log(`\n[redeploy-aiflow-render] exitCode=${res.exitCode} signal=${res.signal ?? "none"}`);
process.exit(res.exitCode === 0 ? 0 : 1);
