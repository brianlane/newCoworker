/**
 * Rolling per-thread conversation summarizer.
 *
 * `HISTORY_TURNS = 20` in the chat route caps how much recent local
 * context we have available. Once a thread accrues more than 20
 * messages, anything older drops out of the live tail unless we hand
 * the model a compressed digest. This module produces that digest by
 * calling the local model (via the same Rowboat agent that handles
 * user chat) with a tightly-scoped summarizer prompt, then persisting
 * the result on the thread row.
 *
 * On every chat turn the route prepends summary_md as a system
 * message. The shape sent to Rowboat is:
 *
 *   <vault instructions>                ← static (syncVaultToVps)
 *   <rolling conversation summary>      ← this module, when set
 *   <recent-tail transcript system msg> ← only on fresh threads /
 *                                          stateless retries; omitted
 *                                          when Rowboat already has
 *                                          server-side memory via
 *                                          conversationId/state
 *   <new user message>
 *
 * Why we don't send the raw tail as `{ role: "assistant", … }` rows:
 * Rowboat's HTTP /chat validator rejects plain assistant messages on
 * input (it expects agent/tool-shaped rows). See
 * src/app/api/dashboard/chat/route.ts → buildRowboatChatMessages and
 * tests/integration/kvm-rowboat/rowboat-chat.ts:215 for the canonical
 * contract. For the live-context path we therefore lean on Rowboat's
 * server-side conversation memory; only when that memory is gone (or
 * has never existed) do we render the local tail as a single
 * transcript-shaped system message.
 *
 * Trigger gate (caller-side, fire-and-forget):
 *   total_messages - thread.summary_message_count >= SUMMARY_INTERVAL
 *
 * Failures are swallowed and logged: a degraded summary is acceptable;
 * crashing the chat POST on a summarizer hiccup is not. The next turn
 * will retry (gate is still open). The summary is hard-capped at
 * SUMMARY_MAX_CHARS so persona bleed or runaway models can't dominate
 * the prompt.
 *
 * NOTE on "use the local model": this routes through Rowboat
 * (callRowboatChat), which IS backed by the per-tenant Ollama on the
 * VPS — no centralized service involved. The agent's system
 * instructions still apply, so some persona bleed in summary text is
 * expected. Acceptable for v1; a dedicated summarizer-only Ollama
 * proxy can replace this without changing the contract.
 */

import { getBusinessConfig } from "@/lib/db/configs";
import {
  getThreadById,
  listMessages,
  updateThreadSummary,
  type DashboardChatMessageRow,
  type DashboardChatThreadRow
} from "@/lib/db/dashboard-chat";
import { logger } from "@/lib/logger";
import {
  callRowboatChat,
  type RowboatChatMessage
} from "@/lib/rowboat/chat";

/**
 * Re-summarize when the thread has accrued this many messages since
 * the last summary. Tuned to match HISTORY_TURNS in the chat route so
 * the summary picks up exactly where the live-tail truncation begins.
 */
export const SUMMARY_INTERVAL = 20;

/**
 * Number of recent messages we keep raw in the live tail. Older
 * messages are what the summary covers. MUST equal HISTORY_TURNS in
 * src/app/api/dashboard/chat/route.ts; if you change one, change both.
 */
export const SUMMARY_TAIL_KEEP = 20;

/** Hard cap on persisted summary text. */
export const SUMMARY_MAX_CHARS = 2000;

/** Default timeout for the summarizer call. Looser than chat (30s) since this
 * is fire-and-forget and the local model may be cold or context-stuffed. */
export const SUMMARY_TIMEOUT_MS = 60_000;

const SUMMARIZER_SYSTEM_INSTRUCTION = `SUMMARIZER MODE — DO NOT respond as the persona, agent, or assistant.

You will receive an excerpt of a long-running conversation between a business owner and their AI coworker. Produce a concise factual digest the agent can use to maintain continuity in future turns.

Output ONLY the summary text. Do NOT include preamble, sign-offs, or any meta-commentary. Hard limit: ~${SUMMARY_MAX_CHARS} characters.

Cover, in order:
1. Key facts the owner has shared (names, dates, products, decisions, preferences).
2. Open questions or commitments still pending.
3. Any stylistic / tonal preferences the owner has indicated for replies.

Do NOT invent details. If the conversation is short or low-content, output the shortest faithful summary possible.`;

export type SummarizeDeps = {
  callRowboatChat?: typeof callRowboatChat;
  getThreadById?: typeof getThreadById;
  listMessages?: typeof listMessages;
  updateThreadSummary?: typeof updateThreadSummary;
  getBusinessConfig?: typeof getBusinessConfig;
  /** Pulled from process.env at call time by default; overridable for tests. */
  rowboatBearer?: string;
};

export type SummarizeResult =
  | { ok: true; summary: string; messageCount: number; projectId: string }
  | { ok: false; reason: SummarizeFailureReason; detail?: string };

export type SummarizeFailureReason =
  | "thread_not_found"
  | "no_project_id"
  | "no_bearer"
  | "below_threshold"
  | "rowboat_failed"
  | "empty_summary"
  | "db_failed";

function joinMessagesAsTranscript(rows: DashboardChatMessageRow[]): string {
  // Rendered as `[role]: content` so the summarizer model gets a clean
  // turn-by-turn view without the structural noise of role/content
  // JSON. Two newlines between turns to keep boundary detection cheap.
  return rows
    .map((m) => {
      const label =
        m.role === "user" ? "Owner" : m.role === "assistant" ? "Coworker" : "System";
      return `[${label}]: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Decide whether to fire a summarizer based on the thread's current
 * message count. Pure helper so callers can gate without a DB
 * round-trip when the thread row is already in hand.
 */
export function shouldSummarize(
  thread: Pick<DashboardChatThreadRow, "summary_message_count">,
  totalMessageCount: number
): boolean {
  return totalMessageCount - (thread.summary_message_count ?? 0) >= SUMMARY_INTERVAL;
}

/**
 * Generate (or regenerate) the rolling summary for a thread, then
 * persist it. Returns a result discriminator so the caller can
 * structurally log or branch; throws are caught internally and
 * surfaced as `{ ok: false }` so the fire-and-forget call site never
 * needs its own try/catch.
 *
 * The caller MUST verify ownership before invoking — this module
 * trusts its `(businessId, threadId)` pair.
 */
export async function summarizeThread(
  businessId: string,
  threadId: string,
  deps: SummarizeDeps = {}
): Promise<SummarizeResult> {
  /* c8 ignore start -- per-dep `??` fallbacks are exercised in production
     (no deps supplied) but tests always inject every dep for hermeticity.
     The runtime path is trivially correct; the unit tests cover behavior,
     not the wiring. */
  const _getThreadById = deps.getThreadById ?? getThreadById;
  const _listMessages = deps.listMessages ?? listMessages;
  const _getBusinessConfig = deps.getBusinessConfig ?? getBusinessConfig;
  const _callRowboatChat = deps.callRowboatChat ?? callRowboatChat;
  const _updateThreadSummary = deps.updateThreadSummary ?? updateThreadSummary;
  /* c8 ignore stop */
  const bearer =
    deps.rowboatBearer ??
    process.env.ROWBOAT_VPS_CHAT_BEARER ??
    process.env.ROWBOAT_GATEWAY_TOKEN ??
    "";

  let thread: DashboardChatThreadRow | null;
  try {
    thread = await _getThreadById(threadId);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : /* c8 ignore next */ String(err)
    };
  }
  if (!thread) return { ok: false, reason: "thread_not_found" };

  // Wrap getBusinessConfig in the same try/catch pattern as every
  // other async DB call below so the summarizeThread contract
  // ("throws are caught internally and surfaced as { ok: false }")
  // holds even when the helper throws on a network blip / RLS error.
  // The summarizeThreadAndLog wrapper would catch it anyway, but
  // direct callers of summarizeThread rely on the never-throw guarantee.
  let config: Awaited<ReturnType<typeof getBusinessConfig>>;
  try {
    config = await _getBusinessConfig(businessId);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : /* c8 ignore next */ String(err)
    };
  }
  /* c8 ignore next 4 -- Defensive: in production a chat-eligible business has
     a project id (the chat POST 409s without one); this fallback only fires
     in degraded states the summarizer doesn't need to crash on. */
  const projectId =
    config?.rowboat_project_id?.trim() ||
    process.env.ROWBOAT_DEFAULT_PROJECT_ID?.trim() ||
    "";
  if (!projectId) return { ok: false, reason: "no_project_id" };
  if (!bearer) return { ok: false, reason: "no_bearer" };

  let allMessages: DashboardChatMessageRow[];
  try {
    allMessages = await _listMessages(threadId);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : /* c8 ignore next */ String(err)
    };
  }

  // Anything that's still in the live tail doesn't need to be in the
  // summary — Rowboat will see those messages raw on every chat turn.
  // Only summarize the part that the live tail will eventually drop.
  const toSummarize = allMessages.slice(0, -SUMMARY_TAIL_KEEP);
  if (toSummarize.length === 0) {
    return { ok: false, reason: "below_threshold" };
  }

  const transcript = joinMessagesAsTranscript(toSummarize);
  const summarizerMessages: RowboatChatMessage[] = [
    { role: "system", content: SUMMARIZER_SYSTEM_INSTRUCTION },
    {
      role: "user",
      content: `Summarize the following conversation excerpt:\n\n${transcript}`
    }
  ];

  let reply: string;
  try {
    const parsed = await _callRowboatChat({
      businessId,
      projectId,
      bearer,
      messages: summarizerMessages,
      // Deliberately do NOT pass conversationId/state — we want a
      // fresh, stateless model invocation for summarization. Reusing
      // the thread's continuation would taint the summary with the
      // model's chat-mode rolling state.
      conversationId: null,
      state: null,
      timeoutMs: SUMMARY_TIMEOUT_MS
    });
    reply = parsed.reply;
  } catch (err) {
    return {
      ok: false,
      reason: "rowboat_failed",
      detail: err instanceof Error ? err.message : /* c8 ignore next */ String(err)
    };
  }

  const trimmed = reply.trim();
  if (!trimmed) return { ok: false, reason: "empty_summary" };
  // Hard-truncate so persona bleed or a runaway model can't dominate
  // the prompt. Truncating in the middle of a sentence is fine — the
  // summary is for the model's benefit, not the user's.
  const summary =
    trimmed.length > SUMMARY_MAX_CHARS ? trimmed.slice(0, SUMMARY_MAX_CHARS) : trimmed;

  try {
    await _updateThreadSummary(threadId, summary, allMessages.length);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : /* c8 ignore next */ String(err)
    };
  }

  return {
    ok: true,
    summary,
    messageCount: allMessages.length,
    projectId
  };
}

/**
 * Fire-and-forget wrapper. Logs structured success/failure but never
 * rejects. Use this from POST routes via `void summarizeThreadAndLog(...)`.
 */
export async function summarizeThreadAndLog(
  businessId: string,
  threadId: string,
  deps: SummarizeDeps = {}
): Promise<void> {
  let result: SummarizeResult;
  try {
    result = await summarizeThread(businessId, threadId, deps);
    /* c8 ignore start -- summarizeThread already converts every internal
       throw into a structured `{ ok: false }`. This catch only runs if
       a dependency injection itself throws synchronously, which
       production code paths don't. Final safety net so a misconfigured
       caller can't crash the POST. */
  } catch (err) {
    logger.warn("dashboard-chat summarizer threw unexpectedly", {
      businessId,
      threadId,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }
  /* c8 ignore stop */
  if (result.ok) {
    logger.info("dashboard-chat summarizer ok", {
      businessId,
      threadId,
      projectId: result.projectId,
      messageCount: result.messageCount,
      summaryChars: result.summary.length
    });
  } else {
    logger.warn("dashboard-chat summarizer failed", {
      businessId,
      threadId,
      reason: result.reason,
      detail: result.detail
    });
  }
}
