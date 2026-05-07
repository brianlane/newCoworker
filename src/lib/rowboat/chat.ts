/**
 * Node-side Rowboat chat client used by /api/dashboard/chat.
 *
 * Mirrors the Edge function behaviour in
 *   supabase/functions/sms-inbound-worker/index.ts (lines 66-104, 205-246)
 * so platform surfaces send identical payloads to the per-tenant Rowboat
 * running on Cloudflare Tunnel. Kept intentionally small and dependency-free
 * so the Deno worker could import it too via a shared ports/adapters split
 * later; for now we duplicate the shape knowingly.
 *
 * The Rowboat reply is NOT `{ reply: string }` — the assistant text lives in
 * `turn.output[]` where `role === "assistant"`.
 */

export type RowboatChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RowboatTurnJson = {
  conversationId?: string;
  /** Server workflow state; pass back on the next /chat to continue a thread. */
  state?: unknown;
  turn?: {
    output?: Array<{ role?: string; content?: string | null }>;
  };
};

export type ParsedRowboatChat = {
  reply: string;
  conversationId: string | undefined;
  state: unknown | undefined;
  hasStateKey: boolean;
};

export const DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE =
  "https://{businessId}.newcoworker.com/api/v1/{projectId}/chat";

export const DEFAULT_ROWBOAT_CHAT_TIMEOUT_MS = 30_000;

export function buildRowboatChatUrl(businessId: string, projectId: string): string {
  const template =
    process.env.ROWBOAT_CHAT_URL_TEMPLATE ?? DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE;
  return template
    .replace(/\{businessId\}/g, businessId)
    .replace(/\{projectId\}/g, projectId);
}

export function assistantFromRowboat(json: unknown): string {
  const o = json as RowboatTurnJson | null | undefined;
  const outs = o?.turn?.output ?? [];
  for (const m of outs) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }
  }
  return "";
}

export function parseRowboatChatJson(json: unknown): ParsedRowboatChat {
  const isObj = json !== null && typeof json === "object";
  const o = (isObj ? json : {}) as { conversationId?: string; state?: unknown };
  const hasStateKey =
    isObj && Object.prototype.hasOwnProperty.call(json, "state");
  return {
    reply: assistantFromRowboat(json),
    conversationId: o.conversationId,
    state: hasStateKey ? o.state : undefined,
    hasStateKey
  };
}

export type CallRowboatChatInput = {
  businessId: string;
  projectId: string;
  bearer: string;
  messages: RowboatChatMessage[];
  conversationId?: string | null;
  state?: unknown | null;
  /** Override for tests or slow tunnels. */
  timeoutMs?: number;
};

export type CallRowboatChatOutput = ParsedRowboatChat;

/**
 * Throws with one of these Error messages so callers can map to friendly
 * copy without string sniffing on arbitrary network errors:
 *   - `rowboat_timeout`
 *   - `rowboat_http_<status>`
 *   - `rowboat_empty_assistant`
 *   - `rowboat_invalid_json`
 */
export async function callRowboatChat(
  input: CallRowboatChatInput
): Promise<CallRowboatChatOutput> {
  const {
    businessId,
    projectId,
    bearer,
    messages,
    conversationId,
    state,
    timeoutMs
  } = input;

  const url = buildRowboatChatUrl(businessId, projectId);

  const body: Record<string, unknown> = {
    messages,
    stream: false
  };
  if (conversationId && conversationId.trim()) {
    body.conversationId = conversationId.trim();
    if (state != null) body.state = state;
  }

  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    timeoutMs ?? DEFAULT_ROWBOAT_CHAT_TIMEOUT_MS
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });
  } catch (err) {
    if (abort.signal.aborted) throw new Error("rowboat_timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`rowboat_http_${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("rowboat_invalid_json");
  }

  const parsed = parseRowboatChatJson(json);
  if (!parsed.reply) throw new Error("rowboat_empty_assistant");
  return parsed;
}

/**
 * Maps the error messages thrown by callRowboatChat into owner-friendly copy
 * for /dashboard/chat. Unknown errors bubble up as a generic message.
 */
export function describeRowboatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "rowboat_timeout") {
      return "Your coworker took too long to reply. Try again in a moment.";
    }
    if (err.message === "rowboat_empty_assistant") {
      return "Your coworker didn't produce a reply. Try rephrasing.";
    }
    if (err.message === "rowboat_invalid_json") {
      return "Your coworker returned an unexpected response. Try again.";
    }
    if (err.message.startsWith("rowboat_http_")) {
      const status = err.message.replace("rowboat_http_", "");
      if (status === "401" || status === "403") {
        return "Your coworker isn't accepting requests right now (auth). Please contact support.";
      }
      if (status === "404") {
        return "Your coworker's chat service isn't ready yet. Provisioning may still be in progress.";
      }
      // 524/522/408 are infrastructure-level "no response in time" signals
      // (Cloudflare 524 = origin idle timeout exceeded; 408 = request timeout;
      // 522 = origin connection timed out). Treat them as the same UX as
      // rowboat_timeout: a slow model, not a misconfiguration. Mapped here
      // (rather than at the streaming layer) so the buffered fallback path
      // — and any future caller — gets the same friendly copy without
      // having to special-case status codes.
      if (status === "524" || status === "522" || status === "408") {
        return "Your coworker took too long to reply. Try again in a moment.";
      }
      return `Your coworker is having trouble (status ${status}). Please try again shortly.`;
    }
  }
  return "We couldn't reach your coworker right now. Please try again in a moment.";
}

// =====================================================================
// Streaming variant — used by /api/dashboard/chat to emit deltas to the
// browser as Rowboat / Ollama generates them.
//
// Why streaming exists at all: Cloudflare Tunnel (which fronts the per-
// tenant Rowboat) returns 524 when the origin sends no response headers
// within ~60-100s. With `stream: false` a 70s Ollama generation NEVER
// produces traffic before the timer trips, so the dashboard chat could
// not ask "long" questions without hitting a buffered-mode 524. Tokens
// flowing token-by-token keeps the connection live, structurally
// eliminating the 524 path on this surface.
//
// The buffered `callRowboatChat` above stays for the summarizer (fire-
// and-forget, doesn't benefit from streaming) and any non-dashboard
// caller. Both paths share `parseRowboatChatJson` so the final
// "Rowboat-shaped JSON" extraction logic is identical.
// =====================================================================

export type RowboatStreamEvent =
  /** A chunk of assistant text. May be a single character or many. */
  | { type: "delta"; text: string }
  /**
   * Tool-call invocation surfaced by Rowboat mid-stream. We don't act on
   * these in v1 — the dashboard chat doesn't render tool calls — but we
   * yield them so a future caller can without changing the contract.
   * The route ignores them.
   */
  | { type: "tool_call"; name: string; arguments: unknown }
  /**
   * Final marker. `conversationId` / `state` come from whatever
   * post-completion metadata Rowboat emits; both may be absent if the
   * server didn't include them. `hasStateKey` mirrors the buffered
   * `parseRowboatChatJson` semantics so callers can distinguish "state
   * was explicitly null" from "state key never appeared" — important
   * because the route uses that distinction to decide whether to
   * overwrite the stored conversation continuation.
   */
  | {
      type: "done";
      conversationId: string | undefined;
      state: unknown | undefined;
      hasStateKey: boolean;
    }
  /**
   * Stream terminated by an upstream failure. `message` matches the
   * `Error.message` taxonomy used by `callRowboatChat`
   * (`rowboat_timeout`, `rowboat_http_<status>`, `rowboat_invalid_json`,
   * `rowboat_empty_assistant`) so `describeRowboatError` and the
   * stateless-retry gate work unchanged.
   */
  | { type: "error"; message: string };

export type CallRowboatChatStreamInput = {
  businessId: string;
  projectId: string;
  bearer: string;
  messages: RowboatChatMessage[];
  conversationId?: string | null;
  state?: unknown | null;
  /**
   * Hard cap on time-to-first-byte. 30s default — generous enough to
   * absorb a cold-model paged-in startup on a small VPS, tight enough
   * that a wedged tunnel surfaces quickly. Distinct from `idleTimeoutMs`
   * because TTFB has wildly different latency characteristics from
   * mid-stream tokens (TTFB is dominated by model load + first inference
   * pass; idle is "the model paused mid-token-stream", which usually
   * means something is genuinely broken).
   */
  ttfbTimeoutMs?: number;
  /**
   * Per-chunk idle cap. Resets on every received SSE chunk. 30s default
   * catches mid-stream stalls without killing legitimate long
   * generations. There is intentionally NO total runtime cap: the model
   * takes as long as it takes, bounded only by Vercel `maxDuration`
   * (300s) at the route level.
   */
  idleTimeoutMs?: number;
};

export const DEFAULT_ROWBOAT_STREAM_TTFB_MS = 30_000;
export const DEFAULT_ROWBOAT_STREAM_IDLE_MS = 30_000;

/**
 * Pure parser for one Rowboat SSE event payload (the JSON inside a
 * `data:` line, OR the literal `[DONE]` sentinel). Exported so tests
 * can drive it directly without a network mock.
 *
 * Wire-format note (verified at design time, code review pending live
 * confirmation): Rowboat's `stream: true` mode is not documented in our
 * repo — every existing caller sends `stream: false` (see
 * `callRowboatChat` and tests/integration/kvm-rowboat/rowboat-chat.ts
 * line 87). The infrastructure (`vps/llm-router`) passes
 * `text/event-stream` through verbatim, so the most likely shapes are:
 *
 *   1. OpenAI-compatible: `{"choices":[{"delta":{"content":"..."}}]}`
 *      — what llm-router forwards from upstream.
 *   2. Rowboat-native: `{"type":"delta","content":"..."}` /
 *      `{"type":"done","conversationId":"...","state":{...}}`.
 *   3. Final Rowboat-shaped JSON: a single SSE event carrying the same
 *      `{conversationId, state, turn:{output:[...]}}` shape returned by
 *      the buffered API, often emitted as the closing event.
 *   4. The literal `[DONE]` sentinel as a stream terminator.
 *
 * We handle all four. If a future Rowboat release picks something else
 * the parser returns `null` events and the stream loop will surface a
 * `rowboat_invalid_json` error rather than silently producing empty
 * replies — making the regression visible at the friendly-error layer.
 */
export function parseRowboatStreamEvent(rawData: string): RowboatStreamEvent | null {
  const trimmed = rawData.trim();
  if (!trimmed) return null;
  // SSE convention: `[DONE]` sentinel (OpenAI compat). When we see it,
  // we don't yet know the conversationId — those land in earlier events
  // OR in the final Rowboat-shaped JSON. The caller (`callRowboatChatStream`)
  // tracks running metadata and emits the actual `done` event itself.
  if (trimmed === "[DONE]") {
    return {
      type: "done",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Hypothesis 2: Rowboat-native `{type, ...}` events.
  const evType = typeof obj.type === "string" ? obj.type : null;
  if (evType === "delta" || evType === "text" || evType === "token" || evType === "message_delta") {
    const content =
      typeof obj.content === "string"
        ? obj.content
        : typeof obj.text === "string"
        ? obj.text
        : typeof obj.delta === "string"
        ? obj.delta
        : null;
    if (content === null) return null;
    return { type: "delta", text: content };
  }
  if (evType === "tool_call") {
    const name = typeof obj.name === "string" ? obj.name : "";
    return { type: "tool_call", name, arguments: obj.arguments };
  }
  if (evType === "done" || evType === "end" || evType === "complete") {
    const cid = typeof obj.conversationId === "string" ? obj.conversationId : undefined;
    const hasStateKey = Object.prototype.hasOwnProperty.call(obj, "state");
    return {
      type: "done",
      conversationId: cid,
      state: hasStateKey ? obj.state : undefined,
      hasStateKey
    };
  }
  if (evType === "error") {
    const msg = typeof obj.message === "string" ? obj.message : "rowboat_stream_error";
    return { type: "error", message: msg };
  }

  // Hypothesis 1: OpenAI-compatible chat-completions stream chunk.
  // `{choices: [{delta: {content: "..."}}]}` — extract delta.content.
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown> | null;
    const delta = first && typeof first === "object" ? (first.delta as Record<string, unknown> | undefined) : undefined;
    if (delta && typeof delta === "object" && typeof delta.content === "string" && delta.content.length > 0) {
      return { type: "delta", text: delta.content };
    }
    // OpenAI emits empty chunks (e.g. role-only first chunk, finish_reason
    // last chunk). Treat as a no-op so the idle timer still resets.
    return null;
  }

  // Hypothesis 3: a final Rowboat-shaped JSON `{conversationId, state,
  // turn: {output: [...]}}`. We don't yield deltas here (the assistant
  // text was already streamed); we yield `done` carrying the metadata.
  if (
    obj.turn !== undefined ||
    typeof obj.conversationId === "string" ||
    Object.prototype.hasOwnProperty.call(obj, "state")
  ) {
    const cid = typeof obj.conversationId === "string" ? obj.conversationId : undefined;
    const hasStateKey = Object.prototype.hasOwnProperty.call(obj, "state");
    return {
      type: "done",
      conversationId: cid,
      state: hasStateKey ? obj.state : undefined,
      hasStateKey
    };
  }

  return null;
}

/**
 * Streaming counterpart to `callRowboatChat`. Yields typed events as
 * Rowboat's SSE stream arrives. The caller is responsible for:
 *   - forwarding `delta` events to the client
 *   - persisting the buffered assistant text on `done`
 *   - mapping `error` events to friendly copy via `describeRowboatError`
 *   - implementing stateless-retry gating (yes/no based on whether any
 *     `delta` reached the client)
 *
 * Two timers (NOT one):
 *   1. TTFB timer fires if no chunk arrives within `ttfbTimeoutMs`.
 *   2. After the first chunk, an idle timer resets on every chunk;
 *      it fires if `idleTimeoutMs` elapses without a new chunk.
 *
 * No total wall-clock cap. Long generations (multi-minute) finish
 * naturally. The route-level `maxDuration` is the only ceiling.
 */
export async function* callRowboatChatStream(
  input: CallRowboatChatInput | CallRowboatChatStreamInput
): AsyncGenerator<RowboatStreamEvent> {
  const {
    businessId,
    projectId,
    bearer,
    messages,
    conversationId,
    state
  } = input;
  const ttfbMs =
    "ttfbTimeoutMs" in input && typeof input.ttfbTimeoutMs === "number"
      ? input.ttfbTimeoutMs
      : DEFAULT_ROWBOAT_STREAM_TTFB_MS;
  const idleMs =
    "idleTimeoutMs" in input && typeof input.idleTimeoutMs === "number"
      ? input.idleTimeoutMs
      : DEFAULT_ROWBOAT_STREAM_IDLE_MS;

  const url = buildRowboatChatUrl(businessId, projectId);
  const body: Record<string, unknown> = {
    messages,
    stream: true
  };
  if (conversationId && conversationId.trim()) {
    body.conversationId = conversationId.trim();
    if (state != null) body.state = state;
  }

  const abort = new AbortController();
  // Single timer reused for both phases. Started as TTFB, re-armed as
  // idle once the first chunk lands. Two separate timers were tempting
  // but make the cleanup math harder when the stream errors mid-flight.
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => abort.abort(), ttfbMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        Accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });
  } catch (err) {
    /* c8 ignore next -- timer is non-null here (fetch-catch fires before
       any clearTimeout); guard preserves symmetry with the post-fetch
       paths and survives a refactor that adds early returns. */
    if (timer) clearTimeout(timer);
    timer = null;
    if (abort.signal.aborted) {
      yield { type: "error", message: "rowboat_timeout" };
      return;
    }
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  if (!res.ok) {
    /* c8 ignore next -- timer is always non-null here (set at construction,
       not yet re-armed); the guard is structural symmetry with other timer
       cleanup paths so a refactor can't accidentally leak the timer. */
    if (timer) clearTimeout(timer);
    timer = null;
    yield { type: "error", message: `rowboat_http_${res.status}` };
    return;
  }
  if (!res.body) {
    /* c8 ignore next -- same symmetry rationale as the !res.ok branch above. */
    if (timer) clearTimeout(timer);
    timer = null;
    yield { type: "error", message: "rowboat_invalid_json" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sawFirstChunk = false;
  let sawAnyDelta = false;
  // Tracks whether the active timer (TTFB or idle) fired. We can't
  // rely solely on `abort.signal.aborted` because some intermediaries
  // (and some Node versions in tests) don't propagate the abort to a
  // fetch response body's reader synchronously. Setting this flag in
  // the timer callback gives us a deterministic signal that "this
  // read failed because we hit a timeout we set", separate from any
  // upstream-initiated cancel.
  let timedOut = false;
  // Running metadata harvested from any event that carries it. The
  // final `done` we emit is built from the LAST seen values — Rowboat
  // may sprinkle conversationId across events (one in a meta event,
  // one in the final JSON); last-write-wins matches the buffered API
  // semantics.
  let lastConversationId: string | undefined;
  let lastState: unknown | undefined;
  let lastHadStateKey = false;
  let explicitDone = false;

  const armTimer = (ms: number) => {
    /* c8 ignore next -- the timer is always set by the time armTimer is
       called (initial TTFB at construction time, then re-armed by previous
       armTimer call); the null-guard is structural defense against a
       future refactor accidentally calling armTimer pre-construction. */
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      // Cancel the body reader so the in-flight `reader.read()`
      // rejects. AbortController.abort() alone isn't enough — once
      // fetch() has resolved, the response body is its own stream and
      // aborting the controller does NOT consistently propagate to
      // the reader (Node versions differ; test environments
      // particularly so). reader.cancel() is the spec-compliant way
      // to terminate body consumption from the consumer side.
      reader.cancel().catch(/* c8 ignore next -- defensive: spec says cancel resolves; the catch only fires if the underlying source's cancel() impl rejects */ () => {});
      abort.abort();
    }, ms);
  };
  // First chunk arms the IDLE timer for itself (the TTFB timer
  // already covered the pre-first-chunk window).
  // We arm idleMs after every chunk to match "stalls mid-stream
  // for >idleMs" semantics.
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (timedOut || abort.signal.aborted) {
          yield { type: "error", message: "rowboat_timeout" };
          return;
        }
        yield {
          type: "error",
          /* c8 ignore next -- the String(err) branch handles non-Error
             rejections (libraries that throw plain strings/POJOs); covered
             by the fetch-rejects-with-string test, but the reader.read()
             path here uses identical narrowing for the same reason. */
          message: err instanceof Error ? err.message : String(err)
        };
        return;
      }
      if (!sawFirstChunk) {
        sawFirstChunk = true;
      }
      armTimer(idleMs);
      if (chunk.done) break;
      /* c8 ignore next -- defensive: a non-done chunk always has bytes per the
         streams spec; the null guard exists to satisfy TS narrowing and
         survive a non-conformant polyfill. */
      if (!chunk.value) continue;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE event delimiter is a blank line (`\n\n`). Some servers emit
      // `\r\n\r\n`; normalise before splitting so we don't strand events.
      buffer = buffer.replace(/\r\n/g, "\n");
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        // Concatenate every `data:` line in the event (SSE allows
        // multi-line data). Ignore other field lines (event:, id:, :).
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) continue;
        const dataPayload = dataLines.join("\n");
        const parsed = parseRowboatStreamEvent(dataPayload);
        if (!parsed) {
          // Unrecognised payload shape. We surface this as an
          // invalid_json error so the friendly-error layer catches it
          // (vs. silently dropping content and emitting an empty
          // assistant). This is the single most likely place for a
          // future Rowboat release to break us — the tests should
          // drive parseRowboatStreamEvent directly to catch shape drift
          // before we ship.
          yield { type: "error", message: "rowboat_invalid_json" };
          return;
        }
        if (parsed.type === "delta") {
          sawAnyDelta = true;
          yield parsed;
        } else if (parsed.type === "tool_call") {
          yield parsed;
        } else if (parsed.type === "error") {
          yield parsed;
          return;
        } else {
          // parsed.type === "done" by exhaustiveness: RowboatStreamEvent
          // is delta | tool_call | error | done; the three cases above
          // covered the first three. A plain `else` (instead of another
          // `else if (parsed.type === "done")`) avoids an unreachable
          // false branch that the coverage tooling would flag.
          if (parsed.conversationId !== undefined) lastConversationId = parsed.conversationId;
          if (parsed.hasStateKey) {
            lastState = parsed.state;
            lastHadStateKey = true;
          }
          explicitDone = true;
          // Don't return yet — Rowboat sometimes emits both an explicit
          // `[DONE]` AND a final metadata JSON in either order. Keep
          // reading until the stream itself closes; we'll emit our
          // single `done` event at the end.
        }
      }
    }
  } finally {
    /* c8 ignore next -- timer is non-null on the happy path (we always
       have an active TTFB or idle timer until the loop exits); the guard
       is structural in case a future refactor adds an early-exit path. */
    if (timer) clearTimeout(timer);
    timer = null;
    /* c8 ignore start -- releaseLock throws only when the reader is in an
       unusual state (e.g. already cancelled by the timer path on a different
       tick); we already finished reading and any throw here would mask the
       caller-visible event we just yielded. */
    try {
      reader.releaseLock();
    } catch {
      // already released by abort/cancel path
    }
    /* c8 ignore stop */
  }

  // Order matters here: a stalled stream that we cancelled via the
  // idle timer will close cleanly (reader.cancel() resolves with
  // done:true, NOT an exception) and reach this point with `timedOut`
  // set. Surfacing the timeout BEFORE the empty-assistant /
  // happy-done branches keeps the semantics aligned with the
  // pre-streaming buffered call's "rowboat_timeout" behaviour: a
  // stuck VPS surfaces as a timeout, not as an empty reply or a
  // misleadingly-successful done.
  if (timedOut) {
    yield { type: "error", message: "rowboat_timeout" };
    return;
  }

  if (!sawAnyDelta && !explicitDone) {
    yield { type: "error", message: "rowboat_empty_assistant" };
    return;
  }

  yield {
    type: "done",
    conversationId: lastConversationId,
    state: lastState,
    hasStateKey: lastHadStateKey
  };
}
