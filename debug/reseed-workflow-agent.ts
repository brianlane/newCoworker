/**
 * Targeted Rowboat-workflow agent reseed — repoint a named agent's MODEL on
 * already-provisioned tenants WITHOUT a full deploy-client.sh re-provision.
 *
 * Why this exists: deploy-client.sh only seeds the Mongo workflow when a tenant
 * is first provisioned (or fully re-provisioned). When we change which model a
 * workflow agent runs on (the recurring "move agent X off local Qwen onto
 * Gemini" / "roll agent X back to local" operation), existing tenants keep the
 * old model until something rewrites their Mongo `liveWorkflow`/`draftWorkflow`.
 * A full re-provision churns containers, rewrites `.env`, and reseeds memory —
 * far too heavy for a one-field change. This script surgically patches the
 * agent's `model` in place on the live + draft workflows, across one tenant or
 * the whole fleet. (For the bespoke "also create a local fallback twin" case,
 * see the historical one-off `reseed-sms-workflow.ts`.)
 *
 * Idempotent: re-running sets the same model; a project already on the target
 * model is reported `unchanged`. Projects lacking the named agent are reported
 * `missing` and skipped (the script never CREATES an agent — it only repoints an
 * existing one).
 *
 * Keyless safety (mirrors deploy-client.sh): a `gemini-*` target is only
 * reachable when `/opt/rowboat/.env` has `GOOGLE_API_KEY` (the llm-router 503s
 * gemini-* without a key). On a keyless box the target degrades to the box's
 * `OLLAMA_MODEL` and the run warns, so we never strand an agent on an
 * unreachable model.
 *
 * Effect timing: the patch is read by Rowboat for NEW conversations. Threads
 * already bound to the agent keep the model they were first bound to (Rowboat
 * resumes the bound agent/model and ignores startAgent on resume) — clear the
 * relevant thread table if you need existing conversations to re-bind.
 *
 * Usage:
 *   tsx debug/reseed-workflow-agent.ts --agent=<name> --model=<model> [targets]
 *
 *   --agent=NAME        workflow agent to repoint (e.g. Coworker, OwnerCoworker,
 *                       voice_task, dispatcher). Required.
 *   --model=MODEL       target model tag (e.g. gemini-2.5-flash-lite,
 *                       qwen3:4b-instruct). Required.
 *   --business=ID       patch a single tenant. Omit to patch EVERY active tenant.
 *   --concurrency=N     fan out across boxes (default 1, sequential).
 *   --dry-run           list targets + intent, touch nothing.
 *
 * Examples:
 *   # Repoint owner chat to a different Gemini tag on one tenant
 *   tsx debug/reseed-workflow-agent.ts --agent=OwnerCoworker \
 *     --model=gemini-2.5-flash --business=621a5b0d-...  --dry-run
 *
 *   # Roll the SMS Coworker back to local Qwen across the whole fleet
 *   tsx debug/reseed-workflow-agent.ts --agent=Coworker \
 *     --model=qwen3:4b-instruct --concurrency=4
 *
 * Exit code: 0 only when every targeted box patched cleanly; 1 if any failed
 * (per-box failures are summarized at the end).
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
}

const AGENT = flag("agent");
const MODEL = flag("model");
const BUSINESS_ID = flag("business");
const DRY_RUN = process.argv.includes("--dry-run");

function parseConcurrency(): number {
  const v = flag("concurrency");
  const n = v ? Number(v) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
const CONCURRENCY = parseConcurrency();

// Validate the two values we splice into a remote shell + mongosh script.
// Agent names are simple identifiers; model tags allow the provider separators
// (`.`, `:`) seen in gemini-2.5-flash-lite / qwen3:4b-instruct. Anything else is
// rejected so neither value can break out of the quoting on the box.
if (!AGENT || !/^[A-Za-z0-9_-]+$/.test(AGENT)) {
  console.error("error: --agent=NAME is required and must match [A-Za-z0-9_-]+");
  process.exit(2);
}
if (!MODEL || !/^[A-Za-z0-9_.:-]+$/.test(MODEL)) {
  console.error("error: --model=MODEL is required and must match [A-Za-z0-9_.:-]+");
  process.exit(2);
}

// Remote sequence: resolve the keyless-safe target on the box, print the
// current model, apply the patch via a mongosh script file (const prefix
// carries the host-resolved values; the quoted heredoc carries the logic
// verbatim so Mongo operators like $set survive the shell), then verify.
function buildRemote(agent: string, model: string): string {
  return `
set -uo pipefail
RB_ENV=/opt/rowboat/.env
GK=\$(grep -m1 '^GOOGLE_API_KEY=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
OLM=\$(grep -m1 '^OLLAMA_MODEL=' "\$RB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
OLM=\${OLM:-qwen3:4b-instruct}
AGENT="${agent}"
MODEL="${model}"
case "\$MODEL" in
  gemini-*|gemini_*|gemini.*)
    if [ -z "\$GK" ]; then
      echo "WARNING: target \$MODEL needs GOOGLE_API_KEY but none in \$RB_ENV — \$AGENT will be set to local \$OLM (keyless)"
      MODEL="\$OLM"
    fi
    ;;
esac
echo "GOOGLE_API_KEY=\$([ -n "\$GK" ] && echo set || echo MISSING)  agent=\$AGENT  resolved model=\$MODEL"

DC="docker compose -f /opt/rowboat/docker-compose.yml"

# const prefix (host-resolved) + verbatim logic heredoc.
printf 'const AGENT=%s;\\nconst MODEL=%s;\\n' "\\"\$AGENT\\"" "\\"\$MODEL\\"" > /tmp/reseed-agent.js
cat >> /tmp/reseed-agent.js <<'JS_EOF'
function modelOf(wf){
  if(!wf || !Array.isArray(wf.agents)) return "NO-WF";
  var a = wf.agents.find(function(x){return x.name===AGENT;});
  return a ? a.model : "NO-AGENT";
}
function patch(wf){
  if(!wf || !Array.isArray(wf.agents)) return "no-wf";
  var a = wf.agents.find(function(x){return x.name===AGENT;});
  if(!a) return "no-agent";
  if(a.model===MODEL) return "unchanged";
  a.model = MODEL;
  return "updated";
}
var summary={agent:AGENT, target:MODEL, projects:0, changed:0, unchanged:0, missing:0};
db.projects.find({}).forEach(function(p){
  summary.projects++;
  var beforeLive=modelOf(p.liveWorkflow), beforeDraft=modelOf(p.draftWorkflow);
  var rl=patch(p.liveWorkflow), rd=patch(p.draftWorkflow);
  print("  "+p._id+"  live["+beforeLive+"->"+modelOf(p.liveWorkflow)+"]  draft["+beforeDraft+"->"+modelOf(p.draftWorkflow)+"]");
  if(rl==="updated" || rd==="updated"){
    db.projects.updateOne({_id:p._id},{$set:{liveWorkflow:p.liveWorkflow, draftWorkflow:p.draftWorkflow}});
    summary.changed++;
  } else if(rl==="unchanged" || rd==="unchanged"){
    summary.unchanged++;
  } else {
    summary.missing++;
  }
});
print(JSON.stringify(summary));
JS_EOF

echo "===APPLY (before -> after per project)==="
\$DC cp /tmp/reseed-agent.js mongo:/tmp/reseed-agent.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-agent.js 2>/dev/null || { echo "ERR applying"; exit 1; }
echo "===DONE==="
`;
}

const { getActiveVpsSshKeyForBusiness, listActiveVpsSshKeys } = await import(
  "../src/lib/db/vps-ssh-keys.ts"
);
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");

const keys = BUSINESS_ID
  ? await (async () => {
      const k = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
      if (!k) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
      return [k];
    })()
  : await listActiveVpsSshKeys();

console.log(`== reseed workflow agent ==`);
console.log(`agent=${AGENT} model=${MODEL} targets=${keys.length}${DRY_RUN ? " (dry-run)" : ""}`);
if (keys.length === 0) process.exit(0);

const client = makeHostingerClient();
const remote = buildRemote(AGENT, MODEL);

type Outcome = { businessId: string; vpsId: string; ip?: string; ok: boolean; detail: string };

function prefix(businessId: string, chunk: string): string {
  const tag = `[${businessId.slice(0, 8)}] `;
  return chunk.replace(/\n(?!$)/g, `\n${tag}`);
}

async function patchOne(key: (typeof keys)[number]): Promise<Outcome> {
  const base = { businessId: key.business_id, vpsId: key.hostinger_vps_id };
  let ip: string;
  try {
    ip = await resolveVpsIp(client, key);
  } catch (err) {
    return { ...base, ok: false, detail: `ip-resolve-failed: ${(err as Error).message}` };
  }

  console.log(`\n========== ${key.business_id} (vps ${key.hostinger_vps_id} @ ${ip}) ==========`);
  if (DRY_RUN) {
    console.log(`[reseed] dry-run — would set ${AGENT} -> ${MODEL} (keyless-degraded on a keyless box)`);
    return { ...base, ip, ok: true, detail: "dry-run" };
  }

  try {
    const res = await sshExec({
      host: ip,
      username: key.ssh_username || "root",
      privateKeyPem: key.private_key_pem,
      command: remote,
      timeoutMs: 5 * 60 * 1000,
      onStdout: (c) => process.stdout.write(prefix(key.business_id, c)),
      onStderr: (c) => process.stderr.write(prefix(key.business_id, c))
    });
    const ok = res.exitCode === 0;
    return { ...base, ip, ok, detail: ok ? "ok" : `exitCode=${res.exitCode}` };
  } catch (err) {
    return { ...base, ip, ok: false, detail: `ssh-failed: ${(err as Error).message}` };
  }
}

const results: Outcome[] = [];
let cursor = 0;
async function pool(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= keys.length) return;
    results[i] = await patchOne(keys[i]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => pool()));

console.log("\n================ SUMMARY ================");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `  [${r.ok ? "OK  " : "FAIL"}] ${r.businessId} (vps ${r.vpsId}${r.ip ? ` @ ${r.ip}` : ""}) — ${r.detail}`
  );
}
console.log(`[reseed] ${results.length - failed}/${results.length} succeeded`);
process.exit(failed === 0 ? 0 : 1);
