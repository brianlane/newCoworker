/**
 * A blank "Run now" whose first step is extract_text has no message to read.
 * The worker then fails the run with "extract_text: no message text to read"
 * and, because the failure is terminal, logs it at error. That put an owner's
 * empty test click on the admin System Errors card (BA Fitness, 2026-09-23).
 * Refuse the enqueue instead.
 */

export const BLANK_MANUAL_EXTRACT_MESSAGE =
  "Paste a sample message first. This automation starts by reading the message text, and a blank run has nothing to read.";

export function blankManualExtractRefusal(
  definition: { steps?: unknown } | null | undefined,
  input: string | undefined
): string | null {
  if ((input ?? "").trim()) return null;
  const steps =
    definition && typeof definition === "object" && Array.isArray(definition.steps)
      ? definition.steps
      : [];
  const first = steps[0];
  if (!first || typeof first !== "object") return null;
  if ((first as { type?: unknown }).type !== "extract_text") return null;
  return BLANK_MANUAL_EXTRACT_MESSAGE;
}
