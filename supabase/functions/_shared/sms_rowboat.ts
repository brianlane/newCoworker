/**
 * Rowboat /chat client for the SMS inbound worker.
 *
 * Closes "sharp edge #1" of the cross-channel memory plan: SMS lacked
 * the dashboard chat's stateless retry, so an evicted Rowboat
 * conversation (model restart, version skew, retention sweep) would
 * burn MAX_ATTEMPTS retries against the same stale conversationId
 * and finally dead-letter the job, silently breaking the SMS thread.
 *
 * Extracted from index.ts so we can vitest the retry logic without
 * Deno globals or Supabase client mocking — the same pattern the
 * other `_shared/` modules follow.
 */

/**
 * Errors where Rowboat's response strongly suggests the *server-side*
 * conversation referenced by our stored conversationId is gone OR
 * the conversation is otherwise unhealthy. On these we get one
 * stateless retry with the continuation dropped — Rowboat will treat
 * the SMS turn as a fresh thread and produce a reply rooted in just
 * the new user message.
 *
 * Mirrors src/app/api/dashboard/chat/route.ts's STATELESS_RETRY_ERRORS
 * deliberately: the underlying Rowboat /chat contract is identical
 * for both surfaces (only the post-reply persistence differs).
 *
 * Deliberately excluded:
 *   - rowboat_timeout: timing out doesn't tell us anything about
 *     conversation state and a stateless retry would just double the
 *     load on a slow VPS.
 *   - rowboat_http_401 / 403: auth is global, retrying with the same
 *     bearer would fail identically.
 */
export const STATELESS_RETRY_ERRORS = new Set([
  "rowboat_http_400",
  "rowboat_http_404",
  "rowboat_http_409",
  "rowboat_http_500",
  "rowboat_http_502",
  "rowboat_http_503",
  "rowboat_empty_assistant"
]);

export type RowboatChatCallInput = {
  chatUrl: string;
  bearer: string;
  userText: string;
  conversationId: string | null;
  state: unknown | null;
  timeoutMs: number;
  /**
   * Optional: business-level static memory (vault preamble) +
   * customer-level rolling summary, prepended as a `role: "system"`
   * message on the FIRST stateless turn so a freshly-rooted Rowboat
   * conversation has continuity. Phase 3 of the cross-channel plan
   * populates this; passing null/undefined keeps the original
   * behaviour where SMS sends only the new user line.
   *
   * Why this lives on the call input and not on the helper: the
   * preamble is per-customer, not per-business — it'd be wrong for
   * the helper to look it up and apply it indiscriminately.
   */
  customerPreamble?: string | null;
};

export type RowboatChatCallResult = {
  reply: string;
  conversationId?: string;
  state: unknown | undefined;
  hasStateKey: boolean;
};

export type StatelessFallbackResult = RowboatChatCallResult & {
  /**
   * True iff the first call failed with a STATELESS_RETRY_ERRORS code
   * AND we re-issued without conversationId/state. Callers MUST treat
   * the stored rowboat_conversation_id as known-stale when this is
   * true — even if the retry's response omits a fresh conversationId
   * — otherwise the next message replays the same fail-then-retry
   * cycle indefinitely (Bugbot Low pattern from PR #71).
   */
  retriedStateless: boolean;
};

export function parseRowboatChatJson(json: unknown): RowboatChatCallResult {
  const o = json as {
    turn?: { output?: Array<{ role?: string; content?: string | null }> };
    conversationId?: string;
    state?: unknown;
  };
  const hasStateKey =
    json !== null &&
    typeof json === "object" &&
    Object.prototype.hasOwnProperty.call(json, "state");
  let reply = "";
  for (const m of o.turn?.output ?? []) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      reply = m.content.trim();
      break;
    }
  }
  return {
    reply,
    conversationId: o.conversationId,
    state: hasStateKey ? o.state : undefined,
    hasStateKey
  };
}

/**
 * Single Rowboat /chat round trip. Throws an Error whose message is
 * one of: "rowboat_timeout", "rowboat_http_<status>",
 * "rowboat_empty_assistant", or a generic fetch error message.
 *
 * Sends only the new SMS turn (plus optional system preamble) —
 * Rowboat reconstructs prior context from `conversationId` + `state`
 * when supplied, exactly per the §10 SMS contract. NEVER replays raw
 * assistant rows here: Rowboat's Zod input validator rejects plain
 * `{role:"assistant",content}` (it expects agent/tool-shaped rows
 * produced by Rowboat itself), so a transcript replay would 400
 * every time.
 *
 * @param fetchImpl Defaults to globalThis.fetch. Tests inject a
 *   stub here without monkey-patching the global so the helper
 *   can be exercised in vitest under Node.
 */
export async function callRowboatChatOnce(
  input: RowboatChatCallInput,
  fetchImpl: typeof fetch = fetch
): Promise<RowboatChatCallResult> {
  const messages: Array<Record<string, unknown>> = [];
  const preamble = input.customerPreamble?.trim();
  if (preamble) {
    messages.push({ role: "system", content: preamble });
  }
  messages.push({ role: "user", content: `[SMS] ${input.userText}` });

  const chatBody: Record<string, unknown> = { messages, stream: false };
  const conv = input.conversationId?.trim();
  if (conv) {
    chatBody.conversationId = conv;
    if (input.state != null) {
      chatBody.state = input.state;
    }
  }

  const chatAbort = new AbortController();
  const chatTimer = setTimeout(() => chatAbort.abort(), input.timeoutMs);
  let chatRes: Response;
  try {
    chatRes = await fetchImpl(input.chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.bearer}`
      },
      body: JSON.stringify(chatBody),
      signal: chatAbort.signal
    });
  } catch (fetchErr) {
    if (chatAbort.signal.aborted) {
      throw new Error("rowboat_timeout");
    }
    throw fetchErr;
  } finally {
    clearTimeout(chatTimer);
  }
  if (!chatRes.ok) {
    throw new Error(`rowboat_http_${chatRes.status}`);
  }
  const parsed = parseRowboatChatJson(await chatRes.json());
  if (!parsed.reply) {
    throw new Error("rowboat_empty_assistant");
  }
  return parsed;
}

/**
 * Call Rowboat with the stored continuation, retry once stateless on
 * a STATELESS_RETRY_ERRORS class failure (and only when we actually
 * had a continuation to drop — there's nothing for a retry to undo
 * otherwise).
 *
 * Why ONLY one retry: if the stateless retry also fails, the problem
 * isn't conversation state and another attempt won't help. Surfacing
 * the *retry's* error gives the caller the more recent diagnostic.
 */
export async function callSmsRowboatWithStatelessFallback(
  input: RowboatChatCallInput,
  fetchImpl: typeof fetch = fetch
): Promise<StatelessFallbackResult> {
  const hadContinuation =
    typeof input.conversationId === "string" && input.conversationId.trim().length > 0;
  try {
    const out = await callRowboatChatOnce(input, fetchImpl);
    return { ...out, retriedStateless: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isStaleContinuation = hadContinuation && STATELESS_RETRY_ERRORS.has(message);
    if (!isStaleContinuation) throw err;
    const out = await callRowboatChatOnce(
      { ...input, conversationId: null, state: null },
      fetchImpl
    );
    return { ...out, retriedStateless: true };
  }
}
