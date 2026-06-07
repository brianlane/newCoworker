/**
 * Targeted SMS-workflow reseed for the PR #111 rollout.
 *
 * Repoints the inbound-SMS `Coworker` agent off local Qwen onto Gemini and adds
 * the `CoworkerLocal` spend-cap fallback twin (identical instructions/tools, but
 * pinned to the local Ollama model). Surgically patches the Mongo
 * liveWorkflow + draftWorkflow agents arrays in place — no container churn, no
 * .env regeneration (unlike a full deploy-client.sh re-provision).
 *
 * Idempotent: re-running keeps Coworker on the resolved model and keeps
 * CoworkerLocal's model in sync; it never duplicates the twin.
 *
 * Keyless safety: mirrors deploy-client.sh — a gemini-* target needs
 * GOOGLE_API_KEY in /opt/rowboat/.env (the llm-router 503s gemini-* without a
 * key), so on a keyless host Coworker degrades to the local model and the script
 * warns. CoworkerLocal is always the local model.
 *
 * Usage: tsx debug/reseed-sms-workflow.ts [businessId] [model]
 *   businessId  default 621a5b0d-c2ad-449f-9d74-9d50e7b27fa3
 *   model       default gemini-2.5-flash-lite
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BUSINESS_ID = args[0] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TARGET_MODEL = args[1] ?? "gemini-2.5-flash-lite";

const remote = `
set -uo pipefail
RB_ENV=/opt/rowboat/.env
GK=\$(grep -m1 '^GOOGLE_API_KEY=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
OLM=\$(grep -m1 '^OLLAMA_MODEL=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
OLM=\${OLM:-qwen3:4b-instruct}
SMS_MODEL="${TARGET_MODEL}"
case "\$SMS_MODEL" in
  gemini-*)
    if [ -z "\$GK" ]; then
      echo "WARNING: target \$SMS_MODEL needs GOOGLE_API_KEY but none in \$RB_ENV — Coworker will stay on local \$OLM (keyless)"
      SMS_MODEL="\$OLM"
    fi
    ;;
esac
echo "GOOGLE_API_KEY=\$([ -n "\$GK" ] && echo set || echo MISSING)  resolved Coworker=\$SMS_MODEL  CoworkerLocal=\$OLM"

DC="docker compose -f /opt/rowboat/docker-compose.yml"

echo "===CURRENT==="
\$DC exec -T mongo mongosh --quiet rowboat --eval '
db.projects.find({}).forEach(function(p){
  var a=(p.liveWorkflow&&p.liveWorkflow.agents)||[];
  var cw=a.find(function(x){return x.name=="Coworker";});
  var cl=a.find(function(x){return x.name=="CoworkerLocal";});
  print(p._id+"  Coworker="+(cw?cw.model:"NONE")+"  CoworkerLocal="+(cl?cl.model:"NONE"));
});' 2>/dev/null || echo "ERR reading current"

# Build the patch script: const prefix carries the host-resolved models (bash
# expansion), the quoted heredoc carries the logic verbatim (so Mongo operators
# like \$set are NOT eaten by the shell).
printf 'const GEMINI=%s;\\nconst LOCAL=%s;\\n' "\\"\$SMS_MODEL\\"" "\\"\$OLM\\"" > /tmp/reseed-sms.js
cat >> /tmp/reseed-sms.js <<'JS_EOF'
function patch(wf){
  if(!wf || !Array.isArray(wf.agents)) return false;
  var agents = wf.agents;
  var cw = agents.find(function(a){return a.name==="Coworker";});
  if(!cw) return false;
  cw.model = GEMINI;
  var local = agents.find(function(a){return a.name==="CoworkerLocal";});
  if(local){
    local.model = LOCAL;
  } else {
    var clone = JSON.parse(JSON.stringify(cw));
    clone.name = "CoworkerLocal";
    clone.model = LOCAL;
    clone.description = "Inbound-SMS spend-cap fallback: identical to Coworker but on the local model.";
    var idx = agents.indexOf(cw);
    agents.splice(idx+1, 0, clone);
  }
  return true;
}
var n=0, updated=0;
db.projects.find({}).forEach(function(p){
  n++;
  var a = patch(p.liveWorkflow);
  var b = patch(p.draftWorkflow);
  if(a || b){
    db.projects.updateOne({_id:p._id},{$set:{liveWorkflow:p.liveWorkflow, draftWorkflow:p.draftWorkflow}});
    updated++;
  }
});
print(JSON.stringify({projects:n, updated:updated}));
JS_EOF

echo "===APPLY==="
\$DC cp /tmp/reseed-sms.js mongo:/tmp/reseed-sms.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-sms.js 2>/dev/null || echo "ERR applying"

echo "===VERIFY==="
\$DC exec -T mongo mongosh --quiet rowboat --eval '
db.projects.find({}).forEach(function(p){
  var live=(p.liveWorkflow&&p.liveWorkflow.agents)||[];
  var draft=(p.draftWorkflow&&p.draftWorkflow.agents)||[];
  function m(arr,name){var x=arr.find(function(y){return y.name===name;});return x?x.model:"NONE";}
  print(p._id+"  live[Coworker="+m(live,"Coworker")+", CoworkerLocal="+m(live,"CoworkerLocal")+"]  draft[Coworker="+m(draft,"Coworker")+", CoworkerLocal="+m(draft,"CoworkerLocal")+"]");
});' 2>/dev/null || echo "ERR verify"
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== SMS workflow reseed ==`);
console.log(`vps=${ip} business=${BUSINESS_ID} target=${TARGET_MODEL}`);

const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 5 * 60 * 1000,
  onStdout: (c) => process.stdout.write(c),
  onStderr: (c) => process.stderr.write(c)
});
console.log(`\n[reseed] exit ${res.exitCode}`);
process.exit(res.exitCode === 0 ? 0 : 1);
