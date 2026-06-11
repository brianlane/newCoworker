/**
 * Run an arbitrary shell command on a tenant's VPS over SSH.
 *
 * The swiss-army knife behind most ad-hoc fleet debugging: container status,
 * env audits (e.g. grep /opt/chat-worker/.env), docker logs, poking the
 * Rowboat fork source under /opt/rowboat/src, etc. Prefer the purpose-built
 * scripts (logs.ts, rowboat-logs.ts, …) when one exists.
 *
 * Usage:
 *   tsx debug/vps-exec.ts <businessId> "<command>" [--timeout=120]
 *
 * Examples:
 *   tsx debug/vps-exec.ts 621a5b0d-... "docker ps"
 *   tsx debug/vps-exec.ts 621a5b0d-... "grep -E 'START_AGENT' /opt/chat-worker/.env"
 *   tsx debug/vps-exec.ts 621a5b0d-... "cd /opt/rowboat/src && git log --oneline -1"
 *
 * ⚠️ Runs as root on a LIVE tenant box — read your command twice.
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0];
const COMMAND = args[1];
const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
const TIMEOUT_S = timeoutArg ? Number(timeoutArg.split("=")[1]) : 120;

if (!BUSINESS_ID || !COMMAND) {
  console.error('usage: tsx debug/vps-exec.ts <businessId> "<command>" [--timeout=120]');
  process.exit(1);
}

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: COMMAND,
  timeoutMs: TIMEOUT_S * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
process.exit(res.exitCode ?? 0);
