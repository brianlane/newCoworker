/**
 * Benchmark runner — LOCAL model (qwen3:4b-instruct on the tenant VPS).
 *
 * This is the "current setup" model. We can't reach the box's Ollama from a
 * laptop (loopback/docker-bridge bound), so we SSH in and run ONE remote node
 * script inside the chat-worker container that loops the cells, POSTing the
 * reconstructed /dashboard/chat prompts to http://host.docker.internal:11434
 * /api/chat (native, so we get prefill vs decode timing breakdown).
 *
 * num_ctx=16384 to match production. Records prompt_eval (prefill) and eval
 * (decode) token counts + durations, total wall time, correctness, and
 * whether the turn would blow the worker's 240s Rowboat timeout.
 *
 * Writes debug/.bench-results-local.json. Usage: tsx debug/bench-local.ts [businessId]
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
import { buildPrompt, QUESTION, EXPECTED_ANSWERS } from "./bench-prompts.ts";

loadEnv();
const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

// Cells: the base 2-message scenario (stateless + stateful) plus aged-thread
// stateful points to show prefill blowing past the 240s worker timeout, and a
// stateless@40 control to confirm stateless stays flat. reps kept low because
// each qwen generation is minutes on CPU.
const CELLS = [
  { mode: "stateless" as const, history: 2, reps: 2 },
  { mode: "stateful" as const, history: 2, reps: 2 },
  { mode: "stateful" as const, history: 20, reps: 1 },
  { mode: "stateful" as const, history: 40, reps: 1 },
  { mode: "stateless" as const, history: 40, reps: 1 }
];

const cells = CELLS.map((c) => {
  const built = buildPrompt(c.mode, c.history);
  return { mode: c.mode, history: c.history, reps: c.reps, messages: built.messages, approxChars: built.approxChars };
});

const cellsJson = JSON.stringify(cells);
const expectedJson = JSON.stringify(EXPECTED_ANSWERS);

// Remote node script (runs inside chat-worker container). Reads cells from
// /tmp, warms the model once, then times each cell/rep against Ollama.
const remoteScript = `
const fs = require('fs');
const cells = JSON.parse(fs.readFileSync('/tmp/bench-cells.json','utf8'));
const expected = ${expectedJson};
const MODEL = 'qwen3:4b-instruct';
const URL = 'http://host.docker.internal:11434/api/chat';
const norm = (s) => (s||'').replace(/[^0-9a-z]/gi,'').toLowerCase();
async function call(messages){
  const t0 = Date.now();
  const res = await fetch(URL, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ model: MODEL, stream:false, options:{ temperature:0, num_ctx:16384 }, messages }) });
  const wallMs = Date.now()-t0;
  if(!res.ok){ const t = await res.text().catch(()=>''); return { ok:false, wallMs, error:'http_'+res.status+':'+t.slice(0,160) }; }
  const d = await res.json();
  const reply = (d && d.message && d.message.content) ? d.message.content : '';
  return { ok: reply.length>0, wallMs, reply,
    totalNs: d.total_duration||0, loadNs: d.load_duration||0,
    promptTokens: d.prompt_eval_count||0, promptNs: d.prompt_eval_duration||0,
    evalTokens: d.eval_count||0, evalNs: d.eval_duration||0 };
}
(async()=>{
  // Warmup so load_duration doesn't pollute the first measured cell.
  try { await call([{role:'user',content:'hi'}]); } catch(e){}
  for(const c of cells){
    for(let rep=0; rep<c.reps; rep++){
      let r;
      try { r = await call(c.messages); } catch(e){ r = { ok:false, error: String(e&&e.message||e) }; }
      const reply = r.reply||'';
      const correct = expected.some(a => norm(reply).includes(norm(a)));
      const refused = /don't have|do not have|no access|can't share|cannot share|check your crm|unable to/i.test(reply);
      const out = { mode:c.mode, history:c.history, rep, approxChars:c.approxChars,
        ok:!!r.ok, wallMs:r.wallMs||null, totalNs:r.totalNs||null, loadNs:r.loadNs||null,
        promptTokens:r.promptTokens||null, promptNs:r.promptNs||null,
        evalTokens:r.evalTokens||null, evalNs:r.evalNs||null,
        correct, refused, error:r.error||null, replyPreview: reply.slice(0,240) };
      console.log('RESULT:'+JSON.stringify(out));
    }
  }
  console.log('DONE');
})();
`;

// Heredoc-safe: cellsJson is single-line JSON (no raw newlines). The node
// script has no literal $(...) we need expanded; quoted heredoc keeps it raw.
const remote = `
set -uo pipefail
cat > /tmp/bench-cells.json <<'CELLS_EOF'
${cellsJson}
CELLS_EOF
cat > /tmp/bench-run.js <<'JS_EOF'
${remoteScript}
JS_EOF
docker cp /tmp/bench-cells.json chat-worker:/tmp/bench-cells.json >/dev/null
docker cp /tmp/bench-run.js chat-worker:/tmp/bench-run.js >/dev/null
echo "== running qwen benchmark (this takes several minutes) =="
docker exec chat-worker node /tmp/bench-run.js
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);

console.log(`== Local qwen benchmark on ${ip} ==`);
console.log(`question: "${QUESTION}"  cells: ${cells.length}  total gens: ${CELLS.reduce((n, c) => n + c.reps, 0)}`);

let buf = "";
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 30 * 60 * 1000,
  onStdout: (c) => {
    buf += c;
    process.stdout.write(c);
  },
  onStderr: (c) => process.stderr.write(c)
});

const rows = buf
  .split(/\r?\n/)
  .filter((l) => l.startsWith("RESULT:"))
  .map((l) => {
    try {
      return JSON.parse(l.slice("RESULT:".length));
    } catch {
      return null;
    }
  })
  .filter(Boolean) as any[];

// Derive throughput.
for (const r of rows) {
  r.prefillTokPerSec = r.promptTokens && r.promptNs ? +(r.promptTokens / (r.promptNs / 1e9)).toFixed(2) : null;
  r.decodeTokPerSec = r.evalTokens && r.evalNs ? +(r.evalTokens / (r.evalNs / 1e9)).toFixed(2) : null;
  r.wouldTimeout = typeof r.wallMs === "number" ? r.wallMs > 240_000 : null;
  r.model = "qwen3:4b-instruct (local CPU)";
}

const out = {
  generatedAt: new Date().toISOString(),
  businessId: BUSINESS_ID,
  vps: ip,
  model: "qwen3:4b-instruct",
  question: QUESTION,
  workerRowboatTimeoutMs: 240_000,
  rows
};
const OUT = path.resolve(process.cwd(), "debug/.bench-results-local.json");
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n[bench-local] exit ${res.exitCode}; ${rows.length} rows -> ${OUT}`);
for (const r of rows) {
  console.log(
    `  ${r.mode}@${r.history} r${r.rep}: ${r.ok ? "ok" : "FAIL"} wall=${r.wallMs}ms prefill=${r.promptTokens}tok@${r.prefillTokPerSec}t/s decode=${r.evalTokens}tok@${r.decodeTokPerSec}t/s correct=${r.correct} timeout=${r.wouldTimeout}`
  );
}
process.exit(res.exitCode === 0 ? 0 : 1);
