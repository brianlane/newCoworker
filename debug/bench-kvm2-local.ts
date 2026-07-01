/**
 * Benchmark runner — KVM2-profile local emulation (llama3.2:3b under the
 * docker-compose.kvm2.yml resource caps: 2 CPUs / 8 GB, OLLAMA_NUM_PARALLEL=1,
 * q4_0 KV cache, flash attention — the same knobs bootstrap.sh sets on a
 * real starter box).
 *
 * Replays the SAME reconstructed /dashboard/chat prompts as bench-local.ts
 * (Amy's owner instructions + memory from debug/.bench-context.json), so the
 * numbers are directly comparable to debug/.bench-results-local.json (the
 * production KVM8 qwen3:4b-instruct run).
 *
 * Prereq: `npm run integration:up-kvm2` (or at least the ollama service
 * healthy on 127.0.0.1:11134).
 *
 * Writes debug/.bench-results-kvm2-local.json.
 * Usage: tsx debug/bench-kvm2-local.ts [modelTag]
 */
import fs from "node:fs";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { buildPrompt, QUESTION, scoreReply } from "./bench-prompts.ts";

// Node fetch (undici) defaults headersTimeout to 5 min; Ollama doesn't send
// response headers until the first token is ready, and a capped-CPU cold
// prefill can exceed that. Disable both idle timeouts for this bench. The
// Agent must be paired with the SAME undici's fetch (Node's built-in fetch
// rejects a dispatcher from the npm package with a bare "fetch failed").
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const OLLAMA = process.env.KVM2_OLLAMA_URL ?? "http://127.0.0.1:11134";
const MODEL = process.argv[2] ?? "llama3.2:3b";

// Same cells as bench-local.ts so rows line up 1:1 with the KVM8 run.
// KVM2_BENCH_QUICK=1 runs only the base stateless cell (cold + warm rep) —
// needed on laptop Docker where the VM's CPU throughput makes each cold
// prefill take ~20 min, so the full matrix would run for hours.
const QUICK = process.env.KVM2_BENCH_QUICK === "1";
const CELLS = QUICK
  ? [{ mode: "stateless" as const, history: 2, reps: 2 }]
  : [
      { mode: "stateless" as const, history: 2, reps: 2 },
      { mode: "stateful" as const, history: 2, reps: 2 },
      { mode: "stateful" as const, history: 20, reps: 1 },
      { mode: "stateful" as const, history: 40, reps: 1 },
      { mode: "stateless" as const, history: 40, reps: 1 }
    ];

async function ensureModel(): Promise<void> {
  const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
  const have = (tags.models ?? []).some((m: any) => m.name === MODEL || m.model === MODEL);
  if (have) {
    console.log(`[bench-kvm2] model ${MODEL} already present`);
    return;
  }
  console.log(`[bench-kvm2] pulling ${MODEL} (streaming)...`);
  const res = await fetch(`${OLLAMA}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true })
  });
  if (!res.ok || !res.body) throw new Error(`pull failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let lastStatus = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.status && j.status !== lastStatus) {
          lastStatus = j.status;
          console.log(`  pull: ${j.status}`);
        }
        if (j.error) throw new Error(`pull error: ${j.error}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("pull error")) throw e;
      }
    }
  }
  console.log(`[bench-kvm2] pull complete`);
}

type ChatResult = {
  ok: boolean;
  wallMs: number;
  reply?: string;
  totalNs?: number;
  loadNs?: number;
  promptTokens?: number;
  promptNs?: number;
  evalTokens?: number;
  evalNs?: number;
  error?: string;
};

// num_ctx=4096 matches a REAL starter box: bootstrap.sh does NOT raise
// OLLAMA_CONTEXT_LENGTH for starter and the llm-router /v1 path can't pass
// num_ctx per request, so Ollama's default (4096) is the effective ceiling.
// (The KVM8 bench used 16384; Amy's base owner-chat prompt is ~2.8k tokens so
// it fits either way, but 40-message stateful threads would TRUNCATE here.)
const NUM_CTX = Number(process.env.KVM2_BENCH_NUM_CTX ?? "4096");

async function call(messages: { role: string; content: string }[]): Promise<ChatResult> {
  const t0 = Date.now();
  // Streamed so slow CPU prefill can't trip request-idle timeouts anywhere.
  const res = await undiciFetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      options: { temperature: 0, num_ctx: NUM_CTX },
      messages
    }),
    signal: AbortSignal.timeout(45 * 60 * 1000),
    dispatcher
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    return { ok: false, wallMs: Date.now() - t0, error: `http_${res.status}:${t.slice(0, 200)}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let reply = "";
  let final: any = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (j.error) return { ok: false, wallMs: Date.now() - t0, error: String(j.error).slice(0, 200) };
      if (j.message?.content) reply += j.message.content;
      if (j.done) final = j;
    }
  }
  const wallMs = Date.now() - t0;
  return {
    ok: reply.length > 0,
    wallMs,
    reply,
    totalNs: final?.total_duration || 0,
    loadNs: final?.load_duration || 0,
    promptTokens: final?.prompt_eval_count || 0,
    promptNs: final?.prompt_eval_duration || 0,
    evalTokens: final?.eval_count || 0,
    evalNs: final?.eval_duration || 0
  };
}

await ensureModel();

console.log(`== KVM2-profile benchmark: ${MODEL} @ ${OLLAMA} ==`);
console.log(`question: "${QUESTION}"  cells: ${CELLS.length}  total gens: ${CELLS.reduce((n, c) => n + c.reps, 0)}`);

// Warmup so load_duration doesn't pollute the first measured cell.
try {
  await call([{ role: "user", content: "hi" }]);
} catch {
  /* warmup best-effort */
}

const rows: any[] = [];
for (const c of CELLS) {
  const built = buildPrompt(c.mode, c.history);
  for (let rep = 0; rep < c.reps; rep++) {
    let r: ChatResult;
    try {
      r = await call(built.messages);
    } catch (e: any) {
      r = { ok: false, wallMs: -1, error: String(e?.message ?? e) };
    }
    const reply = r.reply ?? "";
    const { correct, refused } = scoreReply(reply);
    const row = {
      mode: c.mode,
      history: c.history,
      rep,
      approxChars: built.approxChars,
      ok: r.ok,
      wallMs: r.wallMs,
      totalNs: r.totalNs ?? null,
      loadNs: r.loadNs ?? null,
      promptTokens: r.promptTokens ?? null,
      promptNs: r.promptNs ?? null,
      evalTokens: r.evalTokens ?? null,
      evalNs: r.evalNs ?? null,
      correct,
      refused,
      error: r.error ?? null,
      replyPreview: reply.slice(0, 240),
      prefillTokPerSec: r.promptTokens && r.promptNs ? +(r.promptTokens / (r.promptNs / 1e9)).toFixed(2) : null,
      decodeTokPerSec: r.evalTokens && r.evalNs ? +(r.evalTokens / (r.evalNs / 1e9)).toFixed(2) : null,
      wouldTimeout: r.wallMs > 240_000,
      model: `${MODEL} (KVM2-profile: 2cpu/8GB local emulation)`
    };
    rows.push(row);
    console.log(
      `  ${row.mode}@${row.history} r${row.rep}: ${row.ok ? "ok" : "FAIL"} wall=${row.wallMs}ms prefill=${row.promptTokens}tok@${row.prefillTokPerSec}t/s decode=${row.evalTokens}tok@${row.decodeTokPerSec}t/s correct=${row.correct} refused=${row.refused} timeout=${row.wouldTimeout}${row.error ? ` error=${row.error}` : ""}`
    );
    if (row.replyPreview) console.log(`    reply: ${row.replyPreview.slice(0, 160)}`);
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  profile: "kvm2-local-emulation (docker: cpus=2.0, memory=8G, OLLAMA_NUM_PARALLEL=1, kv=q4_0, flash-attn)",
  model: MODEL,
  question: QUESTION,
  workerRowboatTimeoutMs: 240_000,
  numCtx: NUM_CTX,
  contextCeilingNote:
    "Real starter boxes do not raise OLLAMA_CONTEXT_LENGTH (default 4096); the llm-router /v1 path cannot pass num_ctx, so prompts past ~4k tokens get TRUNCATED on real KVM2. Bench default matches (KVM2_BENCH_NUM_CTX to override).",
  rows
};
const OUT = path.resolve(process.cwd(), "debug/.bench-results-kvm2-local.json");
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n[bench-kvm2] ${rows.length} rows -> ${OUT}`);
