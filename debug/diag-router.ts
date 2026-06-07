import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
loadEnv();
const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const remote = `
set -uo pipefail
DC="docker compose -f /opt/rowboat/docker-compose.yml"
echo "===ROUTER HEALTH==="
\$DC exec -T llm-router wget -qO- http://127.0.0.1:11435/health 2>/dev/null || echo "(no health)"
echo ""
echo "===DIRECT ROUTER CALL (gemini-2.5-flash-lite)==="
\$DC exec -T rowboat sh -lc 'wget -S -O- --header="Content-Type: application/json" --header="Authorization: Bearer router" --post-data="{\\"model\\":\\"gemini-2.5-flash-lite\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}" http://llm-router:11435/v1/chat/completions 2>&1 | head -40' || echo "(call failed)"
echo ""
echo "===LLM-ROUTER LOGS (last 30)==="
\$DC logs --tail=30 --no-color llm-router 2>/dev/null | tail -30 || echo "(no logs)"
echo "===DONE==="
`;
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);
const res = await sshExec({ host: ip, username: key.ssh_username || "root", privateKeyPem: key.private_key_pem, command: remote, timeoutMs: 3 * 60 * 1000, onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c) });
process.exit(res.exitCode === 0 ? 0 : 1);
