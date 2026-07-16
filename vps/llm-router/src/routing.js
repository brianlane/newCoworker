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
 * Decide whether a gemini-* completion routed through this sidecar should be
 * metered into the tenant's shared "AI budget" (`owner_chat_model_spend`).
 *
 * The budget covers EVERY Gemini call that flows through Rowboat: owner
 * dashboard chat + inbound SMS replies + the rolling conversation/customer
 * summarizers (`OWNER_CHAT_MODEL`/`SMS_CHAT_MODEL`, default gemini-2.5-flash-lite)
 * AND the voice `voice_task` agent (`GEMINI_ROWBOAT_MODEL`, default
 * gemini-3.1-flash). All of it is Google AI spend and belongs in the one AI
 * budget the dashboard shows.
 *
 * The ONLY gemini spend NOT metered here is Gemini Live (the real-time
 * audio-to-audio model, e.g. gemini-3.1-flash-live-preview): it never reaches
 * this router — the voice-bridge holds that WebSocket directly and meters it
 * separately from the exact `usageMetadata` it sees. We guard on the `live`
 * substring defensively so a stray Live completion here could never
 * double-count against the bridge's meter.
 *
 * Rule: any `gemini-*` model is metered UNLESS it is a `live`-flavored model.
 * Non-gemini (ollama) traffic is $0 and never metered. Kept pure + exported so
 * the metering decision is unit-tested without booting the HTTP server.
 */
export function isAiBudgetModel(model) {
  if (typeof model !== "string") return false;
  const m = model.trim().toLowerCase();
  if (m === "") return false;
  // Check the trimmed/normalized name so a stray leading space can't misroute
  // (pickUpstream anchors on `^gemini`); pickUpstream is already case-insensitive.
  if (pickUpstream(m) !== "gemini") return false;
  // Gemini Live never routes through here (bridge meters it); guard defensively.
  if (m.includes("live")) return false;
  return true;
}

/**
 * Extract OpenAI-compatible billed token usage from a parsed chat-completions
 * object (either the buffered JSON body or one streamed chunk). Gemini's
 * OpenAI-compat endpoint reports `usage.completion_tokens` INCLUSIVE of
 * reasoning/thinking tokens, so it maps straight onto the platform's
 * `GeminiUsage { promptTokens, outputTokens }` shape (which the app prices
 * with `geminiCostMicrosFromUsage`). Returns null when no usable usage is
 * present (so a usage-less response simply isn't metered — never over-counts).
 */
export function extractOpenAiUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const u = obj.usage;
  if (!u || typeof u !== "object") return null;
  const prompt = Number(u.prompt_tokens);
  const completion = Number(u.completion_tokens);
  const promptTokens = Number.isFinite(prompt) ? Math.max(0, prompt) : 0;
  const outputTokens = Number.isFinite(completion) ? Math.max(0, completion) : 0;
  if (promptTokens === 0 && outputTokens === 0) return null;
  return { promptTokens, outputTokens };
}

/**
 * Stateful, line-buffered collector that harvests the final `usage` object
 * from an OpenAI-compatible SSE stream. The router injects
 * `stream_options:{include_usage:true}` on metered gemini streams so the
 * upstream emits a terminal `{choices:[],usage:{...}}` chunk; this scans every
 * `data:` line and keeps the LAST usage seen. Mirrors the chunk-splitting of
 * `createSseToolCallIndexNormalizer` (handles events split across network
 * chunks; `flush()` drains any trailing unterminated line at end-of-stream).
 */
export function createSseUsageCollector() {
  let buf = "";
  let usage = null;

  const scanLine = (line) => {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!bare.startsWith("data:")) return;
    const data = bare.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const u = extractOpenAiUsage(parsed);
    if (u) usage = u;
  };

  return {
    collect(text) {
      buf += text;
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl === -1) return;
      const complete = buf.slice(0, lastNl);
      buf = buf.slice(lastNl + 1);
      for (const line of complete.split("\n")) scanLine(line);
    },
    flush() {
      if (buf) {
        for (const line of buf.split("\n")) scanLine(line);
        buf = "";
      }
    },
    result() {
      return usage;
    }
  };
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

/**
 * ── Gemini 3.x thought-signature round-trip ────────────────────────────────
 *
 * Gemini 3.x models attach `extra_content.google.thought_signature` to every
 * tool call they emit on the OpenAI-compat endpoint, and REQUIRE the same
 * signature to be echoed back on the assistant `tool_calls` message when the
 * conversation is replayed — otherwise turn 2 of any tool-calling
 * conversation fails with HTTP 400 "Function call is missing a
 * thought_signature" (verified live 2026-07-16; this is why PR #602 pinned
 * SMS to gemini-2.5-flash). Rowboat's `@openai/agents` + AI SDK layers strip
 * unknown fields when they rebuild message history, so the signature never
 * survives Rowboat.
 *
 * This shim makes the router repair that transparently:
 *   - HARVEST: every gemini-3.x response (JSON body or SSE deltas) has its
 *     tool-call signatures cached in an in-memory LRU keyed by tool-call id
 *     (ids are upstream-generated and unique per call; conversations are
 *     box-local so one router process sees both sides).
 *   - INJECT: on each gemini-3.x request, assistant `tool_calls` lacking a
 *     signature get the cached one back; when the cache has nothing (router
 *     restart, evicted, or history imported from another model) they get
 *     Google's documented validator-bypass placeholder instead — verified
 *     live to be accepted. Real signatures preserve reasoning quality; the
 *     placeholder guarantees no 400s.
 *
 * Gemini 2.x has no signatures and is untouched (`needsThoughtSignatures`
 * gates on the model family), and existing signatures are never overwritten.
 */

/** Google's documented bypass value for histories without real signatures. */
export const THOUGHT_SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";

/** Whether this model family requires thought signatures on replayed tool calls. */
export function needsThoughtSignatures(model) {
  if (typeof model !== "string") return false;
  return /^gemini[-_.]3/i.test(model.trim());
}

/**
 * Minimal insertion-order LRU for tool-call-id → signature. Signatures are
 * ~300-byte opaque strings; 2000 entries ≈ well under a MB and far beyond
 * any live conversation's tool-call count on one box.
 */
export function createSignatureCache(max = 2000) {
  const map = new Map();
  return {
    set(id, signature) {
      if (typeof id !== "string" || id === "") return;
      if (typeof signature !== "string" || signature === "") return;
      // Re-insert so recently seen ids survive eviction longest.
      if (map.has(id)) map.delete(id);
      map.set(id, signature);
      while (map.size > max) {
        map.delete(map.keys().next().value);
      }
    },
    get(id) {
      return map.get(id);
    },
    size() {
      return map.size;
    }
  };
}

/**
 * Pull `extra_content.google.thought_signature` off every tool call in a
 * parsed chat-completions payload — non-streamed (`choices[].message`) and
 * streamed (`choices[].delta`) alike (Gemini's OpenAI-compat sends each
 * streamed tool call complete in a single delta, id + signature included).
 * Returns how many signatures were cached.
 */
export function harvestThoughtSignatures(payload, cache) {
  if (!payload || !Array.isArray(payload.choices)) return 0;
  let harvested = 0;
  for (const choice of payload.choices) {
    for (const container of [choice?.message, choice?.delta]) {
      const calls = container?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        const id = tc?.id;
        const signature = tc?.extra_content?.google?.thought_signature;
        if (typeof id === "string" && id && typeof signature === "string" && signature) {
          cache.set(id, signature);
          harvested += 1;
        }
      }
    }
  }
  return harvested;
}

/**
 * Return a copy of `body` where every assistant `tool_calls[]` entry carries
 * a thought signature: the cached one for its id when available, else the
 * placeholder. Entries that already have a signature are left untouched.
 * Returns `{ body, cached, placeholders }`; `body` is the ORIGINAL object
 * when nothing needed injection (so callers can cheaply detect no-ops).
 */
export function injectThoughtSignatures(body, cache) {
  if (!body || !Array.isArray(body.messages)) {
    return { body, cached: 0, placeholders: 0 };
  }
  let cached = 0;
  let placeholders = 0;
  let messages = null;

  body.messages.forEach((msg, mi) => {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) return;
    let calls = null;
    msg.tool_calls.forEach((tc, ti) => {
      if (!tc || typeof tc !== "object") return;
      const existing = tc.extra_content?.google?.thought_signature;
      if (typeof existing === "string" && existing !== "") return;
      const fromCache = typeof tc.id === "string" ? cache.get(tc.id) : undefined;
      const signature = fromCache ?? THOUGHT_SIGNATURE_PLACEHOLDER;
      if (fromCache) cached += 1;
      else placeholders += 1;
      if (!calls) calls = [...msg.tool_calls];
      calls[ti] = {
        ...tc,
        extra_content: {
          ...(tc.extra_content ?? {}),
          google: { ...(tc.extra_content?.google ?? {}), thought_signature: signature }
        }
      };
    });
    if (calls) {
      if (!messages) messages = [...body.messages];
      messages[mi] = { ...msg, tool_calls: calls };
    }
  });

  if (!messages) return { body, cached, placeholders };
  return { body: { ...body, messages }, cached, placeholders };
}

/**
 * Stateful line-buffered SSE scanner that feeds every `data: {...}` event
 * through `harvestThoughtSignatures`. Same chunk-splitting contract as
 * `createSseUsageCollector` (buffers to the last newline; `flush()` drains
 * the trailing unterminated line at end-of-stream). Read-only — never
 * rewrites the stream.
 */
export function createSseSignatureHarvester(cache) {
  let buf = "";

  const scanLine = (line) => {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!bare.startsWith("data:")) return;
    const data = bare.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    harvestThoughtSignatures(parsed, cache);
  };

  return {
    collect(text) {
      buf += text;
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl === -1) return;
      const complete = buf.slice(0, lastNl);
      buf = buf.slice(lastNl + 1);
      for (const line of complete.split("\n")) scanLine(line);
    },
    flush() {
      if (buf) {
        for (const line of buf.split("\n")) scanLine(line);
        buf = "";
      }
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
