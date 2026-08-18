/**
 * Shared helpers for the one-shot operational/debug scripts in this folder.
 *
 * These scripts run locally via `tsx` against the LIVE fleet — they read the
 * repo's `.env` for Supabase + Hostinger credentials, look up each tenant's
 * VPS SSH key, resolve its public IP, and run remote commands over SSH. They
 * are intentionally NOT part of the app bundle and NOT covered by the test
 * suite (coverage is scoped to `src/lib/**`). See debug/README.md.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VpsSshKeyRow } from "../src/lib/db/vps-ssh-keys.ts";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "../src/lib/hostinger/client.ts";

/**
 * Locate the repo-root `.env`.
 *
 * The obvious answer, `cwd/.env`, is wrong inside a git worktree, and the
 * repo's own workflow requires worktrees: `.env` is gitignored, so it exists
 * only in the main checkout. A script run from a worktree would silently see
 * no credentials and report "not configured" or an empty result. Fall back to
 * the main checkout, which is the parent of the shared git common dir.
 */
function resolveEnvPath(): string | null {
  const candidates = [process.cwd()];
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (commonDir) candidates.push(path.dirname(commonDir));
  } catch {
    // Not a git checkout, or no git on PATH: cwd is the only candidate.
  }
  return candidates.map((dir) => path.resolve(dir, ".env")).find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Load the repo-root `.env` into process.env WITHOUT clobbering anything
 * already present in the real environment (so `FOO=bar tsx debug/x.ts` still
 * wins). The src/lib helpers read process.env lazily at call time, so this
 * must run before importing/calling them.
 */
export function loadEnv(): void {
  const envPath = resolveEnvPath();
  if (!envPath) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k] === undefined) {
      process.env[k] = vRaw.replace(/^["']|["']$/g, "");
    }
  }
}

/**
 * The Postgres URL for a script that needs a SESSION connection, with the
 * `sslmode=` stripped.
 *
 * Two traps this closes, both found on 2026-08-06:
 *
 * 1. The transaction pooler silently drops session settings. Callers connect
 *    with `options: "-c default_transaction_read_only=on"`, which is the only
 *    thing standing between a debug script and a write against production.
 *    Supavisor in transaction mode (port 6543, `pgbouncer=true`) does not
 *    carry that startup parameter, so the connection SUCCEEDS with the guard
 *    quietly missing. `DIRECT_DATABASE_URL` is the session pooler (5432) and
 *    is correct; `DATABASE_URL` is the transaction pooler and is not, yet it
 *    was the fallback both readers used. Refuse it by name instead.
 *
 * 2. The region drifts. Several local `.env` entries pointed at
 *    `aws-1-us-east-1` while this project lives in `us-east-2`. That one is
 *    self-announcing (the pooler answers "Tenant or user not found"), so it
 *    needs no guard here, but it is why the fallback above was reachable at
 *    all: whoever fixes a broken DIRECT_DATABASE_URL by deleting it lands
 *    straight on the unsafe one.
 *
 * `sslmode=` is stripped because pg treats it as verify-full and rejects
 * Supabase's self-signed chain, so callers pass an explicit `ssl` option and
 * need it to win.
 */
export function sessionDbUrl(): string {
  const direct = process.env.DIRECT_DATABASE_URL ?? "";
  const raw = direct || process.env.DATABASE_URL || "";
  if (!raw) {
    throw new Error(
      "DIRECT_DATABASE_URL not set (run from a checkout that resolves .env). " +
        "It is the SESSION pooler on port 5432, e.g. " +
        "postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres"
    );
  }
  if (!direct) {
    // Only reachable when DIRECT_DATABASE_URL is missing and DATABASE_URL is
    // standing in. Allowed only when it is genuinely a session connection.
    const isTransactionPooler = /:6543\b/.test(raw) || /[?&]pgbouncer=true\b/.test(raw);
    if (isTransactionPooler) {
      throw new Error(
        "DIRECT_DATABASE_URL is not set and DATABASE_URL is the TRANSACTION pooler " +
          "(port 6543 / pgbouncer=true), which silently ignores the read-only session " +
          "guard this script relies on. Set DIRECT_DATABASE_URL to the session pooler " +
          "on port 5432 (aws-1-us-east-2 for this project)."
      );
    }
  }
  return raw.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
}

/** A Hostinger API client built from the env (HOSTINGER_API_TOKEN, optional base URL). */
export function makeHostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}

/**
 * Resolve a VPS's current public IPv4 from its SSH-key row via the Hostinger
 * API. Throws if the VM has no IPv4 (still provisioning / destroyed).
 */
export async function resolveVpsIp(
  client: HostingerClient,
  key: Pick<VpsSshKeyRow, "hostinger_vps_id">
): Promise<string> {
  const vm = await client.getVirtualMachine(Number(key.hostinger_vps_id));
  const ip = vm.ipv4?.[0]?.address;
  if (!ip) throw new Error(`no IPv4 for vps ${key.hostinger_vps_id}`);
  return ip;
}

/**
 * The remote shell snippet that brings a VPS's chat-worker up to the latest
 * `origin/main`: refresh the repo, rsync the worker source into /opt, confirm
 * the docker-compose extra_hosts wiring, reconcile the managed capture-env
 * vars, and rebuild/recreate the container. Idempotent and safe to re-run.
 * Shared by deploy-worker.ts and update-all-vps.ts so a single source of truth
 * defines "update a worker".
 *
 * Why the env reconcile (the `== reconcile capture env ==` block below): the
 * rsync above excludes `.env`, so a code-only roll-out NEVER refreshes the
 * worker's environment. When the capture upstream moved to a direct Google
 * call, existing boxes' `/opt/chat-worker/.env` still lacked GOOGLE_API_KEY
 * (and carried a now-dead MEMORY_CAPTURE_ROUTER_URL), so capture silently
 * no-op'd until each box was hand-patched. This block re-derives the managed
 * capture vars from the authoritative per-tenant secrets in
 * `/opt/rowboat/.env` (where deploy-client.sh writes GOOGLE_API_KEY +
 * OLLAMA_MODEL), mirroring the same keyless-fallback policy deploy-client.sh
 * applies, so a routine `update-all-vps` brings every box's capture env into
 * the desired state with no manual SSH. It only ever touches the managed keys
 * (GOOGLE_API_KEY, MEMORY_CAPTURE_*, OLLAMA_BASE_URL) and removes the dead
 * router var — every other line in `.env` is left untouched.
 *
 * It also reinstalls `/opt/newcoworker/scripts/heartbeat.sh` from the
 * refreshed repo. That install used to live only in deploy-client.sh, which
 * made a heartbeat or posture-check change require a FULL per-box redeploy to
 * reach the fleet while this script pulled the new source and then ignored
 * it. The README points at `update-all-vps` for `vps/` changes, so it needs
 * to be true for the one `vps/` file that is not a container.
 *
 * `set -euo pipefail` — `-e` is critical: without it a failed `git fetch`,
 * `rsync`, or `docker compose up` would NOT stop the script, the final
 * `docker logs … | tail` would exit 0, and sshExec (plus the fleet rollout
 * summary in update-all-vps.ts) would falsely report success while the worker
 * was never refreshed. The `grep` probes are deliberately non-fatal and are
 * explicitly guarded (`|| …`, `2>/dev/null`, or `if` blocks) so errexit
 * doesn't trip on an expected "no match".
 */
export const UPDATE_WORKER_REMOTE = `
set -euo pipefail
REPO=/opt/newcoworker-repo
echo "== refreshing repo =="
git -C "$REPO" fetch --depth=1 origin main && git -C "$REPO" reset --hard FETCH_HEAD
git -C "$REPO" log --oneline -1
echo "== rsync chat-worker =="
rsync -a --delete --exclude .env --exclude node_modules "$REPO/vps/chat-worker/" /opt/chat-worker/
echo "== docker-compose extra_hosts check =="
grep -n "host.docker.internal" /opt/chat-worker/docker-compose.yml || echo "NO extra_hosts!"

# Refresh the cron-driven heartbeat too. Only deploy-client.sh installed it,
# so a heartbeat/posture change needed a FULL redeploy per box (rewriting
# .env, recreating containers, rotating the gateway token) to reach the
# fleet, while this script quietly left the old copy in place after
# refreshing the repo it comes from. Same install as deploy-client.sh, and
# idempotent.
echo "== install heartbeat.sh =="
mkdir -p /opt/newcoworker/scripts
if [ -f "$REPO/vps/scripts/heartbeat.sh" ]; then
  install -m 0755 "$REPO/vps/scripts/heartbeat.sh" /opt/newcoworker/scripts/heartbeat.sh
  echo "heartbeat.sh installed/updated"
else
  echo "WARN: $REPO/vps/scripts/heartbeat.sh missing; heartbeat not refreshed"
fi

echo "== reconcile capture env =="
RB_ENV=/opt/rowboat/.env
CW_ENV=/opt/chat-worker/.env
if [ ! -f "$CW_ENV" ]; then
  echo "WARN: $CW_ENV missing, skipping env reconcile (deploy-client.sh has not run on this box)"
else
  # Authoritative per-tenant secrets/config live in /opt/rowboat/.env.
  GK=$(grep -m1 '^GOOGLE_API_KEY=' "$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  OLM=$(grep -m1 '^OLLAMA_MODEL=' "$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  OLM=\${OLM:-qwen3:4b-instruct}
  # upsert KEY VALUE, replace any existing line(s), then append exactly one.
  upsert() { local k="$1"; shift; sed -i "/^\${k}=/d" "$CW_ENV"; printf '%s=%s\\n' "$k" "$*" >> "$CW_ENV"; }
  # Dead since the worker calls Google directly (POST to the co-located router
  # black-holes on the cross-network worker container).
  sed -i '/^MEMORY_CAPTURE_ROUTER_URL=/d' "$CW_ENV"
  # Resolve the capture model with the SAME keyless fallback deploy-client.sh
  # uses: a gemini-* tag needs a key, so degrade to the local Ollama tag when
  # the box has none (matches the worker's /^gemini[-_.]/i detection).
  MCM=$(grep -m1 '^MEMORY_CAPTURE_MODEL=' "$CW_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  MCM=\${MCM:-gemini-2.5-flash-lite}
  MCM_LC=$(printf '%s' "$MCM" | tr '[:upper:]' '[:lower:]')
  case "$MCM_LC" in
    gemini-*|gemini_*|gemini.*)
      if [ -z "$GK" ]; then
        echo "WARNING: capture model $MCM needs GOOGLE_API_KEY but none in $RB_ENV; falling back to local $OLM"
        MCM="$OLM"
      fi
      ;;
  esac
  upsert MEMORY_CAPTURE_MODEL "$MCM"
  if [ -n "$GK" ]; then upsert GOOGLE_API_KEY "$GK"; else echo "NOTE: no GOOGLE_API_KEY in $RB_ENV (keyless host)"; fi
  # Ensure the remaining managed vars exist; preserve any explicit overrides.
  grep -q '^MEMORY_CAPTURE_ENABLED=' "$CW_ENV" || echo 'MEMORY_CAPTURE_ENABLED=true' >> "$CW_ENV"
  grep -q '^MEMORY_CAPTURE_GEMINI_BASE_URL=' "$CW_ENV" || echo 'MEMORY_CAPTURE_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai' >> "$CW_ENV"
  grep -q '^MEMORY_CAPTURE_TIMEOUT_MS=' "$CW_ENV" || echo 'MEMORY_CAPTURE_TIMEOUT_MS=30000' >> "$CW_ENV"
  grep -q '^OLLAMA_BASE_URL=' "$CW_ENV" || echo 'OLLAMA_BASE_URL=http://host.docker.internal:11434' >> "$CW_ENV"
  chmod 600 "$CW_ENV"
fi

echo "== rebuild chat-worker =="
cd /opt/chat-worker && docker compose up -d --build --force-recreate
echo "== worker env (capture vars; key redacted) =="
grep -E "MEMORY_CAPTURE|OLLAMA_BASE_URL|WORKER_VERCEL_BASE_URL|GOOGLE_API_KEY" /opt/chat-worker/.env | sed 's/^GOOGLE_API_KEY=.*/GOOGLE_API_KEY=<set>/' || echo "(none, relying on code defaults)"
sleep 4
echo "== worker logs (tail) =="
docker logs chat-worker --tail 20 2>&1 | tail -20
`;
