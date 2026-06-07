/**
 * Non-destructive smoke for the SMS Gemini reseed: curl the REAL production
 * Rowboat /chat path for the inbound-SMS `Coworker` agent (stateless, so the
 * startAgent override is honored) and confirm it answers fast via Gemini through
 * the llm-router. Makes NO config changes and sends NO SMS.
 *
 * Usage: tsx debug/probe-sms-coworker.ts [businessId] ["message"]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const MESSAGE = args[1] ?? "Hi, what are your hours?";
const messagesJson = JSON.stringify([{ role: "user", content: MESSAGE }]);

const remote = `
set -uo pipefail
echo "===COWORKER_MODEL==="
docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat --eval '
var p=db.projects.findOne({});
var a=(p.liveWorkflow.agents||[]).find(function(x){return x.name=="Coworker";});
print(a?a.model:"NO_AGENT");' 2>/dev/null || echo ERR
echo "===CHAT_TEST==="
RB_URL=\$(grep -E '^ROWBOAT_BASE_URL=' /opt/chat-worker/.env | cut -d= -f2-)
RB_PID=\$(grep -E '^ROWBOAT_PROJECT_ID=' /opt/chat-worker/.env | cut -d= -f2-)
RB_TOK=\$(grep -E '^ROWBOAT_GATEWAY_TOKEN=' /opt/chat-worker/.env | cut -d= -f2-)
RB_URL=\${RB_URL:-http://rowboat:3000}
cat > /tmp/sms-probe-msgs.json <<'MSGS_EOF'
${messagesJson}
MSGS_EOF
cat > /tmp/sms-probe.js <<'JS_EOF'
const fs=require('fs');
const msgs=JSON.parse(fs.readFileSync('/tmp/sms-probe-msgs.json','utf8'));
const url=process.env.RB_URL.replace(/\\/$/,'')+"/api/v1/"+process.env.RB_PID+"/chat";
(async()=>{
  const body={messages:msgs,stream:false,startAgent:"Coworker"};
  const t0=Date.now();
  let r,txt;
  try{ r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.RB_TOK},body:JSON.stringify(body)}); txt=await r.text(); }
  catch(e){ console.log('ERR '+(e&&e.message||e)); process.exit(1); }
  const ms=Date.now()-t0;
  if(!r.ok){ console.log('HTTP_'+r.status+' '+ms+'ms :: '+txt.slice(0,300)); process.exit(1); }
  let reply='';
  try{ const j=JSON.parse(txt); const out=(j.turn&&j.turn.output)||[]; const a=out.find(function(m){return m&&m.role==='assistant'&&typeof m.content==='string'&&m.content;}); reply=a?a.content:''; }catch(e){ reply='[parse err] '+txt.slice(0,200); }
  console.log('OK '+ms+'ms :: '+reply.slice(0,300).replace(/\\n/g,' '));
})();
JS_EOF
docker cp /tmp/sms-probe-msgs.json chat-worker:/tmp/sms-probe-msgs.json >/dev/null
docker cp /tmp/sms-probe.js chat-worker:/tmp/sms-probe.js >/dev/null
docker exec -e RB_URL="\$RB_URL" -e RB_PID="\$RB_PID" -e RB_TOK="\$RB_TOK" chat-worker node /tmp/sms-probe.js
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== SMS Coworker (Gemini) probe ==`);
console.log(`vps=${ip} business=${BUSINESS_ID}`);
console.log(`message: "${MESSAGE}"`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 3 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[probe] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
