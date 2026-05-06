/**
 * Owner ↔ local-model chat endpoint for /dashboard/chat.
 *
 * POST   send a message, call Rowboat, persist reply, return full thread
 * GET    hydrate the active thread + flag state for the client
 * DELETE end the active thread so the next POST starts fresh
 *
 * Auth: getAuthUser + requireOwner(businessId). Kill switch (is_paused) soft-
 * blocks the endpoint with a 409 so the UI can show a Resume CTA; Safe Mode
 * is deliberately NOT gated (the whole point is the owner stays online while
 * customer channels forward to their cell).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessConfig } from "@/lib/db/configs";
import {
  appendMessage,
  deactivateActiveThread,
  getActiveThread,
  getOrCreateActiveThread,
  getThreadById,
  listMessages,
  reactivateThread,
  serializeChatMessages,
  touchChatActivity,
  updateThreadConversation,
  type DashboardChatThreadRow
} from "@/lib/db/dashboard-chat";
import {
  callRowboatChat,
  describeRowboatError,
  type CallRowboatChatOutput,
  type RowboatChatMessage
} from "@/lib/rowboat/chat";
import {
  shouldSummarize,
  summarizeThreadAndLog
} from "@/lib/dashboard-chat/summarizer";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// The per-tenant Ollama inside Rowboat is fast on warm prompts (~5s)
// but routinely takes >20s for the first reply when the model has to
// page in (documented in supabase/functions/sms-inbound-worker/index.ts
// next to its own 60s ROWBOAT_CHAT_TIMEOUT_MS). Vercel's default
// function timeout is 30s on Pro, which is *equal* to the Rowboat
// fetch timeout below — without `maxDuration` the function gets reaped
// at exactly the same moment our own AbortController fires, so the
// catch-block that returns the friendly "took too long" envelope
// never runs and the client sees a generic 502 / "Unexpected server
// response". maxDuration > DASHBOARD_CHAT_ROWBOAT_BUDGET_MS gives the
// route headroom to log, return a JSON envelope, and let the summarizer
// fire-and-forget cleanly.
//
// Sized so the worst-case negative path stays well under the function
// budget. NB: DASHBOARD_CHAT_ROWBOAT_BUDGET_MS is the *combined*
// budget across the initial call AND the optional stateless retry —
// callRowboatWithStatelessFallback caps the retry's per-call timeout
// at (budget - elapsed) and skips the retry outright when too little
// time remains, so a slow first failure can't grant the retry a
// fresh full window:
//
//   pre-flight (auth, rate limit, flag/config reads, thread + history) ~ 1.5s
//   Rowboat /chat (initial + optional retry, COMBINED hard cap)         50.0s
//   error mapping + JSON serialization                                  ~ 0.2s
//   ────────────────────────────────────────────────────────────────────────
//   total                                                             ~ 51.7s   ( < maxDuration of 60s )
export const maxDuration = 60;

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;

// Combined wall-clock budget for Rowboat /chat across the initial
// continuation-using call AND the optional stateless retry.
//
// Why a combined (not per-call) budget: passing the full value to both
// attempts would let a slow first failure (e.g. a 502 from Cloudflare
// at ~30s) plus a fresh 50s retry exceed `maxDuration` and re-trigger
// the Vercel-reaper race this route is sized to avoid (Codex P2 /
// Cursor Bugbot Medium on PR #71). The retry helper subtracts the
// already-elapsed wall time and aborts the retry early — or skips it
// entirely below RETRY_MIN_BUDGET_MS — so the *sum* of both timeouts
// stays bounded.
//
// Why 50s and not 30s: the previous 30s value matched Vercel's default
// function timeout exactly, so when the model went cold the function
// got killed before the AbortController-triggered "rowboat_timeout"
// path could write its 502 response. 50s gives the local model the
// same headroom it has on the SMS path while keeping us well inside
// the function's 60s maxDuration window.
const DASHBOARD_CHAT_ROWBOAT_BUDGET_MS = 50_000;

// Floor on the post-first-call remaining budget below which we skip
// the stateless retry entirely. Sized so the retry has a realistic
// chance of succeeding: a Rowboat call that pages in a cold model
// takes ~5s at minimum on a small VPS, and anything below this is
// almost guaranteed to abort before we'd see a reply. Skipping the
// retry surfaces the *first* error to the caller (a more honest
// signal than burning the rest of the function on a doomed retry
// that ends in a generic "took too long" envelope).
const RETRY_MIN_BUDGET_MS = 5_000;

const DASHBOARD_CHAT_RATE = { interval: 5 * 60 * 1000, maxRequests: 30 };

/**
 * Errors where Rowboat's response strongly suggests the *server-side*
 * conversation referenced by our stored conversationId is gone (model
 * restart, retention expiry, version skew) OR the conversation is
 * otherwise unhealthy. On these we get one stateless retry — Rowboat's
 * reply will live entirely off a fresh stateless prompt (rolling
 * summary system message + recent-tail transcript system message + new
 * user turn — see buildRowboatChatMessages), so dropping
 * conversationId/state is safe.
 *
 * 400 specifically also covers the case where the stored
 * conversationId is intact but Rowboat's input validator rejected the
 * request body for some other reason; the stateless retry sends a
 * different (continuation-free, tail-as-system) shape, which often
 * succeeds where the first call didn't.
 *
 * Deliberately excluded:
 *   - rowboat_timeout: timing out doesn't tell us anything about
 *     conversation state and a stateless retry would just double the
 *     load on a slow VPS.
 *   - rowboat_http_401 / 403: auth is global, retrying with the same
 *     bearer would fail identically.
 *   - rowboat_invalid_json: protocol-level failure; retrying without
 *     conversationId won't fix garbled bytes.
 */
const STATELESS_RETRY_ERRORS = new Set([
  "rowboat_http_400",
  "rowboat_http_404",
  "rowboat_http_409",
  "rowboat_http_500",
  "rowboat_http_502",
  "rowboat_http_503",
  "rowboat_empty_assistant"
]);

const postBodySchema = z.object({
  businessId: z.string().uuid(),
  // Optional: when present, the POST targets that specific thread —
  // reactivating it (deactivating the previously-active one) so the
  // user can continue any past conversation, ChatGPT/Claude/Gemini-
  // style. When omitted, the legacy "use active thread or create one"
  // path runs. We accept any uuid here and gate ownership against the
  // resolved row's business_id (NOT this body's businessId) so a
  // stolen threadId can't be reactivated under a different tenant.
  threadId: z.string().uuid().optional(),
  message: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .max(MAX_MESSAGE_CHARS, `Message is too long (max ${MAX_MESSAGE_CHARS} chars)`)
});

const businessIdSchema = z.string().uuid();

function businessIdFromUrl(request: Request): string {
  const url = new URL(request.url);
  const id = url.searchParams.get("businessId") ?? "";
  return businessIdSchema.parse(id);
}

type BusinessFlags = {
  id: string;
  is_paused: boolean;
  customer_channels_enabled: boolean;
};

async function loadBusinessFlags(businessId: string): Promise<BusinessFlags | null> {
  const db = await createSupabaseServiceClient();
  const { data } = await db
    .from("businesses")
    .select("id, is_paused, customer_channels_enabled")
    .eq("id", businessId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    is_paused: Boolean(data.is_paused),
    customer_channels_enabled: data.customer_channels_enabled !== false
  };
}

type RowboatRetryInput = {
  businessId: string;
  projectId: string;
  bearer: string;
  /**
   * Messages for the *first* (continuation-using) call. When a
   * continuation is in hand, Rowboat already has the full thread
   * server-side, so this is typically just `[summary?, newUser]`.
   */
  initialMessages: RowboatChatMessage[];
  /**
   * Messages for the stateless fallback. Because dropping the
   * continuation reverts Rowboat to a blank conversation, this
   * variant must carry whatever local context the model needs —
   * summary + a transcript-shaped system message of the recent
   * tail + the new user turn.
   */
  statelessMessages: RowboatChatMessage[];
  conversationId: string | null;
  state: unknown | null;
  /** Used only for log correlation. */
  threadId: string;
  /**
   * COMBINED wall-clock budget across the initial call and (if it
   * fires) the stateless retry. Sized by the caller against the
   * route's `maxDuration` so the AbortController-driven
   * "rowboat_timeout" path always wins over Vercel's function reaper
   * — otherwise the client sees a generic 502 instead of our friendly
   * envelope. The retry's per-call timeout is internally capped at
   * (budgetMs - elapsedMs) so a slow first failure can't grant the
   * retry a fresh full window.
   */
  budgetMs: number;
};

/**
 * Call Rowboat with the stored conversation continuation. If the
 * continuation appears stale (Rowboat evicted server-side state — see
 * STATELESS_RETRY_ERRORS) AND we actually had a conversationId to send,
 * retry once with continuation dropped AND the recent-tail system
 * preamble re-attached so the model has continuity. Rowboat treats the
 * retry as a fresh conversation rooted in those messages.
 *
 * Why retry: the alternative (status quo before this fix) is that any
 * archived thread whose Rowboat session got reaped becomes permanently
 * non-continuable from the dashboard, even though we have full local
 * context. That regresses the "every thread is continuable" promise
 * we just shipped.
 *
 * Why ONLY one retry: if the stateless fallback also fails, the
 * problem isn't conversation state and another attempt won't help.
 * We surface the *retry's* error (the more recent signal of what's
 * wrong with Rowboat right now) so the friendly-error mapping is
 * accurate.
 */
type StatelessFallbackResult = CallRowboatChatOutput & {
  /**
   * True iff the first call failed with a STATELESS_RETRY_ERRORS
   * code AND we re-issued without conversationId/state. The caller
   * MUST treat the stored rowboat_conversation_id as known-stale
   * when this is true — even if the retry's response omits a fresh
   * conversationId — otherwise the next message replays the same
   * fail-then-retry cycle indefinitely (Bugbot Low: "stale
   * conversationId persists after successful stateless retry").
   */
  retriedStateless: boolean;
};

async function callRowboatWithStatelessFallback(
  input: RowboatRetryInput
): Promise<StatelessFallbackResult> {
  const hadContinuation =
    typeof input.conversationId === "string" && input.conversationId.trim().length > 0;
  // Anchored at the start of the *combined* budget so the retry
  // (when it fires) inherits whatever wall time is left, not a fresh
  // full window. Single Date.now() read so the elapsed measurement
  // below is consistent even if the system clock skews mid-call.
  const startedAt = Date.now();
  try {
    const out = await callRowboatChat({
      businessId: input.businessId,
      projectId: input.projectId,
      bearer: input.bearer,
      messages: input.initialMessages,
      conversationId: input.conversationId,
      state: input.state,
      timeoutMs: input.budgetMs
    });
    return { ...out, retriedStateless: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const isStaleContinuation =
      hadContinuation && STATELESS_RETRY_ERRORS.has(message);
    if (!isStaleContinuation) throw err;

    // Cap the retry against the route's COMBINED budget. If the first
    // call burned most of the wall time before failing, the retry
    // either gets a tiny window or — when even Ollama's cold-start
    // floor wouldn't fit — gets skipped entirely so the original
    // error surfaces instead of a self-inflicted "rowboat_timeout"
    // (Codex P2 / Cursor Bugbot Medium, PR #71).
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = input.budgetMs - elapsedMs;
    if (remainingMs < RETRY_MIN_BUDGET_MS) {
      logger.info("rowboat continuation stale, skipping stateless retry (insufficient remaining budget)", {
        businessId: input.businessId,
        threadId: input.threadId,
        firstError: message,
        elapsedMs,
        remainingMs,
        budgetMs: input.budgetMs
      });
      throw err;
    }
    logger.info("rowboat continuation stale, retrying stateless", {
      businessId: input.businessId,
      threadId: input.threadId,
      firstError: message,
      elapsedMs,
      retryTimeoutMs: remainingMs
    });
    const out = await callRowboatChat({
      businessId: input.businessId,
      projectId: input.projectId,
      bearer: input.bearer,
      // Stateless retry MUST include the local tail as a system
      // preamble — Rowboat won't have any server-side memory to
      // fall back on once the continuation is dropped.
      messages: input.statelessMessages,
      conversationId: null,
      state: null,
      timeoutMs: remainingMs
    });
    return { ...out, retriedStateless: true };
  }
}

/**
 * Build the message array sent to Rowboat for one chat turn.
 *
 * Why we don't just replay the live tail of stored messages: Rowboat's
 * HTTP /chat endpoint validates the input `messages[]` with a Zod
 * schema that rejects plain `{ role: "assistant", content: string }`
 * objects (it expects agent/tool-shaped assistant rows produced by
 * Rowboat itself). Replaying our local assistant turns there always
 * 400s — see tests/integration/kvm-rowboat/rowboat-chat.ts for the
 * canonical contract: "Each leg sends only the new user message …
 * do not replay `{ role: 'assistant', content }`". So we instead:
 *
 *   - rely on Rowboat's server-side conversation memory via
 *     conversationId/state when we have it (`includeTailContext: false`);
 *   - on a fresh thread or a stateless fallback (continuation evicted
 *     and we just dropped it), render the recent-turn tail as a single
 *     transcript-shaped *system* message so the model still has
 *     continuity (`includeTailContext: true`).
 *
 * The summary preamble (rolling-summary system message) and the new
 * user turn are always included.
 */
function buildRowboatChatMessages(args: {
  summaryMd: string | null;
  tail: { role: "user" | "assistant" | "system"; content: string }[];
  newUserMessage: string;
  includeTailContext: boolean;
}): RowboatChatMessage[] {
  const out: RowboatChatMessage[] = [];
  const summary = args.summaryMd?.trim();
  if (summary) {
    out.push({
      role: "system",
      content: `Conversation summary so far:\n\n${summary}`
    });
  }
  if (args.includeTailContext && args.tail.length > 0) {
    const transcript = args.tail
      .map((m) => {
        const label =
          m.role === "user" ? "Owner" : m.role === "assistant" ? "Coworker" : "System";
        return `[${label}]: ${m.content}`;
      })
      .join("\n\n");
    out.push({
      role: "system",
      content: `Recent conversation context (these are the most recent prior turns of THIS conversation, replayed for your reference because the live continuation was unavailable; respond as the assistant continuing this same thread):\n\n${transcript}`
    });
  }
  out.push({ role: "user", content: args.newUserMessage });
  return out;
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = postBodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const limiter = rateLimit(`dashboard-chat:${body.businessId}`, DASHBOARD_CHAT_RATE);
    if (!limiter.success) {
      return errorResponse(
        "CONFLICT",
        "Too many messages, please wait a minute.",
        429
      );
    }

    const flags = await loadBusinessFlags(body.businessId);
    if (!flags) return errorResponse("NOT_FOUND", "Business not found");

    if (flags.is_paused) {
      return errorResponse(
        "CONFLICT",
        "Your coworker is paused. Resume from the dashboard to chat."
      );
    }

    const projectConfig = await getBusinessConfig(body.businessId);
    const projectId =
      projectConfig?.rowboat_project_id?.trim() ??
      process.env.ROWBOAT_DEFAULT_PROJECT_ID ??
      "";
    const bearer =
      process.env.ROWBOAT_VPS_CHAT_BEARER ??
      process.env.ROWBOAT_GATEWAY_TOKEN ??
      "";

    if (!projectId) {
      return errorResponse(
        "CONFLICT",
        "Your coworker's chat service isn't ready yet. Provisioning may still be in progress."
      );
    }
    if (!bearer) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Chat bearer token is not configured"
      );
    }

    // Activity update #1: fires before the Rowboat call so the VPS keep-warm
    // timer stands down for this turn. The second update below (post-reply)
    // keeps the 180s skip window anchored to the most recent exchange.
    await touchChatActivity(body.businessId);

    // Thread resolution. Two paths:
    //   1. Caller supplied threadId → continue (and reactivate if archived)
    //      that specific thread. Lets archived conversations be resumed
    //      without ceremony, ChatGPT/Claude/Gemini-style.
    //   2. No threadId → legacy behavior: use the active thread or mint
    //      a fresh one if none.
    let thread: DashboardChatThreadRow;
    if (body.threadId) {
      // IDOR guard: resolve the thread first, then verify it belongs
      // to the business in the body. Trusting body.businessId as the
      // ownership scope without the cross-check would let an
      // authenticated owner reactivate any thread on the platform by
      // pairing a guessed threadId with a businessId they own.
      const target = await getThreadById(body.threadId);
      if (!target) return errorResponse("NOT_FOUND", "Conversation not found");
      if (target.business_id !== body.businessId) {
        // Same-status response as a missing row so the caller can't
        // distinguish "not yours" from "doesn't exist" via timing.
        return errorResponse("NOT_FOUND", "Conversation not found");
      }
      if (!target.is_active) {
        await reactivateThread(body.businessId, body.threadId);
        // Re-read so downstream sees is_active=true and the freshest
        // updated_at; the in-memory copy from the lookup is now stale.
        /* c8 ignore next -- re-read theoretically can return null (race
           with a concurrent delete) but the prior reactivate would've
           thrown first; the `?? target` fallback is a defensive belt. */
        thread = (await getThreadById(body.threadId)) ?? target;
      } else {
        thread = target;
      }
    } else {
      const title = body.message.slice(0, 140);
      thread = await getOrCreateActiveThread(body.businessId, title);
    }

    // Build the Rowboat request off the *persisted* history plus the just-
    // received user turn, WITHOUT persisting the user turn yet. If Rowboat
    // fails (timeout / 5xx / empty reply) we return 502 and the client's
    // optimistic-undo stays consistent with DB state — otherwise we'd leave
    // orphaned user turns that poison retries and show a phantom message
    // after refresh.
    const history = await listMessages(thread.id);
    const tail = history.slice(-HISTORY_TURNS);
    // Two message arrays: one for the initial (continuation-using) call
    // and one for the stateless fallback. When a continuation is in hand
    // Rowboat already remembers the thread server-side, so the initial
    // call doesn't need to replay anything beyond the rolling summary
    // preamble + new user turn. The stateless variant always carries the
    // recent tail rendered as a system transcript — see
    // buildRowboatChatMessages for why we never replay raw assistant
    // rows here.
    const hasContinuation =
      typeof thread.rowboat_conversation_id === "string" &&
      thread.rowboat_conversation_id.trim().length > 0;
    const initialMessages = buildRowboatChatMessages({
      summaryMd: thread.summary_md,
      tail,
      newUserMessage: body.message,
      includeTailContext: !hasContinuation
    });
    const statelessMessages = hasContinuation
      ? buildRowboatChatMessages({
          summaryMd: thread.summary_md,
          tail,
          newUserMessage: body.message,
          includeTailContext: true
        })
      : initialMessages;

    let reply: string;
    let conversationId: string | undefined;
    let state: unknown | undefined;
    let retriedStateless: boolean;
    try {
      const parsed = await callRowboatWithStatelessFallback({
        businessId: body.businessId,
        projectId,
        bearer,
        initialMessages,
        statelessMessages,
        conversationId: thread.rowboat_conversation_id,
        state: thread.rowboat_state,
        threadId: thread.id,
        budgetMs: DASHBOARD_CHAT_ROWBOAT_BUDGET_MS
      });
      reply = parsed.reply;
      conversationId = parsed.conversationId;
      state = parsed.hasStateKey ? parsed.state : undefined;
      retriedStateless = parsed.retriedStateless;
    } catch (err) {
      const friendly = describeRowboatError(err);
      return errorResponse("CONFLICT", friendly, 502);
    }

    // Success path: persist user + assistant together so they always appear
    // as a matched turn in history. Order is preserved by created_at.
    await appendMessage(thread.id, "user", body.message);
    await appendMessage(thread.id, "assistant", reply);
    // When we used the stateless fallback, the thread's stored
    // rowboat_conversation_id is *known* stale — Rowboat had already
    // failed with a STATELESS_RETRY_ERRORS code on it. Even if the
    // retry's response omits a fresh conversationId (the field is
    // optional in RowboatTurnJson), we MUST overwrite the DB with
    // whatever the retry returned (possibly null). Otherwise the
    // next turn re-sends the same dead id, fails, retries, and we
    // pay 2x latency forever (Bugbot Low on PR #66).
    if (retriedStateless || conversationId || state !== undefined) {
      await updateThreadConversation(
        thread.id,
        conversationId ?? null,
        state
      );
    }
    await touchChatActivity(body.businessId);

    const updated = await listMessages(thread.id);

    // Rolling-summary trigger. Fire-and-forget so a slow Ollama
    // doesn't block the chat response. The summarizer module catches
    // its own errors and logs structured success/failure; this caller
    // never rejects. Gate before invoking so we don't spam logs with
    // "below_threshold" rejections on every short-thread turn.
    if (shouldSummarize(thread, updated.length)) {
      void summarizeThreadAndLog(body.businessId, thread.id);
    }

    return successResponse({
      threadId: thread.id,
      reply,
      messages: serializeChatMessages(updated)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = businessIdFromUrl(request);
    if (!user.isAdmin) await requireOwner(businessId);

    const flags = await loadBusinessFlags(businessId);
    if (!flags) return errorResponse("NOT_FOUND", "Business not found");

    const thread = await getActiveThread(businessId);
    const messages = thread ? await listMessages(thread.id) : [];

    return successResponse({
      threadId: thread?.id ?? null,
      messages: serializeChatMessages(messages),
      isPaused: flags.is_paused,
      customerChannelsEnabled: flags.customer_channels_enabled
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = businessIdFromUrl(request);
    if (!user.isAdmin) await requireOwner(businessId);

    await deactivateActiveThread(businessId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
