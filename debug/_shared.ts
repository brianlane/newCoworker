/**
 * Shared helpers for the one-shot operational/debug scripts in this folder.
 *
 * These scripts run locally via `tsx` against the LIVE fleet — they read the
 * repo's `.env` for Supabase + Hostinger credentials, look up each tenant's
 * VPS SSH key, resolve its public IP, and run remote commands over SSH. They
 * are intentionally NOT part of the app bundle and NOT covered by the test
 * suite (coverage is scoped to `src/lib/**`). See debug/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import type { VpsSshKeyRow } from "../src/lib/db/vps-ssh-keys.ts";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "../src/lib/hostinger/client.ts";

/**
 * Load the repo-root `.env` into process.env WITHOUT clobbering anything
 * already present in the real environment (so `FOO=bar tsx debug/x.ts` still
 * wins). The src/lib helpers read process.env lazily at call time, so this
 * must run before importing/calling them.
 */
export function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k] === undefined) {
      process.env[k] = vRaw.replace(/^["']|["']$/g, "");
    }
  }
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
 * the docker-compose extra_hosts wiring, and rebuild/recreate the container.
 * Idempotent and safe to re-run. Shared by deploy-worker.ts and
 * update-all-vps.ts so a single source of truth defines "update a worker".
 */
export const UPDATE_WORKER_REMOTE = `
set -uo pipefail
REPO=/opt/newcoworker-repo
echo "== refreshing repo =="
git -C "$REPO" fetch --depth=1 origin main && git -C "$REPO" reset --hard FETCH_HEAD
git -C "$REPO" log --oneline -1
echo "== rsync chat-worker =="
rsync -a --delete --exclude .env --exclude node_modules "$REPO/vps/chat-worker/" /opt/chat-worker/
echo "== docker-compose extra_hosts check =="
grep -n "host.docker.internal" /opt/chat-worker/docker-compose.yml || echo "NO extra_hosts!"
echo "== rebuild chat-worker =="
cd /opt/chat-worker && docker compose up -d --build --force-recreate
echo "== worker env (capture vars) =="
grep -E "MEMORY_CAPTURE|OLLAMA_BASE_URL|WORKER_VERCEL_BASE_URL" /opt/chat-worker/.env || echo "(none — relying on code defaults)"
sleep 4
echo "== worker logs (tail) =="
docker logs chat-worker --tail 20 2>&1 | tail -20
`;
