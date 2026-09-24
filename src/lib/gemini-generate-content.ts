import {
  geminiAuthHeaders,
  geminiEndpoint,
  resolveModelSurface,
  type ModelSurface
} from "../../supabase/functions/_shared/hipaa_model_surface";
/**
 * Gemini Developer API (`ai.google.dev` key): native `generateContent` REST calls.
 *
 * Google's OpenAI-compatible `.../openai/chat/completions` route has shown 404 /
 * mismatched model resolution ("v1main") across keys, `generateContent` is the
 * documented, stable surface for `{model}:generateContent`.
 *
 * @see https://ai.google.dev/gemini-api/docs/text-generation
 */

export type GeminiGenerateTextParams = {
  apiKey: string;
  /**
   * Where to send this call. Omitted by every existing caller, which resolves
   * to the AI Studio surface from `apiKey` exactly as before. A HIPAA tenant's
   * caller passes the BAA-covered Google Cloud surface instead; see
   * supabase/functions/_shared/hipaa_model_surface.ts.
   */
  surface?: ModelSurface;
  /** Short model id, e.g. `gemini-3-flash-preview` (no `models/` prefix). */
  model: string;
  systemInstruction: string;
  userText: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Forces a structured response, e.g. `"application/json"` (Gemini "JSON
   * mode"). When the caller needs strict JSON, this is far more reliable than
   * prompting alone, it removes code fences/prose and prevents the model from
   * trailing off into unparseable output.
   */
  responseMimeType?: string;
  /**
   * Gemini 3 reasoning budget (`thinkingConfig.thinkingLevel`). Gemini 3 Flash
   * defaults to `"high"` (dynamic), which can spend nearly the entire
   * `maxOutputTokens` budget on hidden thinking and truncate the visible
   * answer. Set `"low"` (or `"minimal"`) for structured-extraction tasks where
   * the output budget must go to the answer, not reasoning. Only valid on
   * Gemini 3 models, Gemini 2.5 rejects it (those use a numeric budget).
   */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /**
   * Optional binary attachments appended to the user turn as `inlineData`
   * parts (e.g. a PDF for document ingestion). Callers are responsible for
   * keeping the payload within Gemini's inline limits (~20 MB request).
   */
  inlineParts?: Array<{ mimeType: string; dataBase64: string }>;
  signal?: AbortSignal;
};

/**
 * Billed token counts from the response's `usageMetadata`. `outputTokens`
 * includes thinking tokens (`thoughtsTokenCount`), Google bills those at the
 * output rate, and models like 2.5 Flash think by default, so visible-text
 * estimates can undercount badly.
 */
export type GeminiUsage = {
  promptTokens: number;
  outputTokens: number;
  /**
   * Optional modality split for audio-native surfaces (Gemini Live voice). When
   * present, this many of `promptTokens` / `outputTokens` were AUDIO tokens and
   * are priced at the audio rate; the remainder prices at the text rate. Absent
   * for text-only surfaces (chat/SMS/AiFlow), where everything is text-priced.
   */
  promptAudioTokens?: number;
  outputAudioTokens?: number;
};

export type GeminiGenerateTextResult = {
  text: string;
  /** Null when the response carried no parseable usageMetadata. */
  usage: GeminiUsage | null;
};

/**
 * Parse billed token counts out of a generateContent response body.
 * Exported for the function-calling chat client (src/lib/gemini-chat.ts),
 * which shares the exact usage semantics (thinking tokens billed as output).
 */
export function extractGeminiUsage(json: unknown): GeminiUsage | null {
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

/**
 * Thrown when a 200 response parses but has no candidate text. Google still
 * BILLS these calls (e.g. thinking-only output when the thinking budget eats
 * `maxOutputTokens`), so the error carries the parsed usage for callers that
 * meter spend. `message` stays "gemini_empty" for existing classifiers.
 */
export class GeminiEmptyError extends Error {
  readonly usage: GeminiUsage | null;

  constructor(usage: GeminiUsage | null) {
    super("gemini_empty");
    this.name = "GeminiEmptyError";
    this.usage = usage;
  }
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
 * True when a non-OK response is Google rejecting the REQUESTED
 * `thinkingConfig.thinkingLevel`, not the prompt itself. Which values a model
 * accepts varies BY MODEL: live-verified 2026-08-14, gemini-3.7-flash 400s on
 * "minimal" ("Thinking level MINIMAL is not supported for this model") while
 * 3.5-flash-lite accepts it, and 2.5-era models reject the field outright
 * (Unknown name "thinkingLevel"). Matched loosely (level or config, any
 * separator) so both rejection shapes qualify. Callers pick models via env
 * (GEMINI_ROWBOAT_MODEL, GEMINI_SUMMARY_MODEL, ...), so a config-shaped 400
 * must degrade instead of killing the surface: the 404 fallbacks in
 * knowledge-tools/website-ingest never see 400s. Mirrored in
 * supabase/functions/ai-flow-worker/index.ts; keep in lockstep.
 */
export function isThinkingLevelRejection(status: number, body: string): boolean {
  return status === 400 && /thinking[\s_-]?(level|config)/i.test(body);
}

/**
 * Fallback for the single bounded retry after a thinking-level rejection:
 * "minimal" (the only value some models reject today) steps down to "low";
 * any other rejected value drops the config entirely so the model default
 * applies. A failed retry surfaces the retry's own gemini_http_* error, so
 * this never loops.
 */
export function thinkingLevelFallback(
  level: NonNullable<GeminiGenerateTextParams["thinkingLevel"]>
): GeminiGenerateTextParams["thinkingLevel"] {
  return level === "minimal" ? "low" : undefined;
}

/**
 * Attempts for one generateContent call when Gemini answers 429 or 5xx, or
 * the fetch itself throws. Same budget the AiFlow worker uses for classify
 * and extract (`GEMINI_MAX_ATTEMPTS` in ai-flow-worker): a brief "high
 * demand" 503 must not fail the caller on the first try.
 */
const GEMINI_TRANSIENT_ATTEMPTS = 3;

/** 429 and 5xx are brief overloads. Any other 4xx is a permanent refusal. */
function isTransientGeminiStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * True when an agent-run `model_failed` detail is still a brief overload
 * after the inner retries. The run-agent route turns these into HTTP 503
 * so the worker re-queues. A 429 from Gemini must become a platform 5xx:
 * the worker only retries `status >= 500`, and a 429 body would be read as
 * a permanent failure.
 */
export function isTransientGeminiErrorDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && /^gemini_http_(?:429|5\d\d)(?::|$)/.test(detail);
}

function transientBackoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const fail = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isCallerAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * POST once, retrying only transient failures. Returns the last response
 * (even when not ok) so the caller's existing non-OK handling still applies.
 * A permanent 4xx returns immediately. A fetch that still throws on the
 * final attempt is rethrown. An abort from the caller's signal is rethrown
 * immediately: retrying it would sleep past the deadline that aborted it.
 */
async function requestWithTransientRetry(
  request: () => Promise<Response>,
  signal?: AbortSignal
): Promise<Response> {
  for (let attempt = 1; attempt <= GEMINI_TRANSIENT_ATTEMPTS; attempt++) {
    try {
      const res = await request();
      if (res.ok || !isTransientGeminiStatus(res.status) || attempt === GEMINI_TRANSIENT_ATTEMPTS) {
        return res;
      }
      await res.text().catch(() => {});
    } catch (e) {
      if (attempt === GEMINI_TRANSIENT_ATTEMPTS || isCallerAbort(e, signal)) throw e;
    }
    await sleep(transientBackoffMs(attempt), signal);
  }
  // The loop returns or throws on every attempt, including the last.
  throw new Error("gemini_transient_retry_exhausted");
}

/**
 * One-shot text generation via `models/{model}:generateContent`, returning
 * the candidate text AND the billed token usage so callers can meter spend
 * exactly instead of estimating from characters. A 400 that rejects the
 * requested thinkingLevel is retried once at {@link thinkingLevelFallback}
 * (same model, same abort signal, so caller deadlines still bound it).
 * A 429 or 5xx, and a fetch that throws, is retried up to three times with
 * the same backoff classify and extract use. The caller's abort signal is
 * not a transient failure: it stops the retry immediately, including during
 * the backoff sleep.
 * @throws Error `gemini_http_<status>:...` on non-OK HTTP
 * @throws Error `gemini_empty` when the response parses but has no candidate text
 */
export async function geminiGenerateTextDetailed(
  params: GeminiGenerateTextParams
): Promise<GeminiGenerateTextResult> {
  // Endpoint AND auth come from the surface resolver, so a HIPAA tenant
  // can never be sent to the AI Studio host no BAA covers. Non-HIPAA
  // callers pass no surface and resolve to exactly the previous URL.
  const surface = params.surface ?? resolveModelSurface(false, params.apiKey);
  const url = geminiEndpoint(surface, params.model);
  const temperature = params.temperature ?? 0.2;
  const maxOutputTokens = params.maxOutputTokens ?? 1500;

  const requestOnce = (thinkingLevel: GeminiGenerateTextParams["thinkingLevel"]) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...geminiAuthHeaders(surface)
      },
      signal: params.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemInstruction }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: params.userText },
              ...(params.inlineParts ?? []).map((p) => ({
                inlineData: { mimeType: p.mimeType, data: p.dataBase64 }
              }))
            ]
          }
        ],
        generationConfig: {
          temperature,
          maxOutputTokens,
          ...(params.responseMimeType ? { responseMimeType: params.responseMimeType } : {}),
          ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {})
        }
      })
    });

  let response = await requestWithTransientRetry(
    () => requestOnce(params.thinkingLevel),
    params.signal
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const requestedLevel = params.thinkingLevel;
    if (requestedLevel && isThinkingLevelRejection(response.status, text)) {
      response = await requestWithTransientRetry(
        () => requestOnce(thinkingLevelFallback(requestedLevel)),
        params.signal
      );
    } else {
      throw new Error(`gemini_http_${response.status}:${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const retryText = await response.text().catch(() => "");
      throw new Error(`gemini_http_${response.status}:${retryText.slice(0, 200)}`);
    }
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("gemini_http_parse");
  }

  const out = extractGeminiCandidateText(json);
  if (!out) throw new GeminiEmptyError(extractGeminiUsage(json));
  return { text: out, usage: extractGeminiUsage(json) };
}

/** Text-only convenience wrapper around {@link geminiGenerateTextDetailed}. */
export async function geminiGenerateText(params: GeminiGenerateTextParams): Promise<string> {
  return (await geminiGenerateTextDetailed(params)).text;
}
