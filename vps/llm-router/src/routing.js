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

// Headers we must NOT copy from the upstream response onto our own response.
//
//   - transfer-encoding / connection / keep-alive: hop-by-hop framing that
//     Node's http server manages itself; forwarding them corrupts the response.
//   - content-encoding / content-length: undici's `fetch` transparently
//     DECODES the upstream body (gzip/br/deflate) before we re-stream it, so
//     the bytes we forward are already plaintext and a different length than
//     what the upstream advertised. Google's Gemini OpenAI-compat endpoint
//     returns `content-encoding: gzip`; copying that header onto the
//     already-decompressed body makes the downstream client (Rowboat/undici)
//     try to gunzip plaintext → `Z_DATA_ERROR: incorrect header check` → 500.
//     Dropping both lets Node re-frame the decoded body correctly (chunked).
const STRIPPED_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
  "content-length"
]);

/**
 * Build the header map to send downstream from an upstream `fetch` Response's
 * headers, dropping hop-by-hop and body-encoding headers that no longer match
 * the (already-decoded) body we re-stream. Accepts anything with a
 * `forEach(value, key)` iterator (a `Headers` instance or a plain object's
 * entries) and returns a lowercased plain object.
 */
export function filterUpstreamHeaders(headers) {
  const out = {};
  const visit = (value, key) => {
    const k = String(key).toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(k)) return;
    out[k] = value;
  };
  if (headers && typeof headers.forEach === "function") {
    headers.forEach(visit);
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) visit(value, key);
  }
  return out;
}
