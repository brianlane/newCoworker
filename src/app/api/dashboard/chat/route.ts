/**
 * Owner ↔ local-model chat endpoint for /dashboard/chat.
 *
 * POST   ENQUEUE a job and return immediately. The actual model call runs
 *        on the per-tenant VPS chat-worker (vps/chat-worker/) which writes
 *        the assistant message back to dashboard_chat_messages. The browser
 *        subscribes to that table via Supabase Realtime and renders the
 *        reply when it lands. (Replaces the in-Vercel streaming path that
 *        was capped by Vercel's `maxDuration` and dropped messages on any
 *        disconnect inside that window — see PR #79.)
 * GET    Hydrate the active thread + flag state for the client.
 * DELETE End the active thread so the next POST starts fresh.
 *
 * Auth: getAuthUser + requireOwner(businessId). Kill switch (is_paused)
 * soft-blocks POST with a 409 so the UI can show a Resume CTA; Safe Mode
 * is deliberately NOT gated (the whole point is the owner stays online
 * while customer channels forward to their cell).
 *
 * Why we offload to a VPS worker instead of streaming on Vercel:
 * Vercel's Hobby plan caps a single function at maxDuration=300s and
 * Pro at 800s. Our local Rowboat sometimes takes 60-120s on the first
 * cold-tenant turn (vault load + Ollama page-in) and another 5-30s for
 * subsequent turns. ANY disconnect inside that window — Cloudflare
 * Tunnel hiccup, browser tab backgrounded, function eviction — meant
 * the assistant reply was generated on the VPS but never persisted,
 * because the route only wrote the message after the stream closed
 * cleanly. Three post-mortems (#76, #77, #78) couldn't close the
 * dropping-messages bug without a different architecture.
 *
 * Reliability contract (proven on srv1632631.hstgr.cloud before this
 * PR shipped — see PR #79):
 *   1. POST writes the user message + queues a job, both in <2s. The
 *      Vercel function returns immediately and is gone.
 *   2. The chat-worker (one per VPS) claims the job atomically via
 *      claim_chat_job() (FOR UPDATE SKIP LOCKED).
 *   3. Worker calls Rowboat in NON-streaming mode and waits for the
 *      full reply (4-30s typical, with up to 4 min of tolerance).
 *   4. Worker INSERTs the assistant message THEN marks the job done.
 *      A crash between those two writes leaves the job 'processing'
 *      with a stale claimed_at; reclaim_stale_chat_jobs() flips it
 *      back to 'queued' on the next sweep, so a restarted worker
 *      re-picks it up. The assistant message is never lost.
 *   5. Browser subscribes to dashboard_chat_messages Realtime keyed
 *      to thread_id and renders the reply the moment it lands.
 *
 * Wire shape (POST response body — single JSON envelope):
 *   {
 *     "ok": true,
 *     "data": {
 *       "threadId": "uuid",
 *       "activeThreadId": "uuid",
 *       "jobId": "uuid",
 *       "userMessageId": 123,
 *       "messages": [{ id, role, content, createdAt }, ...]
 *     }
 *   }
 *
 * The client uses `messages` to render the user's typed message
 * immediately (echo) and `jobId` as a polling-fallback key when
 * Realtime can't deliver the assistant message INSERT.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
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
  type DashboardChatThreadRow
} from "@/lib/db/dashboard-chat";
import {
  getInFlightChatJobForThread,
  insertChatJob,
  type DashboardChatJobInputMessage
} from "@/lib/db/dashboard-chat-jobs";
// NOTE: summarizer triggers used to live here. They moved to the
// VPS chat-worker post-PR-#79 (which calls
// /api/internal/dashboard-chat/maybe-summarize after persisting the
// assistant message) so the summary build sees BOTH the user turn
// AND the assistant turn. Firing from the route would summarize a
// thread whose latest assistant turn hadn't been written yet —
// Bugbot Medium-severity finding on PR #79.
import { listCustomerMemories } from "@/lib/customer-memory/db";
import {
  buildDashboardCustomerPreamble,
  DASHBOARD_PREAMBLE_MAX_CUSTOMERS
} from "@/lib/customer-memory/dashboard-preamble";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// POST runs in <2s now (write-and-queue, no Rowboat call). Keep
// maxDuration small so a misbehaving deploy can't burn function-time
// budget — anything taking >10s on this path is a bug, not a slow model.
export const maxDuration = 30;

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;
// How many recent messages to replay verbatim as the "recent conversation
// context" system block on EVERY turn (including continuation turns). Kept
// small so we don't balloon CPU prefill on the per-tenant model — the box
// is CPU-only and prefill cost tracks real prompt size — while still giving
// the model deterministic recall of what was just said. The stateless-retry
// fallback uses the full HISTORY_TURNS tail instead (no conversationId, so
// it needs maximum local context). 8 messages ≈ the last ~4 turns.
const RESEND_TAIL_MESSAGES = 8;

const DASHBOARD_CHAT_RATE = { interval: 5 * 60 * 1000, maxRequests: 30 };

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
 *   (4) Authorizes the agent to share customer PII (phone numbers,
 *       timestamps, transcript text) with the owner — pre-streaming
 *       the model invented privacy/compliance refusals on its own
 *       (see PR #75 screenshot: owner asked for phone numbers, model
 *       refused citing "compliance"). The owner has full read access;
 *       the only restriction is "don't fabricate".
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

OWNER HAS FULL VISIBILITY. On THIS surface, the owner has full read access to every customer interaction this business has had — phone numbers, timestamps, message bodies, and call transcripts. None of those details are private FROM the owner. When the owner asks "what's the phone number" or "what time did they call", give the exact value from your "Recent customer activity" notes. Do NOT invent privacy/compliance rules; the only restriction is that you must not invent details that aren't actually in your context. Don't volunteer customer PII unprompted, but answer accurately whenever the owner asks directly.

YOUR OWN BUSINESS CONFIGURATION IS YOURS TO SHARE. Everything in YOUR OWN setup — your business memory, identity, soul, lead-routing rules, team roster and agent names, canned scripts, hours, and configured preferences — is the owner's own data. It is NOT confidential customer PII and you must NOT treat it as something you "don't have access to" or push the owner to "check their CRM." When the owner asks about it ("who do we route leads to", "what are the agents and their phone numbers", "what's our under-contract script"), answer directly and quote it from your instructions/memory. If you already stated something earlier in THIS conversation, you can and should restate it. Re-read your CURRENT memory each time before answering — do not assume a value is still missing because it was unavailable in the past or in an earlier example; numbers and contacts the owner has added since are in your memory now. When the owner refers to a teammate by a first name, nickname, or shortened form, match it to the closest full name in your roster/memory before answering (for instance, treat "Gabby" as your "Gabrielle", "Dave" as your "David", "Mike" as your "Michael") and give that contact's details. Only call a specific value missing when it genuinely is absent from your current memory, and then name only the part that is actually absent. Never refuse wholesale or deflect when the answer is sitting in your own configuration.

NO FABRICATION (CUSTOMER DETAILS). If your "Recent customer activity" notes don't contain a specific CUSTOMER detail the owner is asking about (a city like "Scottsdale", an exact time, the body of a message, the property they asked about), say so plainly: "I don't have that detail in my notes — check /dashboard/calls or /dashboard/messages for the full record." Never paraphrase a generic phrase like "wants to buy a home" into specifics like "3-bedroom in Scottsdale". For customer specifics you are working from a thin index, not a full transcript. Inventing customer details is worse than admitting you don't have them. (This caution is about CUSTOMER data you weren't given — NOT about your own business configuration above, which you SHOULD share freely.)

You may have access to a "Recent customer activity" system message below. That data is REAL — it summarizes actual customers who contacted this business by SMS or voice. Use it to answer questions like "did anyone call about X" or "what did the customer who texted yesterday want". Treat it as your working notes; quote the exact phone numbers and timestamps it contains when asked.

PERSISTING OWNER RULES. When the owner states a clear, lasting preference for how this business should behave with **customers** on SMS and voice (topics to avoid, required disclosures, qualification style, tone), the system captures and saves it to their Memory automatically — you do NOT have a tool to save it yourself, and saving is not something you do. Acknowledge the instruction naturally (e.g. "Got it."), but do NOT claim that you saved, stored, or updated anything yourself, and do NOT assert it is in their memory — a separate step handles persistence and will confirm it. If the owner wants to review or edit saved rules directly, point them to /dashboard/memory.

You will never ask the owner for their own contact info, schedule, or business details. They already configured all of that. If they want to edit soul/identity/website text directly, point them to /dashboard/memory.`;

export { OWNER_PREAMBLE };

/**
 * Build the message array sent to Rowboat for one chat turn. Stored on
 * the job row so the worker can call Rowboat without re-running this
 * logic.
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
 *   - render the recent-turn tail as a single transcript-shaped *system*
 *     message so the model always has explicit continuity
 *     (`includeTailContext: true`).
 *
 * Why we now ALWAYS include the tail (vs. the old "omit on continuation,
 * trust Rowboat's conversationId replay" design): production showed the
 * small per-tenant model losing earlier turns on continuation — e.g. it
 * listed the team's agent roster on turn 1 then claimed "I don't have
 * access" two turns later (business 621a5b0d, June 2026). Root cause was
 * a thin 4k context + zero resent history, so cross-turn recall hinged
 * entirely on Rowboat replay the small model didn't reliably attend to.
 * Resending a BOUNDED recent tail (see RESEND_TAIL_MESSAGES) every turn
 * costs a little duplicate prefill but makes recall deterministic. The
 * stateless-retry variant still carries the FULL tail (it runs without a
 * conversationId, so it needs the maximum local context).
 *
 * The summary preamble (rolling-summary system message) and the new
 * user turn are always included.
 */
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
}): DashboardChatJobInputMessage[] {
  const out: DashboardChatJobInputMessage[] = [];
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
      content: `Recent conversation context (the most recent prior turns of THIS conversation, included for your reference so you reliably remember what was already said — including anything YOU told the owner. Treat these as ground truth for "what we discussed" and respond as the assistant continuing this same thread):\n\n${transcript}`
    });
  }
  // [Dashboard] channel marker mirrors the [SMS]/[Call] markers used
  // on the customer channels — gives the agent a visible reminder
  // every turn that the human in front of it is the owner, not a
  // customer (defense in depth alongside OWNER_PREAMBLE).
  out.push({ role: "user", content: `[Dashboard] ${args.newUserMessage}` });
  return out;
}

// =====================================================================
// POST — write user message + enqueue a job + return 200
// =====================================================================

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = postBodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const limiter = rateLimit(`dashboard-chat:${body.businessId}`, DASHBOARD_CHAT_RATE);
    if (!limiter.success) {
      // 429 Too Many Requests — preserved from the pre-Option-B
      // streaming route (Bugbot Low-severity finding on PR #79).
      // Clients/proxies may implement automatic backoff on 429
      // semantics that 409 doesn't carry. The CONFLICT error code
      // string is kept for backwards-compat with any error-code
      // matching on the client.
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

    // Activity update fires BEFORE we enqueue so the VPS keep-warm timer
    // stands down for this turn. The worker is the one that touches
    // activity again on success (post-Rowboat-reply) — not us, since
    // we're done after the enqueue.
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
        // Same response as a missing row so the caller can't
        // distinguish "not yours" from "doesn't exist" via timing.
        return errorResponse("NOT_FOUND", "Conversation not found");
      }
      if (!target.is_active) {
        await reactivateThread(body.businessId, body.threadId);
        // Re-read so downstream sees is_active=true and the freshest
        // updated_at; the in-memory copy from the lookup is now stale.
        thread = (await getThreadById(body.threadId)) ?? target;
      } else {
        thread = target;
      }
    } else {
      const title = body.message.slice(0, 140);
      thread = await getOrCreateActiveThread(body.businessId, title);
    }

    // Build the Rowboat input off the *persisted* history plus the just-
    // received user turn.
    const history = await listMessages(thread.id);
    const tail = history.slice(-HISTORY_TURNS);

    // Phase 4: pull recent customer memories so the dashboard agent has
    // ambient context about who the owner has been doing business with
    // across SMS and voice. Capped tightly so it doesn't dominate the
    // prompt. Failure here MUST NOT break the chat — degraded customer
    // awareness is acceptable; a 502 because we couldn't read 5 rows is
    // not.
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

    const hasContinuation =
      typeof thread.rowboat_conversation_id === "string" &&
      thread.rowboat_conversation_id.trim().length > 0;

    // Two message arrays:
    //   * `inputMessages`: first attempt. ALWAYS includes a BOUNDED
    //     recent tail (last RESEND_TAIL_MESSAGES) as a system block so
    //     the model has deterministic recall of what was just said,
    //     even on continuation turns where Rowboat would otherwise be
    //     the sole keeper of history. (See buildRowboatChatMessages
    //     doc for why we stopped trusting conversationId replay alone.)
    //   * `statelessInputMessages`: fallback used by the worker on a
    //     STATELESS_RETRY_ERRORS-class failure. Includes the FULL
    //     HISTORY_TURNS tail because it's invoked WITHOUT a
    //     conversationId and Rowboat needs the context entirely from
    //     our prompt. Only built when we have a continuation to fall
    //     back FROM; on a fresh thread the first attempt is already
    //     stateless, so a second stateless call wouldn't help — we
    //     pass null so the worker's "no fallback" path kicks in.
    const inputMessages = buildRowboatChatMessages({
      summaryMd: thread.summary_md,
      tail: tail.slice(-RESEND_TAIL_MESSAGES),
      newUserMessage: body.message,
      includeTailContext: true,
      customerPreamble
    });
    const statelessInputMessages = hasContinuation
      ? buildRowboatChatMessages({
          summaryMd: thread.summary_md,
          tail,
          newUserMessage: body.message,
          includeTailContext: true,
          customerPreamble
        })
      : null;

    // Persist the user message BEFORE enqueueing. If the enqueue fails
    // for any reason the user's typed message is still saved — they
    // can retry without losing what they typed. Cheap insurance.
    const userMsg = await appendMessage(thread.id, "user", body.message);

    // Hand the work off to the VPS chat-worker. Both convId and
    // state are gated on hasContinuation rather than blanket
    // forwarded: if the stored convId is "" or whitespace,
    // hasContinuation is already false and statelessInputMessages
    // is null (no fallback). Forwarding "" anyway would have the
    // worker call Rowboat with an invalid empty conversationId,
    // Rowboat would reject it, and the job would fail permanently
    // because there's no fallback to escalate to. Mirrors the
    // pre-Option-B `useContinuation ? ... : null` gate. Bugbot
    // Medium-severity finding on PR #79 round-9.
    const job = await insertChatJob({
      businessId: body.businessId,
      threadId: thread.id,
      userMessageId: userMsg.id,
      inputMessages,
      statelessInputMessages,
      rowboatConversationId: hasContinuation
        ? thread.rowboat_conversation_id
        : null,
      rowboatState: hasContinuation ? thread.rowboat_state ?? null : null
    });

    // The summarizer runs on the worker side (after the assistant
    // message is persisted) — see comment above the import block. We
    // still need the post-user-message thread state for the response
    // body so the client can render the user's echo + the existing
    // history without an extra GET.
    const updated = await listMessages(thread.id);

    return successResponse({
      threadId: thread.id,
      activeThreadId: thread.id,
      jobId: job.id,
      userMessageId: userMsg.id,
      messages: serializeChatMessages(updated)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

// =====================================================================
// GET / DELETE — unchanged JSON envelope shape
// =====================================================================

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
    // Re-attach the "thinking…" indicator after a refresh / navigation:
    // if the worker is still chewing on the active thread's latest turn,
    // surface the live job id so the client can resume watching it
    // (Realtime + poll) instead of the indicator vanishing on reload.
    const pendingJob = thread ? await getInFlightChatJobForThread(thread.id) : null;

    return successResponse({
      threadId: thread?.id ?? null,
      messages: serializeChatMessages(messages),
      isPaused: flags.is_paused,
      customerChannelsEnabled: flags.customer_channels_enabled,
      pendingJob: pendingJob
        ? { id: pendingJob.id, threadId: pendingJob.thread_id }
        : null
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
