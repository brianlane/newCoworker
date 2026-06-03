/**
 * Read-only probe of the owner-rule extractor against a tenant's LIVE Ollama.
 *
 * Builds the extraction request with the CURRENT repo prompt
 * (vps/chat-worker/memory-capture.mjs) and runs a set of scenarios through the
 * worker container's Ollama (`docker exec chat-worker` → host.docker.internal).
 * It does NOT touch memory — purely classifies — so it's safe to run against a
 * candidate prompt before deploying. Prints save/bullets per scenario and a
 * PASS/FAIL vs the expected classification.
 *
 * Usage:
 *   tsx debug/probe-extraction.ts [businessId]
 */
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const MODEL = process.env.MEMORY_CAPTURE_MODEL || "qwen3:4b-instruct";

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const { buildExtractionRequestBody, parseMemoryExtraction } = await import(
  "../vps/chat-worker/memory-capture.mjs"
);

type Scenario = {
  label: string;
  expectSave: boolean;
  ownerMessage: string;
  assistantReply?: string;
  existingBullets?: string[];
};

const scenarios: Scenario[] = [
  {
    label: "agent numbers + escalation (the message that failed)",
    expectSave: true,
    ownerMessage:
      "Add these numbers to the agents for memory: Gabrielle Mota 480-720-2013 and Dave Lane 602-524-5719 then change the escalation from Brian Lane to Amy Laidlaw 602-695-1142",
    assistantReply:
      "Gabrielle Mota: 480-720-2013\nDave Lane: 602-524-5719\n\nEscalation updated to Amy Laidlaw at 602-695-1142.\n\nAll changes have been applied to the business memory."
  },
  {
    label: "question about lead handling (should NOT save)",
    expectSave: false,
    ownerMessage: "When you receive a new lead, what are you supposed to do?",
    assistantReply: "When a new lead comes in, I confirm contact info and gather the key details..."
  },
  {
    label: "plain behavior rule (should save)",
    expectSave: true,
    ownerMessage: "From now on, never discuss budget with customers.",
    assistantReply: "Got it — I'll never discuss budget with customers."
  },
  {
    // The 4B model is unreliable at self-suppressing duplicates, so we expect
    // it MAY still propose this — the authoritative guarantee against
    // double-saving lives in the owner-append adapter's deterministic dedup,
    // not here. This scenario documents that the model echoes a known dup;
    // the adapter is what drops it on write.
    label: "duplicate of an already-saved rule (adapter dedups on write)",
    expectSave: true,
    ownerMessage: "Just to confirm, never discuss budget with customers.",
    assistantReply: "Confirmed — never discuss budget with customers.",
    existingBullets: ["Never discuss budget with customers"]
  }
];

const payload = scenarios.map((s) => ({
  label: s.label,
  body: buildExtractionRequestBody(MODEL, s.ownerMessage, {
    assistantReply: s.assistantReply,
    existingBullets: s.existingBullets
  })
}));
const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");

// Single line on purpose: this is passed as `node -e "<script>"` over SSH, and
// inside bash double-quotes a literal "\n" would reach node as backslash-n
// (a syntax error) rather than a newline.
const containerScript =
  'let raw="";process.stdin.on("data",c=>raw+=c).on("end",async()=>{const items=JSON.parse(raw);const out=[];for(const it of items){try{const r=await fetch("http://host.docker.internal:11434/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(it.body)});const j=await r.json();out.push({label:it.label,content:(j.message&&j.message.content)||("ERR:"+JSON.stringify(j).slice(0,200))});}catch(e){out.push({label:it.label,content:"ERR:"+e.message});}}console.log("PROBE_RESULT_START");console.log(JSON.stringify(out));console.log("PROBE_RESULT_END");});';

const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const ip = await resolveVpsIp(makeHostingerClient(), key);
console.log(`[probe] business=${BUSINESS_ID} ip=${ip} model=${MODEL} scenarios=${scenarios.length}`);

const remote = `echo ${b64} | base64 -d | docker exec -i chat-worker node -e ${JSON.stringify(
  containerScript
)}`;

let buf = "";
const res = await sshExec({
  host: ip,
  username: key.ssh_username || "root",
  privateKeyPem: key.private_key_pem,
  command: remote,
  timeoutMs: 5 * 60 * 1000,
  onStdout: (c) => {
    buf += c;
  },
  onStderr: (c) => process.stderr.write(c)
});

const m = /PROBE_RESULT_START\s*([\s\S]*?)\s*PROBE_RESULT_END/.exec(buf);
if (!m) {
  console.error("[probe] no result block found. Raw output:\n" + buf.slice(0, 2000));
  process.exit(1);
}
const results: { label: string; content: string }[] = JSON.parse(m[1]);

let failures = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const expect = scenarios[i].expectSave;
  const parsed = parseMemoryExtraction(r.content);
  const ok = parsed.save === expect;
  if (!ok) failures++;
  console.log(`\n— ${r.label}`);
  console.log(`  expected save=${expect}  →  got save=${parsed.save}  ${ok ? "PASS" : "FAIL"}`);
  if (parsed.bullets.length) console.log(`  bullets: ${JSON.stringify(parsed.bullets)}`);
  else console.log(`  raw: ${r.content.slice(0, 200)}`);
}

console.log(`\n[probe] ${results.length - failures}/${results.length} scenarios matched expectation`);
process.exit(res.exitCode === 0 && failures === 0 ? 0 : 1);
