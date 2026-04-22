/**
 * Pure model-to-upstream router. Kept in its own module so unit tests can
 * import the decision logic without side effects (the main entrypoint binds
 * an HTTP server at import time).
 *
 * Rule: any model whose name starts with `gemini` (case-insensitive, with
 * `-`, `_`, or `.` as a separator) goes to Gemini's OpenAI-compatible
 * endpoint. Everything else (llama*, qwen*, empty, undefined, non-strings)
 * goes to Ollama. This keeps Rowboat's `voice_task` agent on Gemini while
 * `dispatcher` stays on the local Ollama model without any model-name
 * allowlisting.
 */

export function pickUpstream(model) {
  if (typeof model !== "string") return "ollama";
  if (/^gemini[-_.]/i.test(model)) return "gemini";
  return "ollama";
}
