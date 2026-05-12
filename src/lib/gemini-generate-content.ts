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
 * One-shot text generation via `models/{model}:generateContent`.
 * @throws Error `gemini_http_<status>:...` on non-OK HTTP
 * @throws Error `gemini_empty` when the response parses but has no candidate text
 */
export async function geminiGenerateText(params: GeminiGenerateTextParams): Promise<string> {
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
  return out;
}
