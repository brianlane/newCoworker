/**
 * Benchmark runner — CLOUD models (run from a laptop; needs internet + keys).
 *
 *   - Gemini 2.5 Flash-Lite  via native generateContent (GOOGLE_API_KEY)
 *   - DeepSeek V4 Flash      via OpenRouter chat/completions (ORkey)
 *
 * Feeds each model the EXACT reconstructed /dashboard/chat prompt (see
 * bench-prompts.ts) for a matrix of {mode} x {thread age} x {reps}, measuring
 * wall-clock latency, token usage, $ cost, and answer correctness (nickname
 * recall). Writes debug/.bench-results-cloud.json.
 *
 * Usage: tsx debug/bench-cloud.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./_shared.ts";
import { buildPrompt, scoreReply, QUESTION, type Msg } from "./bench-prompts.ts";

loadEnv();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
const OPENROUTER_KEY = process.env.ORkey ?? process.env.OPENROUTER_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash";
const REPS = 3;

// {mode, historyMessages} cells. The first two are the user's "conversation
// that already has 2 messages"; the rest sweep thread age to expose how
// stateful prompt size (and thus latency) diverges from stateless.
const CELLS: { mode: "stateless" | "stateful"; history: number }[] = [
  { mode: "stateless", history: 2 },
  { mode: "stateful", history: 2 },
  { mode: "stateful", history: 10 },
  { mode: "stateful", history: 20 },
  { mode: "stateful", history: 40 },
  { mode: "stateless", history: 40 }
];

// Published list prices, USD per 1M tokens. DeepSeek's is overwritten live
// from the OpenRouter models API below; Gemini's is the documented rate.
const RATES: Record<string, { in: number; out: number; note: string }> = {
  [GEMINI_MODEL]: { in: 0.1, out: 0.4, note: "Google list price gemini-2.5-flash-lite" },
  [DEEPSEEK_MODEL]: { in: 0, out: 0, note: "from OpenRouter models API (filled at runtime)" }
};

async function fetchOpenRouterPricing(): Promise<void> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` }
    });
    const j = (await r.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
    const m = (j.data ?? []).find((x) => x.id === DEEPSEEK_MODEL);
    if (m?.pricing) {
      // pricing is USD per token; convert to per-1M.
      RATES[DEEPSEEK_MODEL] = {
        in: Number(m.pricing.prompt ?? 0) * 1e6,
        out: Number(m.pricing.completion ?? 0) * 1e6,
        note: `OpenRouter live pricing ${DEEPSEEK_MODEL}`
      };
      console.log(`  deepseek pricing: $${RATES[DEEPSEEK_MODEL].in}/1M in, $${RATES[DEEPSEEK_MODEL].out}/1M out`);
    } else {
      console.log(`  WARN: ${DEEPSEEK_MODEL} not found in OpenRouter model list`);
    }
  } catch (e) {
    console.log("  WARN: could not fetch OpenRouter pricing:", (e as Error).message);
  }
}

type CallResult = {
  ok: boolean;
  wallMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reply: string;
  error?: string;
};

async function callGemini(messages: Msg[]): Promise<CallResult> {
  const systemInstruction = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
      })
    });
    const wallMs = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, wallMs, promptTokens: null, completionTokens: null, reply: "", error: `http_${res.status}:${txt.slice(0, 160)}` };
    }
    const j = (await res.json()) as any;
    const reply = (j?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    const um = j?.usageMetadata ?? {};
    return {
      ok: reply.length > 0,
      wallMs,
      promptTokens: um.promptTokenCount ?? null,
      completionTokens: um.candidatesTokenCount ?? null,
      reply,
      error: reply.length > 0 ? undefined : "empty"
    };
  } catch (e) {
    return { ok: false, wallMs: Date.now() - t0, promptTokens: null, completionTokens: null, reply: "", error: (e as Error).message };
  }
}

async function callDeepSeek(messages: Msg[]): Promise<CallResult> {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://newcoworker.app",
        "X-Title": "New Coworker Benchmark"
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.2,
        max_tokens: 512,
        reasoning: { enabled: false, effort: "minimal", exclude: true },
        messages
      })
    });
    const wallMs = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, wallMs, promptTokens: null, completionTokens: null, reply: "", error: `http_${res.status}:${txt.slice(0, 160)}` };
    }
    const j = (await res.json()) as any;
    const reply = (j?.choices?.[0]?.message?.content ?? "").trim();
    const u = j?.usage ?? {};
    return {
      ok: reply.length > 0,
      wallMs,
      promptTokens: u.prompt_tokens ?? null,
      completionTokens: u.completion_tokens ?? null,
      reply,
      error: reply.length > 0 ? undefined : "empty"
    };
  } catch (e) {
    return { ok: false, wallMs: Date.now() - t0, promptTokens: null, completionTokens: null, reply: "", error: (e as Error).message };
  }
}

function costUsd(model: string, p: number | null, c: number | null): number | null {
  const r = RATES[model];
  if (!r || p === null || c === null) return null;
  return (p / 1e6) * r.in + (c / 1e6) * r.out;
}

async function runModel(
  modelLabel: string,
  modelId: string,
  caller: (m: Msg[]) => Promise<CallResult>
) {
  const rows: any[] = [];
  for (const cell of CELLS) {
    const built = buildPrompt(cell.mode, cell.history);
    for (let rep = 0; rep < REPS; rep++) {
      const r = await caller(built.messages);
      const sc = scoreReply(r.reply);
      rows.push({
        model: modelLabel,
        modelId,
        mode: cell.mode,
        historyMessages: cell.history,
        approxPromptChars: built.approxChars,
        rep,
        ok: r.ok,
        wallMs: r.wallMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: costUsd(modelId, r.promptTokens, r.completionTokens),
        correct: sc.correct,
        refused: sc.refused,
        error: r.error ?? null,
        replyPreview: r.reply.slice(0, 240)
      });
      const tag = `${modelLabel} ${cell.mode}@${cell.history} r${rep}`;
      console.log(
        `  ${tag}: ${r.ok ? "ok" : "FAIL"} ${r.wallMs}ms ptok=${r.promptTokens} ctok=${r.completionTokens} correct=${sc.correct}${r.error ? " err=" + r.error : ""}`
      );
    }
  }
  return rows;
}

console.log("== Cloud benchmark ==");
console.log(`gemini key: ${GOOGLE_API_KEY ? "set" : "MISSING"}  openrouter key: ${OPENROUTER_KEY ? "set" : "MISSING"}`);
console.log(`question: "${QUESTION}"`);
await fetchOpenRouterPricing();

const all: any[] = [];
console.log(`\n-- ${GEMINI_MODEL} --`);
all.push(...(await runModel("Gemini 2.5 Flash-Lite", GEMINI_MODEL, callGemini)));
console.log(`\n-- ${DEEPSEEK_MODEL} --`);
all.push(...(await runModel("DeepSeek V4 Flash", DEEPSEEK_MODEL, callDeepSeek)));

const out = {
  generatedAt: new Date().toISOString(),
  question: QUESTION,
  reps: REPS,
  rates: RATES,
  rows: all
};
const OUT = path.resolve(process.cwd(), "debug/.bench-results-cloud.json");
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\nwrote ${OUT} (${all.length} rows)`);
