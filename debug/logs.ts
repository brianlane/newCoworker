/**
 * Tail the chat-worker's recent memory-capture / job logs from a tenant VPS.
 *
 * Usage:
 *   tsx debug/logs.ts [businessId] [grepPattern]
 *
 * Defaults to business 621a5b0d and a pattern covering the memory-capture and
 * job-lifecycle events. Pass a custom pattern to chase a specific job id, e.g.
 *   tsx debug/logs.ts 621a5b0d-... "b8ba7088|process_failed"
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const PATTERN = process.argv[3] ?? "memory_|process_done|process_failed";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

const remote = `docker logs chat-worker --tail 200 2>&1 | grep -E "${PATTERN}" | tail -40`;
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 60_000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
process.exit(res.exitCode === 0 ? 0 : 1);
