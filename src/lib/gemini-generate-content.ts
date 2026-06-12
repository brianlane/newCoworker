/**
 * Gemini Developer API (`ai.google.dev` key): native `generateContent` REST calls.
 *
 * Google's OpenAI-compatible `.../openai/chat/completions` route has shown 404 /
 * mismatched model resolution ("v1main") across keys—`generateContent` is the
 * documented, stable surface for `{model}:generateContent`.
 *
 * @see https://ai.google.dev/gemini-api/docs/text-generation
 */

export type GeminiGenerateTextParams = {
  apiKey: string;
  /** Short model id, e.g. `gemini-3-flash-preview` (no `models/` prefix). */
  model: string;
  systemInstruction: string;
  userText: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

/**
 * Billed token counts from the response's `usageMetadata`. `outputTokens`
 * includes thinking tokens (`thoughtsTokenCount`) — Google bills those at the
 * output rate, and models like 2.5 Flash think by default, so visible-text
 * estimates can undercount badly.
 */
export type GeminiUsage = {
  promptTokens: number;
  outputTokens: number;
};

export type GeminiGenerateTextResult = {
  text: string;
  /** Null when the response carried no parseable usageMetadata. */
  usage: GeminiUsage | null;
};

function extractGeminiUsage(json: unknown): GeminiUsage | null {
  const meta = (json as { usageMetadata?: Record<string, unknown> })?.usageMetadata;
  if (!meta || typeof meta !== "object") return null;
  const prompt = Number(meta["promptTokenCount"] ?? 0);
  const candidates = Number(meta["candidatesTokenCount"] ?? 0);
  const thoughts = Number(meta["thoughtsTokenCount"] ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(candidates) || !Number.isFinite(thoughts)) {
    return null;
  }
  const promptTokens = Math.max(0, prompt);
  const outputTokens = Math.max(0, candidates) + Math.max(0, thoughts);
  if (promptTokens === 0 && outputTokens === 0) return null;
  return { promptTokens, outputTokens };
}

function extractGeminiCandidateText(json: unknown): string | null {
  const root = json as Record<string, unknown>;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown> | undefined;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<{ text?: string } | undefined>;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const joined = parts
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  return joined.length > 0 ? joined : null;
}

/**
 * One-shot text generation via `models/{model}:generateContent`, returning
 * the candidate text AND the billed token usage so callers can meter spend
 * exactly instead of estimating from characters.
 * @throws Error `gemini_http_<status>:...` on non-OK HTTP
 * @throws Error `gemini_empty` when the response parses but has no candidate text
 */
export async function geminiGenerateTextDetailed(
  params: GeminiGenerateTextParams
): Promise<GeminiGenerateTextResult> {
  const model = encodeURIComponent(params.model.trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const temperature = params.temperature ?? 0.2;
  const maxOutputTokens = params.maxOutputTokens ?? 1500;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": params.apiKey
    },
    signal: params.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: params.userText }] }],
      generationConfig: {
        temperature,
        maxOutputTokens
      }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`gemini_http_${response.status}:${text.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("gemini_http_parse");
  }

  const out = extractGeminiCandidateText(json);
  if (!out) throw new Error("gemini_empty");
  return { text: out, usage: extractGeminiUsage(json) };
}

/** Text-only convenience wrapper around {@link geminiGenerateTextDetailed}. */
export async function geminiGenerateText(params: GeminiGenerateTextParams): Promise<string> {
  return (await geminiGenerateTextDetailed(params)).text;
}
