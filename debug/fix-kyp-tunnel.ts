/**
 * fix-kyp-tunnel.ts — one-shot: repoint cloudflared on KYP Ads' adopted box
 * (vm 1800985, ex-pilot KVM1) at KYP's OWN tunnel.
 *
 * Root cause (Jul 15 2026): the box came from the adoption pool with a
 * cloudflared unit left over from its previous tenant. deploy-client.sh
 * deliberately treats an existing unit as "restart, don't reinstall", so the
 * OLD tunnel token survived adoption — the box kept serving the previous
 * tenant's tunnel while KYP's hostnames (056034a7-….newcoworker.com and
 * voice-056034a7-…) pointed at tunnel e75b5473-9827-4e60-861a-93e4cff40877,
 * which had no connector → every request 530'd and James's first SMS
 * dead-lettered with rowboat_http_530.
 *
 * The fix: `cloudflared service uninstall` (removes the stale unit) then
 * `service install` with the token fetched from the Cloudflare API for KYP's
 * tunnel (written to /tmp/kyp-tunnel-token.txt by the diagnostic step).
 *
 * Usage: npx tsx debug/fix-kyp-tunnel.ts
 */
import fs from "node:fs";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";
const TOKEN = fs.readFileSync("/tmp/kyp-tunnel-token.txt", "utf8").trim();
if (!TOKEN || TOKEN.length < 100) throw new Error("tunnel token missing/short — refetch it first");

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);
console.log(`[fix] vpsId=${key.hostinger_vps_id} ip=${ip}`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: `
set -euo pipefail
echo "== before =="
systemctl is-active cloudflared || true
cloudflared service uninstall || true
systemctl daemon-reload
cloudflared service install '${TOKEN}'
systemctl enable cloudflared
systemctl restart cloudflared
sleep 6
echo "== after =="
systemctl is-active cloudflared
journalctl -u cloudflared --no-pager -n 8 | tail -8
`,
  timeoutMs: 120_000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[fix] exitCode=${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
