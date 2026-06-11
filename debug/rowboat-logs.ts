/**
 * Tail a tenant's Rowboat container logs, filtered by pattern.
 *
 * The Rowboat-side complement to logs.ts (chat-worker): use it to chase tool
 * calls, webhook deliveries, send_sms dispatches, or llm-router errors as
 * Rowboat saw them.
 *
 * Usage:
 *   tsx debug/rowboat-logs.ts [businessId] [grepPattern] [--since=15m] [--tail=40]
 *
 * Defaults to business 621a5b0d and a pattern covering tool/webhook/send_sms
 * traffic. Pass a custom pattern to chase a specific conversation id, e.g.
 *   tsx debug/rowboat-logs.ts 621a5b0d-... "conv_abc123|error" --since=1h
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const PATTERN = args[1] ?? "tool|webhook|send_sms";
const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const SINCE = sinceArg ? sinceArg.split("=")[1] : "15m";
const tailArg = process.argv.find((a) => a.startsWith("--tail="));
const TAIL = tailArg ? Number(tailArg.split("=")[1]) : 40;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command:
    `docker compose -f /opt/rowboat/docker-compose.yml logs --since ${SINCE} rowboat 2>/dev/null` +
    ` | grep -iE "${PATTERN}" | tail -${TAIL}`,
  timeoutMs: 120000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
process.exit(res.exitCode ?? 0);
