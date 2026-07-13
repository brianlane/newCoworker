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
 * conversation referenced by our stored conversationId is gone OR the
 * conversation is otherwise unhealthy. On these we get one stateless
 * retry with the continuation dropped — Rowboat will treat the SMS
 * turn as a fresh thread and produce a reply rooted in just the new
 * user message (plus `statelessContextExtra`, see below).
 *
 * Deliberately excluded:
 *   - rowboat_timeout: timing out doesn't tell us anything about
 *     conversation state and a stateless retry would just double the
 *     load on a slow VPS.
 *   - rowboat_http_401 / 403: auth is global, retrying with the same
 *     bearer would fail identically.
 */
export const CONVERSATION_STATE_RETRY_ERRORS = new Set([
  "rowboat_http_400",
  "rowboat_http_404",
  "rowboat_http_409",
  "rowboat_empty_assistant"
]);

/**
 * Errors that are USUALLY a transient server/upstream failure (the
 * llm-router's Gemini 503s surface as Rowboat 500s), not a stale
 * continuation. A stateless retry here would throw away the whole
 * conversation history to "fix" a problem that isn't conversation
 * state — production showed the model restarting lead intake ("what
 * prompted you to shop around?") mid-thread during a Gemini outage
 * (Truly Insurance, 2026-07-13).
 *
 * These are stateless-retry-eligible ONLY when the caller opts in via
 * `allowStatelessOnServerErrors` — the SMS worker does so on late
 * attempts, where a persistent 5xx may in fact be a poisoned
 * conversation and the reset is the last resort before dead-letter.
 * Early attempts surface the error to the job-level retry, which
 * re-runs STATEFUL with the thread intact.
 */
export const TRANSIENT_SERVER_RETRY_ERRORS = new Set([
  "rowboat_http_500",
  "rowboat_http_502",
  "rowboat_http_503"
]);

/**
 * First job attempt (attempt_count, incremented at claim) on which a 5xx may
 * trigger the history-dropping stateless retry. Below it, the 5xx surfaces
 * to the job-level retry, which re-runs STATEFUL with the thread intact —
 * a transient Gemini outage must not cost the customer their thread context
 * (2026-07-13 incident). Lives here (not in the worker entrypoint) so the
 * integration suite can pin the exact threshold the worker deploys with.
 */
export const STATELESS_5XX_MIN_ATTEMPT = 3;

/**
 * Union of both classes — the full set of errors that MAY warrant a
 * stateless retry. Kept exported because the dashboard chat path
 * mirrors this concept (src/app/api/dashboard/chat/route.ts); note the
 * dashboard's stateless input carries the FULL history tail, so a
 * reset there never loses context the way the SMS path can.
 */
export const STATELESS_RETRY_ERRORS = new Set([
  ...CONVERSATION_STATE_RETRY_ERRORS,
  ...TRANSIENT_SERVER_RETRY_ERRORS
]);

export type RowboatChatCallInput = {
  chatUrl: string;
  bearer: string;
  userText: string;
  conversationId: string | null;
  state: unknown | null;
  /**
   * Per-call timeout for a single Rowboat round trip. NOTE: this is
   * NOT the combined budget across initial + retry — that's
   * `budgetMs` on the fallback wrapper below.
   */
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
  /**
   * Optional Rowboat agent to enter for this turn (the SMS spend cap passes the
   * local Qwen agent over cap, otherwise the Gemini `Coworker`). NOTE: Rowboat
   * IGNORES startAgent whenever a conversationId is supplied — it resumes the
   * agent the thread was bound to — so a startAgent override only takes effect on
   * a STATELESS call (conversationId = null). The caller is responsible for
   * dropping the continuation when it needs the override honored.
   */
  startAgent?: string | null;
};

export type StatelessFallbackInput = RowboatChatCallInput & {
  /**
   * Combined wall-clock budget for the initial call AND the optional
   * stateless retry. When omitted, falls back to `timeoutMs * 2` —
   * preserves pre-fix behaviour for callers that haven't been
   * updated, but new callers MUST pass an explicit budget aligned
   * with the surrounding cron / Edge function timeout.
   *
   * Why it's needed: pg_cron caps the SMS worker HTTP invocation at
   * 90s (see migrations/20260505180000_sms_inbound_worker_cron_timeout.sql).
   * A first call that fails at the 60s `timeoutMs` ceiling plus a
   * fresh-window retry of another 60s would put total Rowboat wall
   * time at ~120s, well past the cron cap — pg_cron disconnects, the
   * Telnyx outbound never goes out, the job sits at 'processing'
   * until the stale-claim sweep requeues it (Codex P1 / Cursor
   * Bugbot Medium feedback on PR #74). Bounding the retry at
   * (budget − elapsed) keeps the sum bounded.
   */
  budgetMs?: number;
  /**
   * Floor on the post-first-call remaining budget below which we
   * skip the stateless retry entirely. Same shape as the dashboard
   * chat helper: a Rowboat call that pages in a cold model takes
   * ~5s minimum on a small VPS, so anything below this is almost
   * guaranteed to abort before yielding a reply. Skipping surfaces
   * the *first* error to the caller — a more honest signal than
   * a self-inflicted "rowboat_timeout" from a doomed retry.
   */
  retryMinBudgetMs?: number;
  /**
   * Opt-in: also allow the stateless retry on
   * TRANSIENT_SERVER_RETRY_ERRORS (5xx). Default false — a 5xx is
   * usually an upstream model outage, and dropping the continuation
   * for it discards the whole SMS thread; the job-level retry
   * re-runs stateful instead. The SMS worker sets this on late
   * attempts only, when a persistent 5xx starts to look like a
   * poisoned conversation.
   */
  allowStatelessOnServerErrors?: boolean;
  /**
   * Extra system-preamble block appended ONLY on the stateless retry
   * call: a compact transcript of the recent SMS exchange, so a
   * freshly-rooted Rowboat conversation continues the thread instead
   * of restarting intake (the 2026-07-13 "what prompted you to shop
   * around?" repeat). Never sent on the first (stateful) attempt —
   * Rowboat already holds the history there.
   */
  statelessContextExtra?: string | null;
};

export const DEFAULT_RETRY_MIN_BUDGET_MS = 5_000;

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
  const startAgent = input.startAgent?.trim();
  if (startAgent) {
    chatBody.startAgent = startAgent;
  }
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
 *
 * Budget contract: `budgetMs` (when supplied) is the COMBINED wall
 * time across both attempts. The retry's timeoutMs is internally
 * capped at (budgetMs − elapsedSinceEntry); the retry is skipped
 * entirely when the remaining budget falls below
 * `retryMinBudgetMs`. This prevents a slow first failure from
 * granting the retry a fresh full window — exactly the race that
 * blew past the SMS worker's 90s pg_cron cap on PR #74 (Codex P1 /
 * Cursor Bugbot Medium).
 */
export async function callSmsRowboatWithStatelessFallback(
  input: StatelessFallbackInput,
  fetchImpl: typeof fetch = fetch
): Promise<StatelessFallbackResult> {
  const hadContinuation =
    typeof input.conversationId === "string" && input.conversationId.trim().length > 0;
  // Default: pre-fix behaviour — both calls get the full timeoutMs
  // independently. Callers SHOULD pass an explicit budgetMs so the
  // sum is bounded by the surrounding cron / Edge timeout.
  const budgetMs = input.budgetMs ?? input.timeoutMs * 2;
  const retryMinBudgetMs = input.retryMinBudgetMs ?? DEFAULT_RETRY_MIN_BUDGET_MS;
  const startedAt = Date.now();
  try {
    const out = await callRowboatChatOnce(input, fetchImpl);
    return { ...out, retriedStateless: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isStaleContinuation =
      hadContinuation &&
      (CONVERSATION_STATE_RETRY_ERRORS.has(message) ||
        (TRANSIENT_SERVER_RETRY_ERRORS.has(message) &&
          input.allowStatelessOnServerErrors === true));
    if (!isStaleContinuation) throw err;

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = budgetMs - elapsedMs;
    if (remainingMs < retryMinBudgetMs) {
      // Not enough wall time left to give the retry a realistic shot.
      // Re-throw the FIRST error so callers see the actual diagnostic
      // ("rowboat_http_500", say) instead of a self-inflicted
      // "rowboat_timeout" from a doomed retry.
      throw err;
    }

    // A stateless call roots a brand-new Rowboat conversation, so give it
    // the recent-thread transcript (when the caller supplied one) — without
    // it the model restarts intake mid-conversation.
    const statelessExtra = input.statelessContextExtra?.trim();
    const retryPreamble = [input.customerPreamble?.trim(), statelessExtra]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const out = await callRowboatChatOnce(
      {
        ...input,
        conversationId: null,
        state: null,
        customerPreamble: retryPreamble || null,
        // Cap the retry's per-call timeout at the remaining budget so
        // a slow Rowboat that hangs near the budget edge still aborts
        // cleanly inside the cron window. Also clamp by the original
        // per-call timeoutMs so we never *extend* a single call past
        // its configured ceiling.
        timeoutMs: Math.min(input.timeoutMs, remainingMs)
      },
      fetchImpl
    );
    return { ...out, retriedStateless: true };
  }
}
