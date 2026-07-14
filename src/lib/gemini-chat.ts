/**
 * Gemini Developer API `generateContent` with FUNCTION CALLING — the
 * multi-turn sibling of src/lib/gemini-generate-content.ts (which is
 * deliberately single-shot text-only and used by many surfaces; extending
 * its contract for tools would ripple through every caller).
 *
 * One call = one model step. The caller owns the tool loop: when the
 * response carries `functionCall` parts, execute them, append the model
 * content + a `functionResponse` user turn to `contents`, and call again.
 * See src/lib/webchat/gemini-engine.ts for the consumer.
 *
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */

import { extractGeminiUsage, type GeminiUsage } from "@/lib/gemini-generate-content";

/** JSON-schema-shaped tool declaration (same shape the Rowboat seed uses). */
export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type GeminiFunctionCall = {
  name: string;
  /** Parsed args object; `{}` when the model sent none. */
  args: Record<string, unknown>;
};

/**
 * One content entry in the `contents` array. Parts are kept as raw JSON
 * (text / functionCall / functionResponse) so a model turn can be echoed
 * back verbatim on the next step — Gemini requires the functionCall part
 * to precede its functionResponse in history.
 */
export type GeminiChatContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

export type GeminiChatStepParams = {
  apiKey: string;
  /** Short model id, e.g. `gemini-2.5-flash-lite` (no `models/` prefix). */
  model: string;
  systemInstruction: string;
  contents: GeminiChatContent[];
  tools: GeminiFunctionDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type GeminiChatStepResult = {
  /** Concatenated text parts, null when the step produced none. */
  text: string | null;
  /** Tool invocations requested by this step (empty = final answer). */
  functionCalls: GeminiFunctionCall[];
  /**
   * The model's content verbatim, for appending to `contents` before the
   * functionResponse turn. Null only when the response had no candidate
   * content at all (callers treat that as empty).
   */
  modelContent: GeminiChatContent | null;
  /** Billed token counts; null when usageMetadata was absent. */
  usage: GeminiUsage | null;
};

function extractCandidateContent(json: unknown): GeminiChatContent | null {
  const root = json as Record<string, unknown> | null;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown> | undefined;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  return {
    role: "model",
    parts: parts.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
  };
}

/**
 * One generateContent step with tools attached.
 * @throws Error `gemini_http_<status>:...` on non-OK HTTP
 * @throws Error `gemini_http_parse` on an unparseable body
 */
export async function geminiChatStep(params: GeminiChatStepParams): Promise<GeminiChatStepResult> {
  const model = encodeURIComponent(params.model.trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": params.apiKey
    },
    signal: params.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.systemInstruction }] },
      contents: params.contents,
      ...(params.tools.length > 0
        ? { tools: [{ functionDeclarations: params.tools }] }
        : {}),
      generationConfig: {
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxOutputTokens ?? 1500
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

  const modelContent = extractCandidateContent(json);
  const usage = extractGeminiUsage(json);

  if (!modelContent) {
    return { text: null, functionCalls: [], modelContent: null, usage };
  }

  const textJoined = modelContent.parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  const functionCalls: GeminiFunctionCall[] = [];
  for (const part of modelContent.parts) {
    const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
    if (fc && typeof fc.name === "string" && fc.name.length > 0) {
      const args =
        fc.args && typeof fc.args === "object" && !Array.isArray(fc.args)
          ? (fc.args as Record<string, unknown>)
          : {};
      functionCalls.push({ name: fc.name, args });
    }
  }

  return {
    text: textJoined.length > 0 ? textJoined : null,
    functionCalls,
    modelContent,
    usage
  };
}

/** Build the `functionResponse` user turn answering one model step's calls. */
export function buildFunctionResponseContent(
  results: Array<{ name: string; response: unknown }>
): GeminiChatContent {
  return {
    role: "user",
    parts: results.map((r) => ({
      functionResponse: { name: r.name, response: { result: r.response } }
    }))
  };
}
