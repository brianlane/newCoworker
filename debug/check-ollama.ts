/**
 * Verify a tenant VPS's local Ollama is reachable FROM the chat-worker
 * container and that the memory-capture extraction model responds with valid
 * structured JSON. Useful when owner-rule capture silently no-ops — it
 * isolates "is Ollama the problem" from the worker/adapter path.
 *
 * Usage:
 *   tsx debug/check-ollama.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);

const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

const remote = `
set -uo pipefail
echo "== ollama tags (from worker container) =="
docker exec chat-worker node -e '
fetch("http://host.docker.internal:11434/api/tags").then(r=>r.json()).then(d=>{
  console.log("models:", (d.models||[]).map(m=>m.name).join(", "));
}).catch(e=>console.log("ERR tags:", e.message));
'
echo "== extraction probe (qwen3:4b-instruct, JSON schema) =="
docker exec chat-worker node -e '
const body={model:"qwen3:4b-instruct",stream:false,options:{temperature:0},
  format:{type:"object",properties:{save:{type:"boolean"},bullets:{type:"array",items:{type:"string"}}},required:["save","bullets"]},
  messages:[{role:"system",content:"Decide if the owner message states a durable business rule for customer SMS/voice. Output JSON {save:boolean,bullets:string[]}. Rephrase rules as concise imperative lines; empty bullets if save=false."},
            {role:"user",content:"From now on, never discuss budget with customers."}]};
fetch("http://host.docker.internal:11434/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
 .then(r=>r.json()).then(d=>console.log("extraction:", d.message && d.message.content))
 .catch(e=>console.log("ERR chat:", e.message));
'
`;
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 120_000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[check] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
