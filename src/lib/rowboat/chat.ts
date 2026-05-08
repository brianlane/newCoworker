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
   * Hard cap on time-to-first-byte. 480s (8 min) default. We
   * intentionally let TTFB run nearly to the route's `maxDuration`
   * (800s) before bailing — owners have legitimate workflows where
   * Rowboat needs to load a cold model, retrieve a large customer
   * history, AND plan a multi-tool response before emitting its
   * first token. Production logs (May 2026) showed a query
   * consistently taking 91s pre-token; bumping past that with room
   * to spare while still catching truly wedged tunnels.
   *
   * Distinct from `idleTimeoutMs` because TTFB has wildly different
   * latency characteristics from mid-stream tokens. TTFB is
   * dominated by model load + retrieval + first inference pass
   * (legitimately variable, can be minutes). Idle is "the model
   * paused mid-token-stream" — once tokens are flowing, a 30s gap
   * almost always means something is genuinely broken, so the idle
   * cap stays tight at 30s regardless of how loose TTFB gets.
   *
   * History: 30s (initial) → 90s (PR #77, May 7) → 480s (PR #77
   * follow-up, May 7 evening) after owners reported the 90s cap
   * still firing on the most complex queries.
   */
  ttfbTimeoutMs?: number;
  /**
   * Per-chunk idle cap. Resets on every received SSE chunk. 30s default
   * catches mid-stream stalls without killing legitimate long
   * generations. There is intentionally NO total runtime cap: the model
   * takes as long as it takes, bounded only by Vercel `maxDuration`
   * (800s) at the route level.
   */
  idleTimeoutMs?: number;
  /**
   * External abort signal. When this fires, the streaming function
   * aborts the in-flight upstream fetch + body reader and yields no
   * further events. Used by /api/dashboard/chat to propagate browser
   * disconnect (`request.signal`) all the way down to the per-tenant
   * Rowboat call — without this plumbing, a client navigating away
   * mid-generation leaves the per-tenant Ollama generating tokens
   * nobody will ever read until one of the internal timers trips
   * (idle: 30s mid-stream, TTFB: 90s pre-token), wasting up to that
   * much VPS work per disconnect.
   */
  signal?: AbortSignal;
};

export const DEFAULT_ROWBOAT_STREAM_TTFB_MS = 480_000;
export const DEFAULT_ROWBOAT_STREAM_IDLE_MS = 30_000;

/**
 * Sentinel returned by `parseRowboatStreamEvent` when the SSE event
 * was syntactically valid AND structurally recognized but carried no
 * payload the caller should act on. The stream loop SKIPS noops (the
 * idle timer still resets because a chunk arrived); only `null`
 * returns surface as `rowboat_invalid_json`.
 *
 * This distinction matters for OpenAI-compatible streams: the very
 * first chunk is `{choices:[{delta:{role:"assistant"}}]}` (no content
 * yet) and the last is `{choices:[{finish_reason:"stop",delta:{}}]}`
 * (no content, just terminator). Both are normal — failing the
 * stream on either would kill every OpenAI-shaped reply before it
 * produced a single token.
 */
export const ROWBOAT_STREAM_NOOP = "noop" as const;
export type RowboatStreamParseResult =
  | RowboatStreamEvent
  | typeof ROWBOAT_STREAM_NOOP
  | null;

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
 * Return contract:
 *   - `null` ⇒ payload is genuinely unrecognized; the caller MUST
 *     surface this as `rowboat_invalid_json` (Rowboat changed shape
 *     and we want the regression visible at the friendly-error layer).
 *   - `ROWBOAT_STREAM_NOOP` ⇒ payload was structurally recognized but
 *     carries no actionable content (OpenAI keep-alives, role-only
 *     first chunks, finish_reason terminators, Rowboat-typed deltas
 *     with no body). Caller skips it. The idle timer still resets
 *     because the chunk arrived.
 *   - typed event ⇒ forward to consumer.
 */
export function parseRowboatStreamEvent(rawData: string): RowboatStreamParseResult {
  const trimmed = rawData.trim();
  // Empty data lines are common SSE keep-alives — `noop` (skippable),
  // not an error.
  if (!trimmed) return ROWBOAT_STREAM_NOOP;
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
    // A delta event with no string content is malformed but tolerated
    // as a noop — be liberal in what we accept rather than killing the
    // whole stream over an upstream bug. The idle timer still ticks.
    if (content === null) return ROWBOAT_STREAM_NOOP;
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
    // last chunk, choices:[null] keep-alive). All NORMAL — `noop` so the
    // stream loop skips them and keeps reading. Returning `null` here was
    // the bug (Codex P1 + Cursor Bugbot HIGH on PR #76): a standard
    // OpenAI-shaped stream emits the role-only chunk as its very first
    // event, which would have killed the whole reply before any token.
    return ROWBOAT_STREAM_NOOP;
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
  input: CallRowboatChatStreamInput
): AsyncGenerator<RowboatStreamEvent> {
  // Cursor Bugbot Low on PR #76 commit 1ff78e9: pre-fix the input
  // type was the union `CallRowboatChatInput | CallRowboatChatStreamInput`,
  // which let a future caller pass the non-streaming shape's
  // `timeoutMs` field — silently dropped here in favor of the 30s
  // TTFB / 30s idle defaults. The non-streaming `callRowboatChat`
  // and the streaming `callRowboatChatStream` have intentionally
  // different timeout models (single hard cap vs separate TTFB +
  // idle caps), so the union created a misleading contract. Narrow
  // to ONLY the streaming-specific input shape so TypeScript rejects
  // any non-streaming-shaped call at compile time.
  const {
    businessId,
    projectId,
    bearer,
    messages,
    conversationId,
    state,
    ttfbTimeoutMs,
    idleTimeoutMs
  } = input;
  const ttfbMs = ttfbTimeoutMs ?? DEFAULT_ROWBOAT_STREAM_TTFB_MS;
  const idleMs = idleTimeoutMs ?? DEFAULT_ROWBOAT_STREAM_IDLE_MS;

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
  // Hoisted shared state. `reader` is null until res.body is unwrapped
  // post-fetch; `timedOut` is the deterministic "we hit a timeout we
  // set" signal that the post-loop code uses to surface
  // `rowboat_timeout` (the abort signal alone isn't sufficient — see
  // the rowboat_timeout block at the bottom). Both are referenced by
  // the shared `fireTimeout` callback below so the TTFB and idle
  // timers can use the same cancellation path.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timedOut = false;

  // Shared timeout callback used by BOTH the initial TTFB timer AND
  // the per-chunk idle timer. Critical for the cold-tenant scenario
  // (Cursor Bugbot Medium on PR #76 commit abb057f): when fetch()
  // resolves quickly (Vercel/Cloudflare connection establishes in
  // 1-2s) but the per-tenant Ollama hasn't loaded the model yet
  // (25+ seconds for a cold model), `reader.read()` blocks waiting
  // for the first body byte. Pre-fix the initial TTFB timer ONLY
  // called abort.abort(), which the comment-block on lines 617-622
  // already documents is insufficient: AbortController.abort() does
  // NOT consistently propagate to a response body's reader once the
  // fetch promise has resolved (Node version dependent, and our
  // test environment specifically reproduces the leak). The result
  // was a hung generator past the TTFB cap. Now both timers go
  // through this single callback so reader.cancel() always fires
  // (when the reader exists) and `timedOut` is set deterministically.
  const fireTimeout = () => {
    timedOut = true;
    abort.abort();
    if (reader) {
      /* c8 ignore start -- the .catch() handler exists only to swallow a
         reader.cancel() rejection that the streams spec says cannot
         happen for our usage; covered by the same rationale as the
         armTimer / cancelUpstream cancel-catches below. */
      reader.cancel().catch(() => {});
      /* c8 ignore stop */
    }
  };

  // External signal forwarding: when the caller's signal fires
  // (client browser disconnect, "New conversation" mid-generation,
  // component unmount), tear down both the in-flight fetch AND the
  // body reader so the per-tenant Rowboat stops generating tokens
  // promptly. Pre-fetch we only have `abort` to cancel; post-fetch we
  // ALSO need `reader.cancel()` because aborting the controller no
  // longer reliably propagates to the body stream once fetch resolved
  // (Node version dependent). The `cancelUpstream` indirection lets
  // us upgrade the cancellation behaviour after the reader is
  // constructed without re-registering the listener.
  const externalSignal = "signal" in input ? input.signal : undefined;
  let cancelUpstream: () => void = () => abort.abort();
  const onExternalAbort = () => cancelUpstream();
  if (externalSignal) {
    if (externalSignal.aborted) {
      // Already cancelled before we even started. Skip the fetch
      // entirely by aborting up front; the catch below will surface
      // the timeout-style "abort" path naturally.
      abort.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  // Single timer reused for both phases. Started as TTFB, re-armed as
  // idle once the first chunk lands. Two separate timers were tempting
  // but make the cleanup math harder when the stream errors mid-flight.
  // Both phases share `fireTimeout` so the TTFB callback also
  // cancels the reader once one exists (cold-tenant fix above).
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(fireTimeout, ttfbMs);

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
    // Remove the external listener on every early return — `once:true`
    // covers the fired case but not the "never fired and we bailed
    // pre-reader" case, where the listener would otherwise outlive the
    // function.
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
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
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    yield { type: "error", message: `rowboat_http_${res.status}` };
    return;
  }
  if (!res.body) {
    /* c8 ignore next -- same symmetry rationale as the !res.ok branch above. */
    if (timer) clearTimeout(timer);
    timer = null;
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    yield { type: "error", message: "rowboat_invalid_json" };
    return;
  }

  reader = res.body.getReader();
  // Local non-null alias so closures below can reference the reader
  // without TS narrowing tripping on the hoisted-and-reassigned outer
  // `reader: ReadableStreamDefaultReader | null` (which is hoisted
  // so `fireTimeout` — which runs both before and after this point
  // — can read the latest value).
  const activeReader = reader;
  // Upgrade `cancelUpstream` now that we have a reader: an external
  // abort fired post-fetch must also cancel the body stream, otherwise
  // the per-tenant Rowboat keeps streaming bytes into a TCP socket we
  // no longer drain. Idempotent — safe even if the cancellation also
  // came from our own timer (which already calls reader.cancel()).
  cancelUpstream = () => {
    abort.abort();
    /* c8 ignore start -- the .catch() handler exists only to swallow a
       reader.cancel() rejection that the streams spec says cannot
       happen for our usage (we don't pass a `reason` and the body is a
       fetch response, not a custom underlying source); deterministically
       reproducing a rejection here in tests would require monkey-patching
       Node's body stream internals, which is more brittle than the value
       of the coverage. */
    activeReader.cancel().catch(() => {});
    /* c8 ignore stop */
  };
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sawAnyDelta = false;
  // Running metadata harvested from any event that carries it. The
  // final `done` we emit is built from the LAST seen values — Rowboat
  // may sprinkle conversationId across events (one in a meta event,
  // one in the final JSON); last-write-wins matches the buffered API
  // semantics.
  let lastConversationId: string | undefined;
  let lastState: unknown | undefined;
  let lastHadStateKey = false;

  const armTimer = (ms: number) => {
    /* c8 ignore next -- the timer is always set by the time armTimer is
       called (initial TTFB at construction time, then re-armed by previous
       armTimer call); the null-guard is structural defense against a
       future refactor accidentally calling armTimer pre-construction. */
    if (timer) clearTimeout(timer);
    // armTimer always runs post-reader, so we can call the shared
    // fireTimeout directly (which already handles reader.cancel()
    // when reader is non-null). Keeps cancellation logic in one place.
    timer = setTimeout(fireTimeout, ms);
  };
  // First chunk arms the IDLE timer for itself (the TTFB timer
  // already covered the pre-first-chunk window).
  // We arm idleMs after every chunk to match "stalls mid-stream
  // for >idleMs" semantics.
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await activeReader.read();
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
        if (parsed === ROWBOAT_STREAM_NOOP) {
          // Recognized-but-empty chunk (OpenAI role-only first event,
          // finish_reason terminator, blank keep-alive, or a malformed
          // delta with no content). Skip — the idle timer already
          // reset on this chunk arriving, and the next chunk will
          // carry real content.
          continue;
        }
        if (parsed === null) {
          // Genuinely unrecognized payload shape. We surface this as
          // an invalid_json error so the friendly-error layer catches
          // it (vs. silently dropping content and emitting an empty
          // assistant). This is the single most likely place for a
          // future Rowboat release to break us — the tests should
          // drive parseRowboatStreamEvent directly to catch shape
          // drift before we ship.
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
          // Don't return yet — Rowboat sometimes emits both an explicit
          // `[DONE]` AND a final metadata JSON in either order. Keep
          // reading until the stream itself closes; we'll emit our
          // single `done` event at the end. Whether the upstream sent
          // an explicit done sentinel doesn't change the empty-
          // assistant gate below: a stream with zero delta events is
          // empty, full stop, regardless of how it terminated.
        }
      }
    }
  } finally {
    /* c8 ignore next -- timer is non-null on the happy path (we always
       have an active TTFB or idle timer until the loop exits); the guard
       is structural in case a future refactor adds an early-exit path. */
    if (timer) clearTimeout(timer);
    timer = null;
    // Drop the external-signal listener so a long-lived caller signal
    // (e.g. the parent component's unmount AbortController held across
    // many turns) doesn't accumulate handlers across calls. `once:true`
    // covers the abort-fired case; this covers the never-aborted case.
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    /* c8 ignore start -- releaseLock throws only when the reader is in an
       unusual state (e.g. already cancelled by the timer path on a different
       tick); we already finished reading and any throw here would mask the
       caller-visible event we just yielded. */
    try {
      activeReader.releaseLock();
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
  //
  // `abort.signal.aborted` covers the external-abort path too: when a
  // caller's signal fires we call `cancelUpstream()` → `abort.abort()`
  // + `reader.cancel()`, the reader returns done:true cleanly, and we
  // land here with no delta. From the caller's perspective an external
  // abort IS effectively a timeout (they gave up waiting); surfacing
  // it as `rowboat_timeout` keeps describeRowboatError's friendly
  // message uniform whether the route timed us out or the user
  // navigated away mid-generation. (The route's `closed` check has
  // already torn down the NDJSON controller in the disconnect case,
  // so this event is for telemetry only.)
  if (timedOut || abort.signal.aborted) {
    yield { type: "error", message: "rowboat_timeout" };
    return;
  }

  // Empty assistant turn — surface as rowboat_empty_assistant
  // REGARDLESS of whether Rowboat sent an explicit done sentinel.
  // Cursor Bugbot Medium on PR #76 commit d6a3145: pre-fix this
  // gate was `!sawAnyDelta && !explicitDone`, which let an explicit
  // `[DONE]` (or done-typed event) with zero content events through
  // as a normal `done` — the route then saw `kind: "done"` and
  // skipped the stateless-retry gate entirely. Semantically a stream
  // with no delta events IS empty whether or not it terminated
  // gracefully, and the retry path (drop conversationId/state and
  // call again) is exactly what recovers from the most likely cause:
  // a stale conversation continuation that the per-tenant Rowboat
  // can't resume. `rowboat_empty_assistant` is in
  // STATELESS_RETRY_ERRORS, so surfacing it here lets the route
  // try one more stateless turn instead of immediately telling the
  // owner "no reply".
  if (!sawAnyDelta) {
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
