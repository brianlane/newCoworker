import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Billed-token accounting for the live e2e suite.
 *
 * Every call site that hits the real Gemini API (tests/e2e/gemini.ts,
 * the geminiChatStep harnesses, voice-tools' raw step) records the
 * response's usageMetadata here; CI aggregates the JSONL into the job
 * summary via .github/scripts/e2e-usage-summary.sh so per-run spend is
 * visible and reconcilable against AI Studio's per-key view +
 * /admin/gemini (docs/GEMINI-SPEND.md).
 *
 * Vitest isolates each test file in a fresh module registry, so in-memory
 * accumulation would reset per file — the append-only JSONL survives the
 * whole run instead. Best-effort by design: a recording failure must never
 * fail a contract test. `outputTokens` includes thinking tokens (Google
 * bills them at the output rate), mirroring the production meters.
 */

export const USAGE_LOG_PATH = join("test-results", "e2e-gemini-usage.jsonl");

export type RawUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
};

export function recordGeminiUsage(
  model: string,
  usage: { promptTokens: number; outputTokens: number } | null | undefined
): void {
  if (!usage) return;
  try {
    mkdirSync(dirname(USAGE_LOG_PATH), { recursive: true });
    appendFileSync(
      USAGE_LOG_PATH,
      JSON.stringify({
        model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
        at: new Date().toISOString()
      }) + "\n"
    );
  } catch {
    // Observability only — never fail a test over the log.
  }
}

/** Adapter for raw REST responses (`usageMetadata`). */
export function recordRawUsage(model: string, um: RawUsageMetadata | undefined): void {
  if (!um) return;
  const promptTokens = Number(um.promptTokenCount ?? 0);
  const outputTokens = Number(um.candidatesTokenCount ?? 0) + Number(um.thoughtsTokenCount ?? 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(outputTokens)) return;
  if (promptTokens + outputTokens <= 0) return;
  recordGeminiUsage(model, { promptTokens, outputTokens });
}
