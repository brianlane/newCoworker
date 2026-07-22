/**
 * Render-only redeploy of the per-tenant AiFlow render service (headless
 * Chromium) to the latest `origin/main`.
 *
 * WHY a dedicated script instead of `scripts/redeploy-deploy-client.ts`:
 * the full deploy-client run rewrites the render container's `.env` from the
 * caller's environment every time (`AIFLOW_RENDER_TOKEN=${AIFLOW_RENDER_TOKEN:-}`,
 * see vps/scripts/deploy-client.sh) AND restarts voice-bridge + chat-worker.
 * Before 2026-07-21 the local `.env` did NOT carry AIFLOW_RENDER_TOKEN, so
 * every full redeploy from a laptop BLANKED the render service's bearer —
 * which is exactly how the whole fleet ended up answering /render (and /pdf)
 * unauthenticated. The token now lives in the local `.env` (synced from the
 * Vercel app env, same value as the Supabase Edge secret), so full redeploys
 * write it correctly again; this script remains the light-touch path:
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
 * `--seed-token`: additionally REPLACE the AIFLOW_RENDER_TOKEN line in the
 * box's EXISTING /opt/aiflow-render/.env with the caller's env value before
 * the rebuild — the remediation for boxes whose bearer was blanked by a
 * pre-2026-07-21 full redeploy (empty token = the sidecar's auth middleware
 * never enforces). Requires AIFLOW_RENDER_TOKEN in the caller env; the value
 * is single-quoted into the remote script and only ever echoed as a length.
 *   tsx debug/redeploy-aiflow-render.ts --business-id <uuid> --seed-token
 *
 * Starter-tier override (EXPERIMENT): deploy-client.sh never writes
 * /opt/aiflow-render/.env on TIER=starter boxes (render is policy-gated off
 * KVM2), so the missing-.env guard below aborts. `--init-env` bypasses the
 * gate by seeding a minimal .env from the caller's environment
 * (AIFLOW_RENDER_TOKEN required; APP_BASE_URL / ROWBOAT_GATEWAY_TOKEN
 * optional) — mirroring the exact block deploy-client.sh writes on standard
 * boxes. Only for capability experiments (e.g. the KVM2 render-contention
 * test); production starter boxes stay render-free by policy.
 *   AIFLOW_RENDER_TOKEN=<token> tsx debug/redeploy-aiflow-render.ts --business-id <cloneId> --init-env
 *
 * Exit code: 0 on a clean rebuild, 1 otherwise.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DRY_RUN = process.argv.includes("--dry-run");
const INIT_ENV = process.argv.includes("--init-env");
const SEED_TOKEN = process.argv.includes("--seed-token");

function parseBusinessId(): string {
  const i = process.argv.indexOf("--business-id");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
}
const BUSINESS_ID = parseBusinessId();

/** shlex-style single-quote so env values can't break out of the heredoc. */
function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Optional starter-tier bootstrap: seed the .env deploy-client.sh would have
// written on a render-capable tier (see the AIRENV_EOF block in
// vps/scripts/deploy-client.sh). Values are single-quoted at build time so
// the remote shell never interpolates them.
function buildInitEnvBlock(): string {
  const renderToken = process.env.AIFLOW_RENDER_TOKEN ?? "";
  if (!renderToken) {
    console.error(
      "--init-env requires AIFLOW_RENDER_TOKEN in the environment (the render bearer the worker authenticates with)"
    );
    process.exit(1);
  }
  const platformUrl = process.env.APP_BASE_URL ?? "";
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  return `
if [ ! -f "$DEST/.env" ]; then
  echo "== --init-env: seeding $DEST/.env (starter-tier experiment override) =="
  mkdir -p "$DEST"
  printf 'PORT=8080\\nAIFLOW_RENDER_TOKEN=%s\\nAIFLOW_PLATFORM_URL=%s\\nAIFLOW_GATEWAY_TOKEN=%s\\n' \\
    ${bashSingleQuote(renderToken)} ${bashSingleQuote(platformUrl)} ${bashSingleQuote(gatewayToken)} > "$DEST/.env"
  chmod 600 "$DEST/.env"
fi
`;
}

// --seed-token: replace the AIFLOW_RENDER_TOKEN line in the EXISTING .env
// (other lines untouched) so a bearer blanked by an old full redeploy is
// restored and the sidecar's auth middleware starts enforcing. Single-quoted
// at build time; the remote never echoes the value (length only).
function buildSeedTokenBlock(): string {
  const renderToken = process.env.AIFLOW_RENDER_TOKEN ?? "";
  if (!renderToken) {
    console.error(
      "--seed-token requires AIFLOW_RENDER_TOKEN in the environment (the render bearer the worker authenticates with)"
    );
    process.exit(1);
  }
  return `
if [ -f "$DEST/.env" ]; then
  echo "== --seed-token: replacing AIFLOW_RENDER_TOKEN in $DEST/.env (redacted) =="
  grep -v '^AIFLOW_RENDER_TOKEN=' "$DEST/.env" > "$DEST/.env.tmp" || true
  printf 'AIFLOW_RENDER_TOKEN=%s\\n' ${bashSingleQuote(renderToken)} >> "$DEST/.env.tmp"
  chmod 600 "$DEST/.env.tmp"
  mv "$DEST/.env.tmp" "$DEST/.env"
fi
`;
}

// Render-only remote sequence. `set -euo pipefail` so a failed fetch/rsync/build
// aborts instead of falsely reporting success. The `.env` exclusion is what
// preserves the render bearer the worker authenticates with.
//
// Built lazily (not at module load) so `--init-env`/`--seed-token`'s
// AIFLOW_RENDER_TOKEN requirement doesn't abort a `--dry-run`, which never
// SSHes or seeds anything.
const buildRemoteCommand = (): string => `
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
${INIT_ENV ? buildInitEnvBlock() : ""}
if [ ! -f "$DEST/.env" ]; then
  echo "ERROR: $DEST/.env missing — this box never ran deploy-client.sh for render (starter tier?). Re-run with --init-env to seed it for a capability experiment, or use a render-capable tier." >&2
  exit 1
fi
${SEED_TOKEN ? buildSeedTokenBlock() : ""}
echo "== rsync aiflow-render (preserve .env + node_modules) =="
rsync -a --delete --exclude .env --exclude node_modules "$REPO/vps/aiflow-render/" "$DEST/"
echo "== verify Clever-engine code landed =="
if ! grep -q click_text_while_present "$DEST/server.mjs"; then
  echo "ERROR: click_text_while_present not found in synced server.mjs" >&2
  exit 1
fi
echo "click_text_while_present present"
echo "== confirm render token (redacted; len=0 means the auth gate is OFF) =="
awk -F= '/^AIFLOW_RENDER_TOKEN=/{print "AIFLOW_RENDER_TOKEN len=" length($2)}' "$DEST/.env" || true
echo "== rebuild aiflow-render container only =="
cd "$DEST" && docker compose up -d --build --force-recreate
sleep 4
echo "== render logs (tail) =="
docker logs aiflow-render --tail 25 2>&1 | tail -25
echo "== render health =="
curl -fsS -m 5 http://127.0.0.1:8080/health || echo "(health check not ready yet)"
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExecPinned } = await import("../src/lib/hostinger/ssh-pinned.ts");

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

// Pinned SSH (debug/README security rules): strict host-key verification
// against the key row's stored fingerprint; first connect captures it.
const res = await sshExecPinned(key, {
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: buildRemoteCommand(),
  timeoutMs: 12 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});

console.log(`\n[redeploy-aiflow-render] exitCode=${res.exitCode} signal=${res.signal ?? "none"}`);
process.exit(res.exitCode === 0 ? 0 : 1);
