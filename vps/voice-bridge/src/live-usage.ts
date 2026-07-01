/**
 * Gemini Live token-usage extraction, split out from gemini-telnyx-bridge.ts so
 * it can be unit-tested WITHOUT importing the heavy `@google/genai` / `ws`
 * dependencies the bridge pulls in (those aren't installed at the repo root
 * where the vitest suite runs). The bridge re-exports these symbols.
 */

/**
 * Cumulative token usage for a Gemini Live session, split by modality so the
 * app can price audio tokens (input $3/1M, output $12/1M) apart from the small
 * amount of TEXT tokens (system instruction, coordinator cues, tool JSON).
 * Populated from the `usageMetadata` Gemini Live reports on server messages —
 * see `readLiveUsage`.
 */
export type GeminiLiveUsage = {
  /** Total prompt (input) tokens for the whole session. */
  promptTokens: number;
  /** Total response (output) tokens for the whole session. */
  outputTokens: number;
  /** Portion of `promptTokens` that were AUDIO (caller speech in). */
  promptAudioTokens: number;
  /** Portion of `outputTokens` that were AUDIO (assistant speech out). */
  outputAudioTokens: number;
  /** Gemini's own `totalTokenCount` (used to pick the latest cumulative frame). */
  totalTokens: number;
};

/**
 * Read the cumulative token usage out of a Gemini Live server message.
 *
 * Gemini Live reports `usageMetadata` as RUNNING SESSION TOTALS (not per-turn),
 * so the caller keeps the frame with the largest `totalTokenCount` and meters
 * that once at session end. Modality is split from `promptTokensDetails` /
 * `responseTokensDetails` (each an array of `{ modality, tokenCount }`); we sum
 * the AUDIO entries so audio tokens can be priced at the audio rate and the
 * remainder at the text rate. Returns null when the message carries no usage.
 *
 * `message` is typed `unknown` (not LiveServerMessage) so this module stays
 * free of the `@google/genai` import; the bridge passes the SDK message in.
 */
export function readLiveUsage(message: unknown): GeminiLiveUsage | null {
  const um = (message as {
    usageMetadata?: {
      promptTokenCount?: number;
      responseTokenCount?: number;
      totalTokenCount?: number;
      promptTokensDetails?: Array<{ modality?: unknown; tokenCount?: unknown }>;
      responseTokensDetails?: Array<{ modality?: unknown; tokenCount?: unknown }>;
    };
  } | null)?.usageMetadata;
  if (!um) return null;
  const audioOf = (
    details?: Array<{ modality?: unknown; tokenCount?: unknown }>
  ): number => {
    if (!Array.isArray(details)) return 0;
    let sum = 0;
    for (const d of details) {
      if (
        typeof d?.tokenCount === "number" &&
        String(d?.modality ?? "").toUpperCase() === "AUDIO"
      ) {
        sum += d.tokenCount;
      }
    }
    return sum;
  };
  return {
    promptTokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0,
    outputTokens: typeof um.responseTokenCount === "number" ? um.responseTokenCount : 0,
    promptAudioTokens: audioOf(um.promptTokensDetails),
    outputAudioTokens: audioOf(um.responseTokensDetails),
    totalTokens: typeof um.totalTokenCount === "number" ? um.totalTokenCount : 0
  };
}
