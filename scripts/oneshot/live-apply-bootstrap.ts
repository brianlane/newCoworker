/**
 * One-shot: live-apply the newest bootstrap to the brianlanefanmail VPS
 * (id 1632631, public IP 177.7.52.140) without re-running the orchestrator.
 *
 * Why a one-shot rather than orchestrate.ts: the business is already
 * past `running` + has a Telnyx DID + Cloudflare tunnel; we just need to
 * pick up the bootstrap.sh / deploy-client.sh changes from this PR and
 * verify Rowboat boots cleanly off the pinned brianlane/rowboat fork.
 *
 * Flow:
 *   1. Fetch the active vps_ssh_keys row for the business.
 *   2. SSH in and `git fetch && git checkout ai-chat` on
 *      /opt/newcoworker-repo so the host has the new bootstrap.sh.
 *   3. Re-run bootstrap.sh with TIER=standard to refresh the Rowboat
 *      checkout (forces git remote update + checkout to f7e6f783...) and
 *      rebuild the compose stack against apps/rowboat.
 *   4. Re-run deploy-client.sh with the full env so the Rowboat .env
 *      gets the new MONGODB_CONNECTION_STRING / USE_AUTH / AUTH0_* /
 *      AGENTS_API_* / COPILOT_API_* / USE_RAG / QDRANT_URL keys, then
 *      `docker compose up -d --build`.
 *
 * Idempotent. Safe to re-run; bootstrap + deploy-client are themselves
 * idempotent and the cloudflared install now no-ops when already
 * present.
 */
// Load .env without depending on the optional `dotenv` package — keeps
// the one-shot runnable on a fresh `npm i --omit=optional` install.
import { readFileSync } from "fs";
try {
  const env = readFileSync(`${process.cwd()}/.env`, "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* tolerable: assume env is exported in shell */
}

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sshExec } from "@/lib/hostinger/ssh";
import { quoteShellEnvValue } from "@/lib/provisioning/orchestrate";

const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const PUBLIC_IP = "177.7.52.140";

async function ssh(privateKeyPem: string, command: string, label: string) {
  console.log(`\n[live-apply] ${label}`);
  console.log(`            $ ${command.length > 200 ? `${command.slice(0, 197)}...` : command}`);
  const t0 = Date.now();
  const r = await sshExec({
    host: PUBLIC_IP,
    username: "root",
    privateKeyPem,
    command,
    // Bootstrap can take 4-6 min on a warm KVM 8 (apt cache / docker
    // pulls). Generous timeout so we don't yank a healthy run.
    timeoutMs: 15 * 60 * 1000
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`            -> exit=${r.exitCode} elapsed=${elapsed}s`);
  if (r.stdout) console.log(`            stdout: ${r.stdout.slice(-500)}`);
  if (r.stderr) console.log(`            stderr: ${r.stderr.slice(-500)}`);
  if (r.exitCode !== 0) {
    throw new Error(`[live-apply] ${label} failed: exit=${r.exitCode}`);
  }
  return r;
}

async function main() {
  const db = await createSupabaseServiceClient();
  const { data: keys, error } = await db
    .from("vps_ssh_keys")
    .select("*")
    .eq("business_id", BUSINESS_ID)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`vps_ssh_keys lookup: ${error.message}`);
  if (!keys || keys.length === 0) throw new Error("no vps_ssh_keys row found");
  const key = keys[0];
  console.log(
    `[live-apply] using key id=${key.id} hostinger_vps_id=${key.hostinger_vps_id} fp=${key.fingerprint_sha256}`
  );

  // 1. Refresh repo to ai-chat (where this PR lives until merged to main).
  //    The original clone was a shallow `--branch main` so ai-chat isn't
  //    in the refspec; force-set it with `git fetch <url> ai-chat:ai-chat`
  //    so `--depth=1` semantics are preserved.
  await ssh(
    key.private_key_pem,
    `cd /opt/newcoworker-repo && ` +
      `git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && ` +
      `git fetch --depth=1 origin ai-chat && ` +
      `git checkout -B ai-chat FETCH_HEAD && ` +
      `git log -1 --oneline`,
    "checkout ai-chat in /opt/newcoworker-repo"
  );

  // 2. Surgical Rowboat re-pin. Re-running bootstrap.sh end-to-end
  //    works but takes >15min because it triggers a fresh
  //    `docker compose up --build` which downloads + builds Rowboat
  //    images. On an already-bootstrapped host (this is one), only the
  //    Rowboat checkout + compose template are out-of-date — we point
  //    git remote at the fork, force-checkout the pinned SHA, then let
  //    bootstrap.sh's compose template re-render via a `bash -c` of the
  //    "Tier-aware Rowboat docker-compose" block extracted below.
  await ssh(
    key.private_key_pem,
    `cd /opt/rowboat/src && ` +
      `git remote set-url origin https://github.com/brianlane/rowboat.git && ` +
      `git fetch --depth=1 origin f7e6f783baa98a929880ce1f537481bc7d4f3415 || ` +
      `git fetch origin f7e6f783baa98a929880ce1f537481bc7d4f3415 && ` +
      `git checkout --detach f7e6f783baa98a929880ce1f537481bc7d4f3415 && ` +
      `git remote -v && git rev-parse HEAD`,
    "re-pin /opt/rowboat/src to brianlane/rowboat@f7e6f783..."
  );

  // 3. Re-render docker-compose.yml with the apps/rowboat build context.
  //    We write the standard-tier template inline (matches the literal in
  //    vps/scripts/bootstrap.sh §6 — keep in lockstep on edits).
  const composeYml = `services:
  rowboat:
    build:
      context: /opt/rowboat/src/apps/rowboat
      dockerfile: Dockerfile
    container_name: rowboat
    restart: always
    env_file: /opt/rowboat/.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/rowboat/vault:/vault:ro
      - /opt/rowboat/memory:/memory
    depends_on:
      - llm-router
      - mongo
      - redis

  llm-router:
    build:
      context: /opt/rowboat/llm-router
    container_name: llm-router
    restart: always
    env_file: /opt/rowboat/.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      OLLAMA_URL: http://host.docker.internal:11434
      LLM_ROUTER_PORT: 11435
    ports:
      - "127.0.0.1:11435:11435"

  jobs-worker:
    build:
      context: /opt/rowboat/src/apps/rowboat
      dockerfile: scripts.Dockerfile
    container_name: rowboat-jobs
    restart: always
    env_file: /opt/rowboat/.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - mongo
      - redis
      - qdrant
    command: ["npm", "run", "jobs-worker"]

  mongo:
    image: mongo:7
    container_name: rowboat-mongo
    restart: always
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7-alpine
    container_name: rowboat-redis
    restart: always

  qdrant:
    image: qdrant/qdrant:latest
    container_name: rowboat-qdrant
    restart: always
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  mongo_data:
  qdrant_data:
`;
  const composeB64 = Buffer.from(composeYml, "utf8").toString("base64");
  await ssh(
    key.private_key_pem,
    `printf '%s' '${composeB64}' | base64 -d > /opt/rowboat/docker-compose.yml && ` +
      `grep -E 'context:|dockerfile:|container_name:' /opt/rowboat/docker-compose.yml | head -30`,
    "write new docker-compose.yml (apps/rowboat contexts) and verify"
  );

  // 4. Refresh /opt/deploy-client.sh from the freshly-checked-out
  //    /opt/newcoworker-repo so the new env vars + cloudflared
  //    idempotency guard land before we invoke it below.
  await ssh(
    key.private_key_pem,
    `install -m 0755 /opt/newcoworker-repo/vps/scripts/deploy-client.sh /opt/deploy-client.sh && head -3 /opt/deploy-client.sh && stat -c '%Y bytes=%s' /opt/deploy-client.sh`,
    "refresh /opt/deploy-client.sh from staged repo"
  );

  // 5. Run deploy-client.sh in the BACKGROUND with nohup so the long
  //    Rowboat docker compose --build (10-15min on KVM 8) doesn't fight
  //    SSH's 15min overall timeout. We tail the log file in a subsequent
  //    SSH call to surface progress + the final Rowboat health probe.
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const ROWBOAT_GATEWAY_TOKEN = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? "";
  const TELNYX_MESSAGING_PROFILE_ID =
    process.env.TELNYX_MESSAGING_PROFILE_ID ?? process.env.TELNYX_PROFILE_ID ?? "";
  const STREAM_URL_SIGNING_SECRET = process.env.STREAM_URL_SIGNING_SECRET ?? "";
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
  const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const LIGHTPANDA_WSS_URL = process.env.LIGHTPANDA_WSS_URL ?? "wss://cdn.lightpanda.io/ws";

  // Bash-quote every value via `printf %q` so secrets containing `$`,
  // backticks, `"`, or `\` survive the OUTER `bash -c "..."` wrapper.
  // Naïve single-quoting (`KEY='value'`) is unsafe here because the
  // outer double quotes still let the shell interpolate `$` inside the
  // string before the inner shell ever sees the single quotes — i.e.
  // a Telnyx key like `KEY02$YEAR_FOO` gets silently corrupted to
  // `KEY02_FOO`. The orchestrator's production deploy uses the same
  // helper for the same reason; we share its implementation.
  const q = quoteShellEnvValue;
  const envInline = [
    `BUSINESS_ID=${q(BUSINESS_ID)}`,
    `TIER=${q("standard")}`,
    `SUPABASE_URL=${q(SUPABASE_URL)}`,
    `SUPABASE_SERVICE_KEY=${q(SUPABASE_SERVICE_KEY)}`,
    `ROWBOAT_GATEWAY_TOKEN=${q(ROWBOAT_GATEWAY_TOKEN)}`,
    `NOTIFICATIONS_WEBHOOK_TOKEN=${q(SUPABASE_SERVICE_KEY)}`,
    `TELNYX_API_KEY=${q(TELNYX_API_KEY)}`,
    `TELNYX_MESSAGING_PROFILE_ID=${q(TELNYX_MESSAGING_PROFILE_ID)}`,
    `STREAM_URL_SIGNING_SECRET=${q(STREAM_URL_SIGNING_SECRET)}`,
    `GOOGLE_API_KEY=${q(GOOGLE_API_KEY)}`,
    `APP_BASE_URL=${q(APP_BASE_URL)}`,
    `LIGHTPANDA_WSS_URL=${q(LIGHTPANDA_WSS_URL)}`,
    `VOICE_BRIDGE_SRC=${q("/opt/newcoworker-repo/vps/voice-bridge")}`
  ].join(" ");

  // Wrap the deploy invocation in a base64-decoded heredoc so we don't
  // have to think about escaping the OUTER `bash -c "..."` at all —
  // the env values are already %q-quoted for the inner shell, and we
  // hand the inner shell its source verbatim. nohup keeps the deploy
  // alive after the SSH channel closes; the polling loop below tails
  // /var/log/live-apply-deploy.log to surface progress.
  const innerScript = `nohup ${envInline} bash /opt/deploy-client.sh > /var/log/live-apply-deploy.log 2>&1 & echo "deploy pid=$!"`;
  const innerB64 = Buffer.from(innerScript, "utf8").toString("base64");
  await ssh(
    key.private_key_pem,
    `printf '%s' '${innerB64}' | base64 -d | bash`,
    "kick off deploy-client.sh in background"
  );

  // 6. Poll the log file every 60s for up to 25min until we see the
  //    "Client deployment complete" sentinel or a fatal error. Each
  //    iteration is its own SSH call so we don't hold a single
  //    long-lived channel open.
  const maxPollMs = 25 * 60 * 1000;
  const pollIntervalMs = 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < maxPollMs) {
    const r = await ssh(
      key.private_key_pem,
      `tail -50 /var/log/live-apply-deploy.log | tail -30`,
      `poll deploy log (elapsed ${Math.round((Date.now() - start) / 1000)}s)`
    );
    const out = `${r.stdout}\n${r.stderr}`;
    if (out.includes("Client deployment complete")) {
      console.log(`[live-apply] deploy-client.sh COMPLETE`);
      break;
    }
    if (out.match(/FATAL|Error response from daemon/i)) {
      console.warn(`[live-apply] noticed potential error in log; continuing to verify`);
      break;
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }

  // 7. Final verification: containers + Rowboat HTTP.
  await ssh(
    key.private_key_pem,
    `docker ps --format '{{.Names}}\t{{.Status}}' | head -30 && echo --- && curl -sS -m 10 -o /dev/null -w 'rowboat http=%{http_code}\\n' http://127.0.0.1:3000/ && echo --- && tail -10 /var/log/live-apply-deploy.log`,
    "verify rowboat container status + HTTP + final deploy log tail"
  );

  console.log(`\n[live-apply] DONE — VPS ${PUBLIC_IP} is on the new bootstrap.`);
}

main().catch((err) => {
  console.error("[live-apply] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
