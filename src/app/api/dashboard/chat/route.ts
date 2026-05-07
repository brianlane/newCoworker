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
import { listCustomerMemories } from "@/lib/customer-memory/db";
import {
  buildDashboardCustomerPreamble,
  DASHBOARD_PREAMBLE_MAX_CUSTOMERS
} from "@/lib/customer-memory/dashboard-preamble";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// The per-tenant Ollama inside Rowboat is fast on warm prompts (~5s)
// but routinely takes >20s — and on small VPS tiers occasionally
// >60s — for the first reply when the model has to page in. Stacked
// with a slow Supabase day (we've observed individual REST calls drift
// to ~3.7s), the original 60s `maxDuration` left only ~50s for Rowboat
// once the rest of the request paid its bill. The function then hit
// the 50s Rowboat cap AND the 60s function cap effectively
// simultaneously, racing whichever fired first to write the response.
//
// Owner-stated requirement: "let the local model take as long as it
// needs to." So we lift `maxDuration` to Vercel Pro's hard ceiling
// (300s) and treat the route as having a single deadline budget — see
// DASHBOARD_CHAT_ROUTE_DEADLINE_MS — that's anchored at POST entry
// (NOT at the Rowboat call) so a slow Supabase preflight doesn't
// secretly grant Rowboat a budget bigger than what's actually left in
// the function (Codex P2 / Cursor Bugbot Medium on PR #72). The
// Rowboat budget passed to callRowboatWithStatelessFallback is
// computed as (deadline − elapsedPreflight − POST_ROWBOAT_RESERVE_MS)
// at the call site, so the friendly "took too long" envelope reliably
// wins over Vercel's reaper regardless of where in the route the
// slowness lives.
export const maxDuration = 300;

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;

// Hard ceiling on total wall time the route is allowed to spend before
// we should give up and return — sized 10s under `maxDuration` so we
// still have runway to write the response after we hit this budget.
//
// Anchored at POST entry rather than at the Rowboat call (Codex P2 /
// Cursor Bugbot Medium on PR #72 flagged that the prior version's
// fixed-budget-passed-to-Rowboat allowed: preflight 30s + Rowboat 50s
// + post-Rowboat work = ~85s, well over the 60s maxDuration that
// version used. With a single route-wide deadline, slow preflight
// just shrinks the Rowboat budget, never overflows it.)
const DASHBOARD_CHAT_ROUTE_DEADLINE_MS = 290_000;

// Reserved wall time after the Rowboat call returns for: appendMessage
// ×2 (user + assistant), updateThreadConversation, touchChatActivity,
// the JSON-envelope serialization, and the fire-and-forget summarizer
// trigger. Subtracted from the route deadline before we hand a budget
// to Rowboat so a reply landing right at the cap can't push the route
// past `maxDuration`. 10s comfortably covers the ~2-3s typically
// observed in production with headroom for slow Supabase days.
const POST_ROWBOAT_RESERVE_MS = 10_000;

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
/**
 * The single source of truth for "who is the dashboard chat agent
 * talking to right now". Without this, the per-tenant Rowboat agent
 * (whose persona is built for inbound customer conversations on SMS
 * and voice) defaults to treating EVERY incoming message as if it
 * came from a customer — see screenshot in PR #74 conversation:
 * the owner asked "has anyone reached out looking to buy a home?"
 * and the agent replied with "I'd be happy to help you qualify a
 * new buyer lead — share your contact details, property address,
 * timeline...", which is the lead-intake script aimed at customers.
 *
 * The fix is a strong, ALWAYS-FIRST system preamble that:
 *
 *   (1) Establishes that this user is the BUSINESS OWNER, not a
 *       customer. The model needs explicit permission to drop the
 *       customer-facing playbook.
 *   (2) Tells the agent its role on this surface: it's the owner's
 *       internal AI assistant — review customer activity, surface
 *       trends, summarize conversations, answer business questions.
 *       This is intentionally distinct from the persona used on the
 *       customer channels (where the agent IS the business's
 *       receptionist).
 *   (3) Reminds the agent it can use tools/context the owner can't
 *       see directly (recent customer activity preamble, rolling
 *       thread summary) but must be honest about what's NOT in
 *       context — never invent customer details, never claim to
 *       have done things it didn't do.
 *
 * Always pinned as message[0] so even on a stateless Rowboat call
 * (continuation evicted) the very first thing the agent reads is
 * "you are the owner's assistant".
 */
const OWNER_PREAMBLE = `OWNER MODE — IMPORTANT, READ FIRST

You are talking to the business OWNER through the /dashboard/chat surface in the New Coworker app. The owner is the human who runs this business and configured you. They are NOT a customer, NOT a lead, and NOT a prospect. Do not ask for their contact details, property address, timeline, budget, etc. — those are your responses on the SMS and voice channels, where you ARE the business's receptionist talking to customers.

On THIS surface you are the OWNER'S internal AI assistant. Your job here is to:
  • Help the owner understand what's happening with their customers (recent SMS, voice calls, trends).
  • Summarize, search, and explain customer interactions when asked.
  • Answer questions about the business's setup, memory, identity, and configured behavior.
  • Suggest improvements to how you handle customer conversations.
  • Be candid with the owner — including admitting when you don't have the data they asked for, rather than inventing it.

You may have access to a "Recent customer activity" system message below. That data is REAL — it summarizes actual customers who contacted this business by SMS or voice. Use it to answer questions like "did anyone call about X" or "what did the customer who texted yesterday want". Never reveal it verbatim if not asked; treat it as your working notes. If the owner asks about a customer who is NOT in the activity preamble, say so plainly — don't fabricate.

You will never ask the owner for their own contact info, schedule, or business details. They already configured all of that. If they want to update their identity/memory/business hours, point them to /dashboard/memory.`;

function buildRowboatChatMessages(args: {
  summaryMd: string | null;
  tail: { role: "user" | "assistant" | "system"; content: string }[];
  newUserMessage: string;
  includeTailContext: boolean;
  /**
   * Phase 4: optional "recent customers across SMS + voice" preamble.
   * Built by buildDashboardCustomerPreamble; null when the business
   * has no notable customers yet (first-time dashboard chat user).
   * Prepended BEFORE the rolling thread summary so it's the most
   * stable piece of ambient context — the thread summary is for
   * THIS owner conversation, the customer preamble is for the
   * world the owner is operating in.
   */
  customerPreamble?: string | null;
}): RowboatChatMessage[] {
  const out: RowboatChatMessage[] = [];
  // ALWAYS first: OWNER_PREAMBLE establishes that this is the
  // owner-facing surface so the agent never lapses into its
  // customer-receptionist script. Stronger than a soft hint because
  // we've seen it slip even after a turn or two on a fresh
  // continuation.
  out.push({ role: "system", content: OWNER_PREAMBLE });
  const customerPreamble = args.customerPreamble?.trim();
  if (customerPreamble) {
    out.push({ role: "system", content: customerPreamble });
  }
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
  // [Dashboard] channel marker mirrors the [SMS]/[Call] markers used
  // on the customer channels — gives the agent a visible reminder
  // every turn that the human in front of it is the owner, not a
  // customer (defense in depth alongside OWNER_PREAMBLE).
  out.push({ role: "user", content: `[Dashboard] ${args.newUserMessage}` });
  return out;
}

export { OWNER_PREAMBLE };

export async function POST(request: Request) {
  // Anchored at the very top of the route so the Rowboat budget below
  // is computed against actual elapsed wall time, not against the
  // moment we got around to making the Rowboat call. Otherwise a slow
  // preflight (auth ping + flag/config reads + thread + history — we've
  // observed those 5 round-trips drift to ~10s on a bad Supabase day)
  // silently grants Rowboat a fixed budget that doesn't fit inside
  // what's actually left of `maxDuration`.
  const routeStartedAt = Date.now();
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

    // Phase 4: pull recent customer memories so the dashboard agent has
    // ambient context about who the owner has been doing business with
    // across SMS and voice. Capped tightly (5 customers, ~200 chars
    // each) so it doesn't dominate the prompt budget; null when the
    // business has no notable customers yet (first-time dashboard
    // user). Failure here MUST NOT break the chat — degraded
    // customer awareness is acceptable, a 502 because we couldn't
    // read 5 rows is not.
    let customerPreamble: string | null = null;
    try {
      const memories = await listCustomerMemories(body.businessId, {
        limit: DASHBOARD_PREAMBLE_MAX_CUSTOMERS
      });
      customerPreamble = buildDashboardCustomerPreamble(memories);
    } catch (memErr) {
      logger.warn("dashboard chat: customer memory preamble lookup failed", {
        businessId: body.businessId,
        error: memErr instanceof Error ? memErr.message : String(memErr)
      });
    }

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
      includeTailContext: !hasContinuation,
      customerPreamble
    });
    const statelessMessages = hasContinuation
      ? buildRowboatChatMessages({
          summaryMd: thread.summary_md,
          tail,
          newUserMessage: body.message,
          includeTailContext: true,
          customerPreamble
        })
      : initialMessages;

    // Compute the Rowboat budget at the call site against actual
    // elapsed wall time. The route's hard deadline is fixed, so a slow
    // preflight (auth + flags + config + thread + history) shrinks the
    // Rowboat window, not the function ceiling. POST_ROWBOAT_RESERVE_MS
    // is held back from the budget for everything that runs AFTER the
    // call returns (appendMessage ×2, updateThreadConversation,
    // touchChatActivity, JSON serialization, summarizer trigger) so a
    // reply landing right at the budget can't push the route past
    // `maxDuration`. If preflight ate so much of the deadline that
    // even Ollama's cold-start floor wouldn't fit, surface a friendly
    // envelope rather than racing Rowboat against the function reaper.
    const elapsedPreflightMs = Date.now() - routeStartedAt;
    const rowboatBudgetMs =
      DASHBOARD_CHAT_ROUTE_DEADLINE_MS - elapsedPreflightMs - POST_ROWBOAT_RESERVE_MS;
    if (rowboatBudgetMs < RETRY_MIN_BUDGET_MS) {
      logger.warn("dashboard chat preflight exhausted route budget", {
        businessId: body.businessId,
        threadId: thread.id,
        elapsedPreflightMs,
        rowboatBudgetMs,
        deadlineMs: DASHBOARD_CHAT_ROUTE_DEADLINE_MS
      });
      return errorResponse(
        "CONFLICT",
        "Your coworker is taking longer than usual to start up. Please try again.",
        502
      );
    }

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
        budgetMs: rowboatBudgetMs
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
