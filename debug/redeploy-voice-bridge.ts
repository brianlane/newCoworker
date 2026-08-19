/**
 * Voice-bridge-only redeploy of the per-tenant media bridge to the latest
 * `origin/main`.
 *
 * WHY a dedicated script instead of `scripts/redeploy-deploy-client.ts`:
 * the full deploy-client run rewrites the bridge's `.env` from the caller's
 * environment every time (STREAM_URL_SIGNING_SECRET, SUPABASE_*, GOOGLE_API_KEY,
 * BRIDGE_MEDIA_WSS_ORIGIN, see vps/scripts/deploy-client.sh) AND restarts
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
 *   tsx debug/redeploy-voice-bridge.ts --all                 # every tenant, sequential
 *   tsx debug/redeploy-voice-bridge.ts --all --dry-run       # list targets, do nothing
 *   tsx debug/redeploy-voice-bridge.ts --all --force         # redeploy even mid-call
 *
 * `--all` is the fleet sweep. It deploys to each tenant's CURRENT box (the
 * newest unrotated key), because a re-provisioned tenant has several rows in
 * `vps_ssh_keys` and deploying to a retired one would report success while
 * the live box kept the old code. This is the gap that made a voice-bridge
 * change look like it needed a hand-rolled loop (PR #1060): `update-all-vps.ts`
 * ships `vps/chat-worker` only and never touches the bridge.
 *
 * Before each box it checks `voice_active_sessions` for calls in progress and
 * SKIPS that tenant if any are live, because the rebuild force-recreates the
 * container and hangs up on whoever is mid-sentence. `--force` overrides.
 * A row that is unended but has not heartbeated in over two hours is a leaked
 * row, not a call: it is warned about and ignored, so a crashed bridge cannot
 * wedge this check into skipping a tenant forever.
 *
 * Exit code: 0 only when every targeted tenant rebuilt cleanly. A skipped
 * tenant exits 1, since it is still running the old bridge.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DRY_RUN = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all");
const FORCE = process.argv.includes("--force");

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
  echo "ERROR: $DEST/.env missing, this box never provisioned the voice-bridge. Aborting so we don't deploy the bridge without its secrets." >&2
  exit 1
fi
echo "== rsync voice-bridge (preserve .env + node_modules + dist) =="
rsync -a --delete --exclude .env --exclude node_modules --exclude dist "$REPO/vps/voice-bridge/" "$DEST/"
echo "== verify contacts-aware bridge code landed =="
if ! grep -q 'from("contacts")' "$DEST/src/index.ts"; then
  echo "ERROR: bridge source does not read the unified contacts table, wrong/old code synced" >&2
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
# Fail the redeploy (exit 1) if the bridge never serves 200, a swallowed probe
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

const { getActiveVpsSshKeyForBusiness, listActiveVpsSshKeys, newestKeyPerBusiness } =
  await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { VOICE_SESSION_MAX_AGE_MS, partitionVoiceSessions } = await import(
  "../src/lib/telnyx/active-session.ts"
);

type KeyRow = Awaited<ReturnType<typeof getActiveVpsSshKeyForBusiness>>;

// Target selection. `--all` sweeps the fleet; without it the behavior is
// exactly what it always was (one business, default Amy).
//
// listActiveVpsSshKeys returns one row per BOX, and a re-provisioned tenant
// carries several, so the raw list would redeploy retired boxes and report
// success. newestKeyPerBusiness collapses it to the same row the
// single-tenant path resolves. That selection rule is pure and unit-tested in
// tests/vps-ssh-keys.test.ts; this script stays a thin IO wrapper.
let targets: NonNullable<KeyRow>[];
if (ALL) {
  targets = newestKeyPerBusiness(await listActiveVpsSshKeys());
  if (targets.length === 0) {
    console.error("No active VPS SSH keys: nothing to redeploy.");
    process.exit(1);
  }
  console.log(`Targets  : ${targets.length} tenant(s) (--all)\n`);
} else {
  const one = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
  if (!one) {
    console.error(`No active VPS SSH key for business ${BUSINESS_ID}`);
    process.exit(1);
  }
  targets = [one];
}

/**
 * Calls actually in progress on this tenant right now.
 *
 * A bridge redeploy runs `docker compose up --force-recreate`, which kills
 * the container and every media stream attached to it: a caller mid-sentence
 * is simply hung up on. `voice_active_sessions` rows are opened when media
 * starts and stamped with `ended_at` when the call finishes, so an unended
 * row is a live call.
 *
 * But "unended" alone is not proof of life. A bridge that is SIGKILLed never
 * runs its close handler, so the row keeps `ended_at = null` forever, and a
 * permanently unended row would block this tenant's redeploys with no error
 * to look at: every run reports a skip, which reads as the safety check
 * working rather than a leak. So we age the rows out through the shared
 * classifier: anything silent past VOICE_SESSION_MAX_AGE_MS (2h, 8x the
 * server-side zombie sweep's window) is reported as leaked and does NOT
 * block. No real call runs two hours.
 *
 * Read-only and best-effort: if the check itself fails we report it and treat
 * the tenant as busy, because "we could not tell" must not be silently
 * downgraded to "safe to drop calls". `--force` overrides.
 */
async function liveCallCount(businessId: string): Promise<number | null> {
  try {
    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("voice_active_sessions")
      .select("call_control_id, ended_at, last_seen_at, media_started_at")
      .eq("business_id", businessId)
      .is("ended_at", null);
    if (error) throw new Error(error.message);
    const { live, stale } = partitionVoiceSessions(data ?? []);
    if (stale.length > 0) {
      console.warn(
        `  [warn] ignoring ${stale.length} leaked voice_active_sessions row(s) with no heartbeat ` +
          `for over ${Math.round(VOICE_SESSION_MAX_AGE_MS / 60_000)} minutes ` +
          `(e.g. ${stale[0].call_control_id}). The 5-minute maintenance sweep should have ` +
          `reaped these: check the voice_maintenance_sweep telemetry event.`
      );
    }
    return live.length;
  } catch (err) {
    console.error(
      `  [warn] could not read voice_active_sessions: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

const client = makeHostingerClient();
const results: Array<{ businessId: string; status: "ok" | "failed" | "skipped"; note?: string }> =
  [];

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Redeploy ONE tenant, converting any throw into a recorded failure.
 *
 * A fleet sweep must not lose the rest of the fleet to one bad box: an
 * unhandled Hostinger lookup error or SSH timeout would abort the loop
 * mid-run, leaving later tenants untouched AND printing no summary, so the
 * operator cannot tell which boxes were reached. Same containment
 * `update-all-vps.ts` applies per box.
 */
async function redeployOne(key: NonNullable<KeyRow>): Promise<(typeof results)[number]> {
  const businessId = key.business_id;

  let ip: string;
  try {
    ip = await resolveVpsIp(client, key);
  } catch (err) {
    console.error(`\n========== ${businessId} (vps ${key.hostinger_vps_id}) ==========`);
    console.error(`[fail] could not resolve the box's IP: ${errText(err)}`);
    return { businessId, status: "failed", note: `ip-resolve-failed: ${errText(err)}` };
  }

  console.log(`\n========== ${businessId} (vps ${key.hostinger_vps_id} @ ${ip}) ==========`);
  console.log(`User     : ${key.ssh_username || "root"}`);

  if (DRY_RUN) {
    console.log("[dry-run] target resolved; not connecting.");
    return { businessId, status: "skipped", note: "dry-run" };
  }

  if (!FORCE) {
    const live = await liveCallCount(businessId);
    if (live === null || live > 0) {
      const why =
        live === null ? "could not check for calls in progress" : `${live} call(s) in progress`;
      console.log(`[skip] ${why}. Re-run for this tenant later, or pass --force.`);
      return { businessId, status: "skipped", note: why };
    }
  }

  try {
    const res = await sshExec({
      host: ip,
      username: key.ssh_username || "root",
      privateKeyPem: key.private_key_pem,
      command: REDEPLOY_BRIDGE_REMOTE,
      timeoutMs: 12 * 60 * 1000,
      onStdout: (c) => process.stdout.write(c),
      onStderr: (c) => process.stderr.write(c)
    });
    console.log(
      `\n[redeploy-voice-bridge] exitCode=${res.exitCode} signal=${res.signal ?? "none"}`
    );
    return res.exitCode === 0
      ? { businessId, status: "ok" }
      : {
          businessId,
          status: "failed",
          note: `exitCode=${res.exitCode} signal=${res.signal ?? "none"}`
        };
  } catch (err) {
    console.error(`\n[fail] ssh failed for ${businessId}: ${errText(err)}`);
    return { businessId, status: "failed", note: `ssh-failed: ${errText(err)}` };
  }
}

// Sequential on purpose: each redeploy streams a full docker build to stdout,
// and interleaving several makes the output unreadable exactly when something
// has gone wrong. The fleet is small enough that wall-clock is not the
// constraint.
for (const key of targets) {
  results.push(await redeployOne(key));
}

if (ALL || results.length > 1) {
  console.log("\n================ SUMMARY ================");
  for (const r of results) {
    const label = r.status === "ok" ? "OK  " : r.status === "failed" ? "FAIL" : "SKIP";
    console.log(`  [${label}] ${r.businessId}${r.note ? `: ${r.note}` : ""}`);
  }
  const okCount = results.filter((r) => r.status === "ok").length;
  console.log(`[redeploy-voice-bridge] ${okCount}/${results.length} redeployed`);
}

// A skip is not a success: a tenant left on old code must not exit 0, or a
// scripted fleet sweep would report "done" with boxes still unpatched.
// Dry-runs are the exception, they intentionally deploy nothing.
const clean = results.every((r) => r.status === "ok" || r.note === "dry-run");
process.exit(clean ? 0 : 1);
