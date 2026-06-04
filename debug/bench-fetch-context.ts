/**
 * Benchmark helper (1/2): fetch the LIVE per-tenant prompt context once and
 * cache it locally so debug/benchmark.ts can build faithful prompts without
 * re-SSHing on every run.
 *
 * Pulls, over SSH from the tenant VPS:
 *   - The OwnerCoworker agent's `instructions` from Rowboat's Mongo
 *     (db.projects.liveWorkflow.agents[]) — this is the big system prompt
 *     Rowboat injects, and it has the synced memory_md embedded in it.
 *   - Ollama version + installed model tags (so we benchmark the real model).
 *
 * Writes debug/.bench-context.json (gitignored).
 *
 * Usage: tsx debug/bench-fetch-context.ts [businessId]
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const OUT = path.resolve(process.cwd(), "debug/.bench-context.json");

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

// Dump agent instructions (base64 to survive transport) + ollama metadata.
// Markers let us slice the fields back out of mixed stdout.
const remote = `
set -uo pipefail
echo "===OLLAMA_VERSION==="
curl -s http://127.0.0.1:11434/api/version || echo '{}'
echo ""
echo "===OLLAMA_TAGS==="
curl -s http://127.0.0.1:11434/api/tags | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);console.log((d.models||[]).map(m=>m.name+":"+(m.size||0)).join(","))}catch(e){console.log("")}})' || echo ""
echo ""
echo "===AGENTS_B64==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval '
const p = db.projects.findOne({});
const ws = (p && p.liveWorkflow && p.liveWorkflow.agents) ? p.liveWorkflow.agents : [];
const out = ws.map(a => ({ name: a.name, instructions: a.instructions || "" }));
print(Buffer.from(JSON.stringify(out)).toString("base64"));
' 2>/dev/null || echo ""
echo ""
echo "===END==="
`;

let buf = "";
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 90_000,
  onStdout: (c) => {
    buf += c;
    process.stdout.write(c.length > 200 ? "." : c);
  },
  onStderr: (c) => process.stderr.write(c)
});

function between(marker: string, next: string): string {
  const a = buf.indexOf(`===${marker}===`);
  if (a < 0) return "";
  const start = a + `===${marker}===`.length;
  const b = buf.indexOf(`===${next}===`, start);
  return buf.slice(start, b < 0 ? undefined : b).trim();
}

const version = between("OLLAMA_VERSION", "OLLAMA_TAGS");
const tags = between("OLLAMA_TAGS", "AGENTS_B64");
const agentsB64 = between("AGENTS_B64", "END").replace(/\s+/g, "");

let agents: { name: string; instructions: string }[] = [];
try {
  agents = JSON.parse(Buffer.from(agentsB64, "base64").toString("utf8"));
} catch (e) {
  console.error("\nfailed to parse agents b64", (e as Error).message);
}

const owner = agents.find((a) => a.name === "OwnerCoworker") ?? agents[0];
const context = {
  businessId: BUSINESS_ID,
  fetchedAt: new Date().toISOString(),
  ollamaVersion: version,
  ollamaTags: tags,
  agents: agents.map((a) => ({ name: a.name, instructionsChars: a.instructions.length })),
  ownerAgentName: owner?.name ?? null,
  ownerInstructions: owner?.instructions ?? ""
};

fs.writeFileSync(OUT, JSON.stringify(context, null, 2));
console.log(`\n\n[bench-context] exit ${res.exitCode}`);
console.log(`  ollama version: ${version}`);
console.log(`  ollama tags: ${tags}`);
console.log(`  agents: ${context.agents.map((a) => `${a.name}=${a.instructionsChars}c`).join(", ")}`);
console.log(`  owner agent: ${context.ownerAgentName} (${context.ownerInstructions.length} chars)`);
console.log(`  wrote ${OUT}`);
process.exit(res.exitCode === 0 ? 0 : 1);
