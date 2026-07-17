/**
 * Live classify-step probe: matrix-walks a set of lead replies through the
 * REAL deployed classify prompt (buildClassifyPrompt from the edge engine)
 * against real Gemini, and prints ok/MISS per case. Used to validate category
 * tightenings (e.g. "wants_a_call" vs "gave_info") before patching tenant
 * flows.
 *
 * Edit CATS/CASES in place for the categories under test — the value of the
 * probe is pinning the exact wording, so the cases live in the file rather
 * than flags.
 *
 * Requires GOOGLE_API_KEY in the repo-root .env. ⚠️ Small real Gemini spend
 * (one flash-lite call per case); no tenant writes.
 *
 * Usage: tsx debug/classify-probe.ts
 */
import { loadEnv } from "./_shared.ts";
import { buildClassifyPrompt } from "../supabase/functions/_shared/ai_flows/engine.ts";

loadEnv();

const KEY = process.env.GOOGLE_API_KEY ?? "";
if (!KEY) throw new Error("GOOGLE_API_KEY missing");

const CATS = [
  {
    value: "wants_a_call",
    description:
      "explicitly asks for a call or conversation (e.g. 'call me', 'can someone call', " +
      "'let's talk', asks to book or schedule a time). Merely stating what coverage or " +
      "help they need is NOT this category."
  },
  { value: "not_interested", description: "declines, says they're all set, or asks to stop texting" },
  {
    value: "gave_info",
    description:
      "answered the question or shared their situation - what coverage they need, " +
      "renewal timing, a date, or other details"
  }
];

const RENEWAL_Q =
  "An insurance lead was just asked approximately when their current policy renews. This is their reply.";
const REPLY3_Q =
  "An insurance lead went quiet, received a final check-in about reviewing their options, and this is their eventual reply.";

const CASES: Array<[string, string, string]> = [
  [RENEWAL_Q, "July 23, 2026", "gave_info"],
  [RENEWAL_Q, "I want to reschedule appointment ", "wants_a_call"],
  [RENEWAL_Q, "Can someone call me right now", "wants_a_call"],
  [RENEWAL_Q, "Actually I'm all set, please stop texting", "not_interested"],
  [REPLY3_Q, "Sorry for the delay - yes I'm still interested", "gave_info"],
  [REPLY3_Q, "Can someone call me right now", "wants_a_call"],
  [REPLY3_Q, "Please don't contact me again", "not_interested"]
];

async function classify(question: string, msg: string, attempt = 0): Promise<string> {
  const prompt = buildClassifyPrompt(CATS, msg, question);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      })
    }
  );
  if (res.status === 503 || res.status === 429) {
    if (attempt >= 5) throw new Error(`gemini still ${res.status} after ${attempt + 1} attempts`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return classify(question, msg, attempt + 1);
  }
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return (JSON.parse(text) as { category?: string }).category ?? "??";
  } catch {
    return `unparseable: ${text.slice(0, 60)}`;
  }
}

for (const [q, msg, want] of CASES) {
  const got = await classify(q, msg);
  console.log(`${got === want ? "ok  " : "MISS"} got=${got.padEnd(14)} want=${want.padEnd(14)} "${msg}"`);
}
