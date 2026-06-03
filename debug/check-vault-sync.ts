/**
 * Read-only drift check between Supabase `business_configs` and the live VPS
 * Rowboat agent prompt (MongoDB `projects.{draft,live}Workflow.agents[].instructions`).
 *
 * The agent answers from the Mongo `instructions` field (identity + soul +
 * website + memory), refreshed by `syncVaultToVps`. If a memory/config edit
 * landed in Supabase but the sync didn't propagate, the agent keeps replying
 * from a stale prompt. This script surfaces that drift: it takes the last
 * saved memory bullet as a probe and reports whether each agent's instructions
 * contain it, plus Mongo `lastUpdatedAt`.
 *
 * Usage:
 *   tsx debug/check-vault-sync.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const db = await createSupabaseServiceClient();
const { data } = await db
  .from("business_configs")
  .select("memory_md, rowboat_project_id")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
const memoryMd = (data?.memory_md as string | null) ?? "";
const projectId = (data?.rowboat_project_id as string | null)?.trim() || BUSINESS_ID;

// Probe = the last saved bullet line in memory_md (most recent edit).
const bullets = memoryMd
  .split(/\r?\n/)
  .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
  .filter(Boolean);
const probe = bullets[bullets.length - 1] ?? "";
console.log(`[check] business=${BUSINESS_ID} project=${projectId}`);
console.log(`[check] supabase memory_md: ${memoryMd.length} chars, ${bullets.length} bullet lines`);
console.log(`[check] probe (last bullet): ${JSON.stringify(probe.slice(0, 80))}`);

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);

const probeB64 = Buffer.from(probe, "utf8").toString("base64");
const evalJs = [
  `const probe=Buffer.from("${probeB64}","base64").toString("utf8");`,
  `const p=db.projects.findOne({_id:${JSON.stringify(projectId)}});`,
  `if(!p){print("NO_PROJECT");quit(0);}`,
  `const show=(label,ags)=>{(ags||[]).forEach(a=>{const i=a.instructions||"";print(label+" agent="+a.name+" len="+i.length+" hasProbe="+(probe.length>0&&i.includes(probe)));});};`,
  `show("LIVE",p.liveWorkflow&&p.liveWorkflow.agents);`,
  `show("DRAFT",p.draftWorkflow&&p.draftWorkflow.agents);`,
  `print("lastUpdatedAt="+p.lastUpdatedAt);`
].join("");

const remote = `docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval ${JSON.stringify(
  evalJs
)}`;

let buf = "";
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 90_000,
  onStdout: (c) => (buf += c),
  onStderr: (c) => (buf += c)
});
console.log("\n[check] VPS Mongo agent instructions:");
console.log(buf.trim());

const inSync = probe.length > 0 && /LIVE .*OwnerCoworker.* hasProbe=true/.test(buf);
console.log(`\n[check] ${inSync ? "IN SYNC" : "DRIFT — agent prompt is stale; run debug/resync-vault.ts"}`);
process.exit(res.exitCode === 0 ? 0 : 1);
