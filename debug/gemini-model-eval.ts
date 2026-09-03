/**
 * Discover newer Gemini GA ids than our worker pins and say whether to adopt.
 *
 * Reads Google's models.list. Does not take a model name: if 3.8 Flash (or
 * whatever ships next) is on the API and newer than a pin, it shows up here.
 *
 *   npx tsx debug/gemini-model-eval.ts
 *   npx tsx debug/gemini-model-eval.ts --json
 *
 * Exit 0: nothing newer than the pins.
 * Exit 2: at least one adopt or wait verdict (open/update the tracking issue).
 * Exit 1: crash or missing GOOGLE_API_KEY.
 */
import { writeFileSync } from "node:fs";
import { loadEnv } from "./_shared.ts";
import { GEMINI_PRICES_PER_1M } from "../src/lib/billing/ai-spend-meter.ts";
import { GEMINI_MODEL_PINS } from "../src/lib/gemini-model-pins.ts";
import {
  classifyThinkingProbe,
  evaluateListedModels,
  findNewerCandidates,
  formatEvalReport,
  parsePublishedGeminiPrices,
  reportHasAdopt,
  reportHasWait,
  type CandidateProbe,
  type GeminiPrice
} from "../src/lib/gemini-model-eval.ts";

loadEnv();

const GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

function textPrices(): Record<string, GeminiPrice> {
  const out: Record<string, GeminiPrice> = {};
  for (const [k, v] of Object.entries(GEMINI_PRICES_PER_1M)) {
    out[k] = { in: v.in, out: v.out };
  }
  return out;
}

async function listGeminiModels(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const url = new URL(GENERATE_URL);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url);
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      models?: Array<{ name?: string }>;
      nextPageToken?: string;
    };
    if (!res.ok) {
      throw new Error(`models.list HTTP ${res.status}: ${body.error?.message ?? res.statusText}`);
    }
    for (const m of body.models ?? []) {
      const name = (m.name ?? "").replace(/^models\//, "");
      if (name.startsWith("gemini-")) ids.push(name);
    }
    pageToken = body.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return ids;
}

async function probeGenerate(
  apiKey: string,
  model: string,
  thinkingLevel?: "minimal" | "low"
): Promise<{ status: number; body: string }> {
  const url = `${GENERATE_URL}/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with the single word pong." }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {})
      }
    })
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

async function probeOpenAi(apiKey: string, model: string): Promise<{ status: number; body: string }> {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word pong." }],
      max_tokens: 16,
      temperature: 0
    })
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

async function probeCandidate(apiKey: string, model: string, listed: boolean): Promise<CandidateProbe> {
  const plain = await probeGenerate(apiKey, model);
  const minimal = await probeGenerate(apiKey, model, "minimal");
  const low = await probeGenerate(apiKey, model, "low");
  const openai = await probeOpenAi(apiKey, model);
  return {
    model,
    listed,
    generateContent: {
      ok: plain.status >= 200 && plain.status < 300,
      status: plain.status,
      excerpt: plain.body.slice(0, 180)
    },
    openAiCompat: {
      ok: openai.status >= 200 && openai.status < 300,
      status: openai.status,
      excerpt: openai.body.slice(0, 180)
    },
    thinkingMinimal: classifyThinkingProbe(minimal.status, minimal.body),
    thinkingLow: classifyThinkingProbe(low.status, low.body)
  };
}

async function fetchPublishedPrices(): Promise<Record<string, GeminiPrice>> {
  try {
    const res = await fetch(PRICING_URL, {
      headers: { "user-agent": "gemini-model-eval/1.0" }
    });
    if (!res.ok) return {};
    return parsePublishedGeminiPrices(await res.text());
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const apiKey = (process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("gemini-model-eval: GOOGLE_API_KEY is not set (use the internal-ci-debug key).");
    return 1;
  }

  const listed = await listGeminiModels(apiKey);
  const published = await fetchPublishedPrices();
  const newer = findNewerCandidates(listed, GEMINI_MODEL_PINS);
  const probes: Record<string, CandidateProbe> = {};
  for (const id of newer) {
    console.error(`gemini-model-eval: probing ${id}`);
    probes[id] = await probeCandidate(apiKey, id, true);
  }

  const report = evaluateListedModels({
    listedIds: listed,
    pins: GEMINI_MODEL_PINS,
    probes,
    prices: textPrices(),
    published,
    generatedAt: new Date().toISOString()
  });

  const markdown = formatEvalReport(report);
  const wantJson = process.argv.includes("--json");
  const outPath = argValue("--out");
  if (wantJson) {
    const payload = JSON.stringify(report, null, 2);
    if (outPath) writeFileSync(outPath, payload);
    else console.log(payload);
  } else {
    if (outPath) writeFileSync(outPath, markdown);
    console.log(markdown);
  }

  if (reportHasAdopt(report) || reportHasWait(report)) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
