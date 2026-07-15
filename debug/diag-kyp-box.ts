/**
 * diag-kyp-box.ts — one-shot: diagnose KYP Ads' VPS after the tunnel started
 * returning 530s (Jul 15 2026: owner SMS "can i chat here" dead-lettered with
 * rowboat_http_530). Checks cloudflared + docker services.
 *
 * Usage: npx tsx debug/diag-kyp-box.ts
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);
console.log(`[diag] vpsId=${key.hostinger_vps_id} ip=${ip} user=${key.ssh_username}`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: `
set -x
uptime
systemctl is-active cloudflared || true
systemctl status cloudflared --no-pager -l 2>&1 | tail -15 || true
docker ps -a --format '{{.Names}}\t{{.Status}}' || true
journalctl -u cloudflared --no-pager -n 20 2>&1 | tail -20 || true
`,
  timeoutMs: 90_000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[diag] exitCode=${res.exitCode}`);
process.exit(0);
