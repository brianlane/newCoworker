import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
loadEnv();
const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
const ip = await resolveVpsIp(makeHostingerClient(), key!);
const res = await sshExec({
  host: ip, username: key!.ssh_username || "root", privateKeyPem: key!.private_key_pem,
  command: `docker compose -f /opt/rowboat/docker-compose.yml logs rowboat --since 15m --no-color 2>&1 | tail -c 200000`,
  timeoutMs: 120000,
  onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c)
});
process.exit(res.exitCode === 0 ? 0 : 1);
