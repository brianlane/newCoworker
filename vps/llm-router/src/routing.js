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

/**
 * Collapse multiple `system` messages in an OpenAI chat-completions body into
 * a single one (contents joined with a blank line, placed at the position of
 * the first system message; all other messages keep their relative order).
 *
 * Why: Google's Gemini OpenAI-compat endpoint honors only the LAST `system`
 * message in `messages[]`. Rowboat's agents runtime sends the agent
 * instructions as one system message, and its `ensureSystemMessage` (or a
 * caller-supplied preamble, e.g. the AiFlow route_to_team selection call)
 * contributes a SECOND one — so the entire vault-grounded agent prompt
 * (identity/soul/website/memory) was silently dropped on every Gemini turn
 * and agents answered as a bare base model (hallucinated team rosters,
 * "I am a large language model" replies). Merging preserves both prompts for
 * every upstream; Ollama templates also behave better with a single system.
 *
 * Returns the ORIGINAL body object when there is nothing to merge (zero or
 * one system message) or when any system content is not a plain string
 * (OpenAI content-parts arrays are passed through untouched rather than
 * risk mangling them).
 */
export function mergeSystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  const systems = body.messages.filter((m) => m && m.role === "system");
  if (systems.length <= 1) return body;
  if (!systems.every((m) => typeof m.content === "string")) return body;

  const merged = systems
    .map((m) => m.content)
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  const firstIdx = body.messages.findIndex((m) => m && m.role === "system");
  const messages = body.messages.filter((m) => !(m && m.role === "system"));
  messages.splice(firstIdx, 0, { ...systems[0], content: merged });
  return { ...body, messages };
}

/**
 * Inject the `index` field into streamed `choices[].delta.tool_calls[]`
 * entries when the upstream omitted it.
 *
 * Why: the OpenAI streaming spec marks `index` REQUIRED on tool-call deltas
 * (it's how clients stitch fragmented arguments back together), and Rowboat's
 * AI SDK openai-compatible provider hard-fails chunk schema validation
 * without it — every Gemini tool call turned into a 500 even though the
 * model called the function correctly. Gemini's OpenAI-compat endpoint sends
 * each tool call complete in a single chunk, so the array position is the
 * correct index.
 *
 * Mutates `payload` in place; returns true when anything was added.
 */
export function addToolCallIndices(payload) {
  if (!payload || !Array.isArray(payload.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    calls.forEach((tc, i) => {
      if (tc && typeof tc === "object" && typeof tc.index !== "number") {
        tc.index = i;
        changed = true;
      }
    });
  }
  return changed;
}

/**
 * Stateful line-buffered SSE rewriter that applies `addToolCallIndices` to
 * every `data: {...}` event in a chat-completions stream. Handles events
 * split across network chunks (buffers up to the last newline) and passes
 * non-JSON lines (`data: [DONE]`, comments, blank keep-alives) through
 * untouched.
 *
 * Usage: feed decoded text via transform(), then call flush() once at
 * end-of-stream for any trailing unterminated line.
 */
export function createSseToolCallIndexNormalizer() {
  let buf = "";

  const fixLine = (line) => {
    const hadCr = line.endsWith("\r");
    const bare = hadCr ? line.slice(0, -1) : line;
    if (!bare.startsWith("data:")) return line;
    const data = bare.slice(5).trimStart();
    if (!data || data === "[DONE]") return line;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return line;
    }
    if (!addToolCallIndices(parsed)) return line;
    return `data: ${JSON.stringify(parsed)}${hadCr ? "\r" : ""}`;
  };

  return {
    transform(text) {
      buf += text;
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl === -1) return "";
      const complete = buf.slice(0, lastNl);
      buf = buf.slice(lastNl + 1);
      return complete.split("\n").map(fixLine).join("\n") + "\n";
    },
    flush() {
      const rest = buf;
      buf = "";
      return rest ? fixLine(rest) : "";
    }
  };
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
