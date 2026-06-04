/**
 * End-to-end go/no-go probe: route the OwnerCoworker agent to a Gemini model
 * and exercise the REAL production path (Rowboat → llm-router → Google
 * OpenAI-compat endpoint) to confirm it works, is fast, and answers correctly
 * BEFORE we make the config change durable.
 *
 * Why this matters beyond the standalone benchmark: production reaches Gemini
 * via the llm-router's OpenAI-compatible endpoint, and the project's own
 * gemini-generate-content.ts warns that path has 404'd for some model ids.
 * The standalone bench used native generateContent; this validates the router.
 *
 * Steps (on the tenant VPS):
 *   1. Read worker + rowboat env (Rowboat base/token/project, GOOGLE key).
 *   2. Snapshot the current OwnerCoworker model.
 *   3. Set OwnerCoworker.model = <target> in live+draft workflows (Mongo).
 *   4. From inside chat-worker, curl Rowboat /chat with the worker's real
 *      message shape, timing each rep; capture reply + correctness.
 *
 * Pass [businessId] [model] [reps] [--revert]. Default model
 * gemini-2.5-flash-lite. With --revert it sets OwnerCoworker BACK to the local
 * model (qwen3:4b-instruct) — actively rolling back a prior Gemini switch —
 * then runs the chat test against that local model.
 *
 * Usage: tsx debug/probe-gemini-owner.ts [businessId] [model] [reps] [--revert]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
import { buildWorkerMessages, EXPECTED_ANSWERS, QUESTION } from "./bench-prompts.ts";

loadEnv();

const args = process.argv.slice(2);
const REVERT = args.includes("--revert");
const positional = args.filter((a) => !a.startsWith("--"));
const BUSINESS_ID = positional[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TARGET_MODEL = positional[1] ?? "gemini-2.5-flash-lite";
const REPS = Number(positional[2] ?? 2);
// Local fallback model used when rolling back (--revert). Matches deploy's
// OLLAMA_MODEL default for KVM8. The probe ALWAYS sets a concrete model so
// --revert genuinely restores local instead of leaving a prior switch in place.
const REVERT_MODEL = "qwen3:4b-instruct";
const EFFECTIVE_MODEL = REVERT ? REVERT_MODEL : TARGET_MODEL;

const messages = buildWorkerMessages();
const messagesJson = JSON.stringify(messages);
const expectedJson = JSON.stringify(EXPECTED_ANSWERS);

const remote = `
set -uo pipefail
echo "===WORKER_ENV==="
# Print non-secret worker config; mask the gateway token value (the chat test
# below reads it separately into an env var, never echoing it).
grep -E '^(ROWBOAT_BASE_URL|ROWBOAT_PROJECT_ID|CHAT_WORKER_OWNER_START_AGENT)=' /opt/chat-worker/.env || true
grep -qE '^ROWBOAT_GATEWAY_TOKEN=.+' /opt/chat-worker/.env && echo "ROWBOAT_GATEWAY_TOKEN=<set>" || echo "ROWBOAT_GATEWAY_TOKEN=<missing>"
echo "===ROUTER_HEALTH==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T llm-router wget -qO- http://127.0.0.1:11435/health 2>/dev/null || echo "(router health unavailable)"
echo ""
echo "===CURRENT_MODEL==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval '
const p=db.projects.findOne({});
const a=(p.liveWorkflow.agents||[]).find(x=>x.name=="OwnerCoworker");
print(a ? a.model : "NO_AGENT");
' 2>/dev/null || echo "ERR"
echo "===SET_MODEL (target=${EFFECTIVE_MODEL})==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval '
const target="${EFFECTIVE_MODEL}";
const setModel=(p)=>({ $map:{ input:{$ifNull:["$"+p,[]]}, as:"a", in:{ $cond:[{$eq:["$$a.name","OwnerCoworker"]},{$mergeObjects:["$$a",{model:target}]},"$$a"] } } });
const r=db.projects.updateMany({},[{$set:{"liveWorkflow.agents":setModel("liveWorkflow.agents"),"draftWorkflow.agents":setModel("draftWorkflow.agents")}}]);
print("matched="+r.matchedCount+" modified="+r.modifiedCount);
' 2>/dev/null || echo "ERR set"
echo "===VERIFY_MODEL==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval '
const p=db.projects.findOne({});
const a=(p.liveWorkflow.agents||[]).find(x=>x.name=="OwnerCoworker");
print(a ? a.model : "NO_AGENT");
' 2>/dev/null || echo "ERR"

echo "===CHAT_TEST==="
RB_URL=$(grep -E '^ROWBOAT_BASE_URL=' /opt/chat-worker/.env | cut -d= -f2-)
RB_PID=$(grep -E '^ROWBOAT_PROJECT_ID=' /opt/chat-worker/.env | cut -d= -f2-)
RB_TOK=$(grep -E '^ROWBOAT_GATEWAY_TOKEN=' /opt/chat-worker/.env | cut -d= -f2-)
RB_URL=\${RB_URL:-http://rowboat:3000}
cat > /tmp/probe-msgs.json <<'MSGS_EOF'
${messagesJson}
MSGS_EOF
cat > /tmp/probe-run.js <<'JS_EOF'
const fs=require('fs');
const msgs=JSON.parse(fs.readFileSync('/tmp/probe-msgs.json','utf8'));
const expected=${expectedJson};
const url=process.env.RB_URL.replace(/\\/$/,'')+"/api/v1/"+process.env.RB_PID+"/chat";
const norm=s=>(s||'').replace(/[^0-9a-z]/gi,'').toLowerCase();
(async()=>{
  for(let rep=0; rep<${REPS}; rep++){
    const body={messages:msgs,stream:false,startAgent:"OwnerCoworker"};
    const t0=Date.now();
    let r,txt;
    try{
      r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.RB_TOK},body:JSON.stringify(body)});
      txt=await r.text();
    }catch(e){ console.log('REP'+rep+' ERR '+(e&&e.message||e)); continue; }
    const ms=Date.now()-t0;
    if(!r.ok){ console.log('REP'+rep+' HTTP_'+r.status+' '+ms+'ms :: '+txt.slice(0,300)); continue; }
    let reply='';
    try{ const j=JSON.parse(txt); const out=(j.turn&&j.turn.output)||[]; const a=out.find(m=>m&&m.role==='assistant'&&typeof m.content==='string'&&m.content); reply=a?a.content:''; }catch(e){ reply='[parse err] '+txt.slice(0,200); }
    const correct=expected.some(a=>norm(reply).includes(norm(a)));
    console.log('REP'+rep+' OK '+ms+'ms correct='+correct+' :: '+reply.slice(0,200).replace(/\\n/g,' '));
  }
})();
JS_EOF
docker cp /tmp/probe-msgs.json chat-worker:/tmp/probe-msgs.json >/dev/null
docker cp /tmp/probe-run.js chat-worker:/tmp/probe-run.js >/dev/null
docker exec -e RB_URL="$RB_URL" -e RB_PID="$RB_PID" -e RB_TOK="$RB_TOK" chat-worker node /tmp/probe-run.js
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== Gemini owner-chat e2e probe ==`);
console.log(`vps=${ip} business=${BUSINESS_ID} model=${EFFECTIVE_MODEL}${REVERT ? " (revert→local)" : ""}`);
console.log(`question: "${QUESTION}"`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 5 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[probe] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
