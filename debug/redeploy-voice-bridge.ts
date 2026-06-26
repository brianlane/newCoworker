/**
 * Voice-bridge-only redeploy of the per-tenant media bridge to the latest
 * `origin/main`.
 *
 * WHY a dedicated script instead of `scripts/redeploy-deploy-client.ts`:
 * the full deploy-client run rewrites the bridge's `.env` from the caller's
 * environment every time (STREAM_URL_SIGNING_SECRET, SUPABASE_*, GOOGLE_API_KEY,
 * BRIDGE_MEDIA_WSS_ORIGIN — see vps/scripts/deploy-client.sh) AND restarts
 * Rowboat + chat-worker + aiflow-render. Our local `.env` does not carry every
 * per-tenant bridge secret, so a full redeploy could blank them and needlessly
 * bounce the whole stack. This script instead:
 *   - refreshes /opt/newcoworker-repo to origin/main,
 *   - rsyncs ONLY vps/voice-bridge → /opt/voice-bridge (excluding .env), so the
 *     existing STREAM_URL_SIGNING_SECRET / SUPABASE_* / etc. are preserved,
 *   - verifies the contacts-aware bridge code landed (reads the unified
 *     `contacts` table, not the retired `customer_memories`), and
 *   - rebuilds ONLY the voice-bridge container, then health-checks :8090.
 *
 * This is the redeploy that retires the `customer_memories` compatibility view's
 * job for the bridge: once it runs, the live bridge reads/writes `contacts`
 * directly (post contacts_unify merge).
 *
 * Usage:
 *   tsx debug/redeploy-voice-bridge.ts                       # Amy's business (default)
 *   tsx debug/redeploy-voice-bridge.ts --business-id <uuid>
 *   tsx debug/redeploy-voice-bridge.ts --dry-run             # resolve target only
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

// Bridge-only remote sequence. `set -euo pipefail` so a failed fetch/rsync/build
// aborts instead of falsely reporting success. The `.env` exclusion is what
// preserves the per-tenant bridge secrets the orchestrator wrote on provision.
const REDEPLOY_BRIDGE_REMOTE = `
set -euo pipefail
REPO=/opt/newcoworker-repo
DEST=/opt/voice-bridge
echo "== refreshing repo =="
git -C "$REPO" fetch --depth=1 origin main && git -C "$REPO" reset --hard FETCH_HEAD
git -C "$REPO" log --oneline -1
if [ ! -d "$REPO/vps/voice-bridge" ]; then
  echo "ERROR: $REPO/vps/voice-bridge missing in repo" >&2
  exit 1
fi
if [ ! -f "$DEST/.env" ]; then
  echo "ERROR: $DEST/.env missing — this box never provisioned the voice-bridge. Aborting so we don't deploy the bridge without its secrets." >&2
  exit 1
fi
echo "== rsync voice-bridge (preserve .env + node_modules + dist) =="
rsync -a --delete --exclude .env --exclude node_modules --exclude dist "$REPO/vps/voice-bridge/" "$DEST/"
echo "== verify contacts-aware bridge code landed =="
if ! grep -q 'from("contacts")' "$DEST/src/index.ts"; then
  echo "ERROR: bridge source does not read the unified contacts table — wrong/old code synced" >&2
  exit 1
fi
echo "contacts-aware bridge code present"
echo "== confirm bridge secrets preserved (redacted) =="
grep -E '^STREAM_URL_SIGNING_SECRET=' "$DEST/.env" | sed 's/=.*/=<set>/' || echo "WARN: STREAM_URL_SIGNING_SECRET not set in $DEST/.env"
echo "== rebuild voice-bridge container only =="
cd "$DEST" && docker compose up -d --build --force-recreate
sleep 5
echo "== voice-bridge logs (tail) =="
docker compose logs --no-color --tail 25 voice-bridge 2>&1 | tail -25
echo "== voice-bridge health =="
# Fail the redeploy (exit 1) if the bridge never serves 200 — a swallowed probe
# would contradict the "exit 0 on a clean rebuild, 1 otherwise" contract and let
# a dead bridge look deployed. Retry across the container's start_period (~15s in
# docker-compose.yml) so a slow warmup isn't a false negative.
healthy=0
for attempt in 1 2 3 4 5 6; do
  if curl -fsS -m 5 http://127.0.0.1:8090/ >/dev/null; then
    echo "health=ok (attempt $attempt)"
    healthy=1
    break
  fi
  echo "health not ready (attempt $attempt/6), retrying in 5s..."
  sleep 5
done
if [ "$healthy" -ne 1 ]; then
  echo "ERROR: voice-bridge never returned 200 on :8090 after rebuild" >&2
  exit 1
fi
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
  command: REDEPLOY_BRIDGE_REMOTE,
  timeoutMs: 12 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});

console.log(`\n[redeploy-voice-bridge] exitCode=${res.exitCode} signal=${res.signal ?? "none"}`);
process.exit(res.exitCode === 0 ? 0 : 1);
