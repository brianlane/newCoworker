/**
 * Live Gemini client for the e2e suite — the REAL model, not a mock.
 *
 * Why this exists: the reply-reasoning trailer leaked to a real customer
 * because unit tests exercise our parsing with strings we wrote, while the
 * bug was in what the MODEL actually emits (it mangled the ⟦reasoning⟧
 * marker). Only a live call catches that class. These helpers mirror the
 * production call shapes:
 *
 *  - `geminiJson` — byte-matches ai-flow-worker's geminiJsonForPrompt config
 *    (temperature 0, responseMimeType application/json, same default model)
 *    so classify/extract e2e results are what the worker would get.
 *  - `geminiChatReply` — a system-instructed multi-turn text reply, the shape
 *    of the SMS assistant turn (temperature 0 for CI stability).
 *
 * Bounded transient retry mirrors the worker's fetchWithTransientRetry.
 */

import { recordRawUsage, type RawUsageMetadata } from "./usage-log";

/**
 * Same default the ai-flow-worker uses for extract/classify (bumped with
 * the Jul 21 2026 fleet migration, PR #809) — also the fleet's
 * SMS_CHAT_MODEL default, so `geminiChatReply` exercises the tenant model.
 */
export const E2E_GEMINI_MODEL = process.env.AIFLOW_EXTRACT_MODEL ?? "gemini-3.5-flash-lite";

/**
 * 5 attempts with 1s/2s/4s/8s backoff (~15s worst case). The old
 * 3-attempt/~1.5s policy lost a whole CI run to a sustained "high demand"
 * 503 spike (main push 2026-07-16); the suite runs file-serial, so the
 * longer waits cost time only during an actual capacity incident.
 */
const MAX_ATTEMPTS = 5;

export function transientBackoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

export function requireGeminiKey(): string {
  const key = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "e2e requires GOOGLE_API_KEY (or GEMINI_API_KEY) — locally: source .env; CI: repo secret."
    );
  }
  return key;
}

type GeminiBody = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    safetyRatings?: unknown;
  }>;
  promptFeedback?: unknown;
  usageMetadata?: RawUsageMetadata;
  error?: { message?: string };
};

async function generateContent(
  payload: Record<string, unknown>,
  model: string = E2E_GEMINI_MODEL,
  opts: { retryEmptyOnce?: boolean } = {}
): Promise<string> {
  const key = requireGeminiKey();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    `:generateContent?key=${encodeURIComponent(key)}`;
  let lastErr: unknown;
  // Mirrors the production llm-router's empty-completion retry (PR #766):
  // a stuck Gemini can return HTTP 200 with no text at all. The router
  // retries the upstream ONCE on the chat path; a second empty response is
  // surfaced as-is (the test then fails honestly).
  let emptyRetryLeft = opts.retryEmptyOnce ? 1 : 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const transient = res.status === 429 || res.status >= 500;
      if (!res.ok && transient && attempt < MAX_ATTEMPTS) {
        await res.text().catch(() => {});
        await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
        continue;
      }
      const body = (await res.json()) as GeminiBody;
      if (!res.ok) {
        throw new Error(`gemini ${res.status}: ${body.error?.message ?? "unknown error"}`);
      }
      recordRawUsage(model, body.usageMetadata);
      const text =
        body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text === "") {
        // Same observability the llm-router logs on this draw — an empty
        // 200 is undebuggable from the assertion diff alone.
        console.error(
          `e2e gemini: empty completion (model=${model}, ` +
            `finishReason=${body.candidates?.[0]?.finishReason ?? "unknown"}, ` +
            `promptFeedback=${JSON.stringify(body.promptFeedback ?? null)})`
        );
        if (emptyRetryLeft > 0 && attempt < MAX_ATTEMPTS) {
          emptyRetryLeft -= 1;
          await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
          continue;
        }
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Strict-JSON call — the ai-flow-worker's exact generationConfig. */
export async function geminiJson(prompt: string): Promise<string> {
  return generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      // Byte-matches the worker: structured extraction/classify needs no
      // chain-of-thought, and Gemini 3 thinking tokens BILL as output —
      // "minimal" keeps the spend on the answer. Gated on the family:
      // Gemini 2.5 rejects thinkingLevel.
      ...(/^gemini-3/i.test(E2E_GEMINI_MODEL)
        ? { thinkingConfig: { thinkingLevel: "minimal" } }
        : {})
    }
  });
}

export type ChatTurn = { role: "user" | "model"; text: string };

/**
 * System-instructed conversational reply — the SMS assistant turn shape.
 * `model` defaults to E2E_GEMINI_MODEL (the fleet's SMS_CHAT_MODEL default);
 * pass an override to pin a scenario to the exact model a tenant runs.
 * Empty completions are retried once, the production llm-router's policy on
 * this exact path (chat only — the worker's JSON path has no empty retry,
 * so geminiJson mirrors that and doesn't either).
 */
export async function geminiChatReply(
  systemInstruction: string,
  turns: ChatTurn[],
  model?: string,
  opts: { temperature?: number } = {}
): Promise<string> {
  return generateContent(
    {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: { temperature: opts.temperature ?? 0 }
    },
    model,
    { retryEmptyOnce: true }
  );
}
