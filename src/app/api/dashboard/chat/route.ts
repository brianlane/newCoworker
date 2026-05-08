/**
 * Owner ↔ local-model chat endpoint for /dashboard/chat.
 *
 * POST   send a message — STREAMS the reply as NDJSON (`meta` → `delta…` → `done|error`)
 * GET    hydrate the active thread + flag state for the client
 * DELETE end the active thread so the next POST starts fresh
 *
 * Auth: getAuthUser + requireOwner(businessId). Kill switch (is_paused) soft-
 * blocks the endpoint with a 409 so the UI can show a Resume CTA; Safe Mode
 * is deliberately NOT gated (the whole point is the owner stays online while
 * customer channels forward to their cell).
 *
 * Why streaming: the per-tenant Rowboat sits behind a Cloudflare Tunnel
 * whose `originRequest.idleTimeout` defaults to ~60-100s. With buffered
 * (`stream: false`) calls a 70s+ Ollama generation produced no traffic
 * before the tunnel timer tripped, surfacing as a 524 → Vercel 502 →
 * client "Unexpected server response". Streaming token-by-token keeps
 * the connection live, structurally eliminating that failure mode and
 * letting the model take as long as it needs (bounded only by Vercel
 * `maxDuration` = 800s at the route level — Vercel Pro maximum).
 *
 * Wire shape (NDJSON over the response body — one JSON object per line):
 *   {"type":"meta","threadId":"...","activeThreadId":"..."}
 *   {"type":"delta","content":"Hello"}
 *   {"type":"delta","content":" world"}
 *   {"type":"ping"}                                    // 15s heartbeat (no delta)
 *   {"type":"done","messages":[...]}                   // server-canonical message list
 *                                                      // OR
 *   {"type":"error","code":"CONFLICT","message":"…"}
 *
 * NDJSON (not text/event-stream) chosen because:
 *   - Trivial client parser (split on `\n`, JSON.parse).
 *   - Doesn't conflict with the rest of the app's `parseEnvelope` JSON
 *     contract — non-streaming endpoints are unaffected.
 *   - Vercel doesn't strip trailing newlines on the `application/x-ndjson`
 *     content type.
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
  callRowboatChatStream,
  describeRowboatError,
  type RowboatChatMessage,
  type RowboatStreamEvent
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

// Vercel Pro hard ceiling (max allowed: 800s on Pro). Streaming
// responses don't depend on this for idle-timer survival (the
// connection stays warm because tokens flow + we send periodic ping
// heartbeats during the pre-token wait), but `maxDuration` still
// bounds the absolute longest a single owner turn can take. Bumped
// from 300s → 800s after production logs (May 7, 2026) showed
// owners hitting both the per-tenant Rowboat 90s TTFB AND the
// Vercel 300s reaper on legitimately complex queries (cross-channel
// customer summaries on tenants with hundreds of records). 800s
// gives the slowest realistic Rowboat workflow ~13 minutes of
// headroom while still preventing a runaway from pinning a function
// slot indefinitely.
export const maxDuration = 800;

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;

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
 * Critically, the streaming retry only fires when ZERO `delta` events
 * have reached the client. Once tokens are out, retrying would emit
 * duplicate text and the client UX would look like a stuttering reply.
 *
 * 524 / 522 / 408 are infrastructure-level "no response in time"
 * signals — Cloudflare Tunnel idle timeout, origin connection timeout,
 * request timeout. They're now in the retry set because the most
 * common cause is a wedged per-tenant tunnel that recovers on a fresh
 * stateless prompt; pre-streaming they were treated as fatal because
 * the buffered path couldn't distinguish them from the model itself
 * being slow.
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
  "rowboat_http_408",
  "rowboat_http_409",
  "rowboat_http_500",
  "rowboat_http_502",
  "rowboat_http_503",
  "rowboat_http_522",
  "rowboat_http_524",
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

NO FABRICATION. If your "Recent customer activity" notes don't contain a specific detail the owner is asking about (a city like "Scottsdale", an exact time, the body of a message, the property they asked about), say so plainly: "I don't have that detail in my notes — check /dashboard/calls or /dashboard/messages for the full record." Never paraphrase a generic phrase like "wants to buy a home" into specifics like "3-bedroom in Scottsdale". You are working from a thin index, not a full transcript. Inventing details is worse than admitting you don't have them.

You may have access to a "Recent customer activity" system message below. That data is REAL — it summarizes actual customers who contacted this business by SMS or voice. Use it to answer questions like "did anyone call about X" or "what did the customer who texted yesterday want". Treat it as your working notes; quote the exact phone numbers and timestamps it contains when asked.

You will never ask the owner for their own contact info, schedule, or business details. They already configured all of that. If they want to update their identity/memory/business hours, point them to /dashboard/memory.`;

export { OWNER_PREAMBLE };

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

// =====================================================================
// NDJSON streaming response helpers
// =====================================================================

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  // Disable Vercel's edge-cache buffering on Node functions. Without
  // this header some intermediaries hold the response until enough
  // bytes accumulate, undoing the entire point of streaming.
  "X-Accel-Buffering": "no",
  Connection: "keep-alive"
};

type NdjsonErrorEvent = {
  type: "error";
  /** Status family for the client (`UNAUTHORIZED`, `CONFLICT`, `NOT_FOUND`, etc.). */
  code: string;
  message: string;
};

/**
 * Single-event NDJSON response for preflight failures (auth, rate
 * limit, paused business, missing config). Status code on the HTTP
 * response is meaningful (the client uses it for routing) AND the
 * body carries the friendly copy the UI shows.
 *
 * Two responses on the wire (HTTP status + NDJSON event) keeps the
 * client's reader logic uniform: every POST yields NDJSON regardless
 * of preflight outcome, no hybrid `try res.json() else stream`
 * branches.
 */
function ndjsonError(status: number, code: string, message: string): Response {
  const ev: NdjsonErrorEvent = { type: "error", code, message };
  return new Response(JSON.stringify(ev) + "\n", {
    status,
    headers: NDJSON_HEADERS
  });
}

export async function POST(request: Request) {
  // ---------------------------------------------------------------
  // PREFLIGHT — auth, rate limit, kill-switch, config, thread, history.
  // Failures here surface as a single NDJSON `error` event with a
  // meaningful HTTP status. The streaming response is opened only
  // once we've committed to actually calling Rowboat.
  // ---------------------------------------------------------------
  let body: z.infer<typeof postBodySchema>;
  let businessIdForLog = "";
  let threadIdForLog = "";
  try {
    const user = await getAuthUser();
    if (!user) {
      return ndjsonError(401, "UNAUTHORIZED", "Authentication required");
    }

    body = postBodySchema.parse(await request.json());
    businessIdForLog = body.businessId;
    if (!user.isAdmin) await requireOwner(body.businessId);

    const limiter = rateLimit(`dashboard-chat:${body.businessId}`, DASHBOARD_CHAT_RATE);
    if (!limiter.success) {
      return ndjsonError(
        429,
        "CONFLICT",
        "Too many messages, please wait a minute."
      );
    }

    const flags = await loadBusinessFlags(body.businessId);
    if (!flags) return ndjsonError(404, "NOT_FOUND", "Business not found");

    if (flags.is_paused) {
      return ndjsonError(
        409,
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
      return ndjsonError(
        409,
        "CONFLICT",
        "Your coworker's chat service isn't ready yet. Provisioning may still be in progress."
      );
    }
    if (!bearer) {
      return ndjsonError(
        500,
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
      if (!target) return ndjsonError(404, "NOT_FOUND", "Conversation not found");
      if (target.business_id !== body.businessId) {
        // Same-status response as a missing row so the caller can't
        // distinguish "not yours" from "doesn't exist" via timing.
        return ndjsonError(404, "NOT_FOUND", "Conversation not found");
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
    threadIdForLog = thread.id;

    // Build the Rowboat request off the *persisted* history plus the just-
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

    // Two message arrays: one for the initial (continuation-using) call
    // and one for the stateless fallback.
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

    // Persist the user message BEFORE opening the stream. If the
    // browser disconnects mid-generation (or Vercel reaper kicks in
    // at maxDuration) the owner's typed message survives — they can
    // resend without losing anything. The cost is a possibly-orphaned
    // user row when Rowboat fails before any token; acceptable trade
    // for never silently dropping an owner message.
    await appendMessage(thread.id, "user", body.message);

    // ---------------------------------------------------------------
    // STREAMING RESPONSE — preflight survived; commit to the stream.
    // ---------------------------------------------------------------
    const stream = createDashboardChatStream({
      businessId: body.businessId,
      projectId,
      bearer,
      thread,
      initialMessages,
      statelessMessages,
      hasContinuation,
      requestSignal: request.signal
    });

    return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
  } catch (err) {
    // Errors here are pre-stream — auth/validation/db lookup. Map to
    // the same NDJSON error shape so the client's reader handles every
    // failure mode uniformly.
    logger.warn("dashboard chat: preflight failed", {
      businessId: businessIdForLog,
      threadId: threadIdForLog,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return preflightErrorToNdjson(err);
  }
}

/**
 * Translate a thrown preflight error into the NDJSON envelope shape.
 * Mirrors `handleRouteError` in `lib/api-response.ts` but emits a
 * single-event NDJSON response so the client reader sees a uniform
 * format regardless of failure mode.
 */
async function preflightErrorToNdjson(error: unknown): Promise<Response> {
  // Re-use the standard JSON envelope for shaping (correct status
  // codes, code mapping for ZodError / Error.status). Then re-wrap as
  // NDJSON so the client reader doesn't need a JSON-vs-NDJSON branch.
  const jsonRes = handleRouteError(error);
  const status = jsonRes.status;
  type ApiErrorEnvelope = {
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  let env: ApiErrorEnvelope = {};
  try {
    env = (await jsonRes.clone().json()) as ApiErrorEnvelope;
  } catch {
    // Falling through with empty env triggers the defaults below.
  }
  const code = env.error?.code ?? "INTERNAL_SERVER_ERROR";
  const message = env.error?.message ?? "An unexpected error occurred";
  return ndjsonError(status, code, message);
}

// =====================================================================
// Streaming pipeline
// =====================================================================

type StreamPipelineInput = {
  businessId: string;
  projectId: string;
  bearer: string;
  thread: DashboardChatThreadRow;
  initialMessages: RowboatChatMessage[];
  statelessMessages: RowboatChatMessage[];
  hasContinuation: boolean;
  requestSignal: AbortSignal;
};

/**
 * Build the Web `ReadableStream` of NDJSON bytes that gets returned to
 * the client. Encapsulates the pipeline:
 *
 *   1. Emit `meta` — confirms the thread the server actually targeted
 *      (after archival re-resolution, etc.).
 *   2. Start `callRowboatChatStream` with the continuation, forward
 *      every `delta` to the client, buffer the full reply server-side
 *      for persistence.
 *   3. If Rowboat errors BEFORE any delta has reached the client AND
 *      the error is in `STATELESS_RETRY_ERRORS` AND we had a
 *      conversationId, retry once with the stateless message shape.
 *      Once tokens are out we MUST NOT retry — duplicate text would
 *      surface in the UI.
 *   4. Heartbeat: a 15s setInterval emits `{"type":"ping"}` whenever
 *      no delta has been forwarded in the prior 15s. Keeps Cloudflare
 *      / Vercel intermediaries from closing the *client-facing* socket
 *      while Ollama is still paging in the model on the first turn.
 *      Cleared on any error/done.
 *   5. On `done`: persist assistant message + conversation
 *      continuation, touch activity, fire-and-forget summarizer, read
 *      back canonical messages, emit `done` event with that list.
 *   6. On post-token error: emit `error` event without persisting the
 *      partial reply (we'd rather the user re-send than commit a
 *      half-finished assistant turn).
 */
function createDashboardChatStream(input: StreamPipelineInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const writeLine = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // Controller already closed (client disconnected). Mark so
          // we don't re-attempt on subsequent events.
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // Heartbeat. Reset on every delta. The 15s cadence is well under
      // Cloudflare's ~60s idle timer but generous enough that a fast
      // model doesn't pay for unused pings (deltas reset the clock).
      let lastForwardedAt = Date.now();
      const heartbeat = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastForwardedAt >= 15_000) {
          writeLine({ type: "ping" });
          lastForwardedAt = Date.now();
        }
      }, 5_000);

      // Client disconnect — tear down the heartbeat + NDJSON
      // controller and let the in-flight Rowboat call see it via the
      // request.signal we forward into callRowboatChatStream below.
      // Pre-fix this used a SEPARATE AbortController that was never
      // wired into the upstream fetch, so the per-tenant Ollama would
      // happily keep generating tokens nobody read until the internal
      // idle timer tripped 30s later (Codex P2 + Cursor Bugbot Medium
      // on PR #76). Now `request.signal` flows straight through to
      // `fetch()` and `reader.cancel()` inside `callRowboatChatStream`.
      const onClientAbort = () => {
        clearInterval(heartbeat);
        close();
      };
      input.requestSignal.addEventListener("abort", onClientAbort, { once: true });

      // Always send `meta` first. The client uses it to know the
      // route is alive and that the user's turn has been persisted —
      // the in-flight assistant bubble is now inserted on the FIRST
      // delta (not on `meta`) so owners don't see an empty placeholder
      // bubble during the pre-token wait.
      writeLine({
        type: "meta",
        threadId: input.thread.id,
        activeThreadId: input.thread.id
      });

      let retriedStateless = false;
      let lastError: { message: string } | null = null;

      /**
       * Per-attempt result returned by `runOnce`. Cursor Bugbot Low on
       * PR #76 commit fbbbe1f: pre-fix `buffered`, `deltasEmitted`,
       * `finalConversationId`, `finalState`, `finalHadStateKey` were
       * declared in the outer scope and mutated by `runOnce` directly
       * — meaning a stateless retry could in principle inherit stale
       * metadata from the first attempt. Today the upstream generator
       * yields errors before any metadata, so the leak doesn't trigger,
       * but the shared mutable state across logically independent
       * attempts is fragile. Scoping these per-attempt and returning
       * them in the result removes the fragility entirely: the caller
       * uses the final attempt's accumulator and the first attempt's
       * state cannot bleed forward.
       */
      type RunOnceResult = {
        buffered: string;
        deltasEmitted: number;
        finalConversationId: string | undefined;
        finalState: unknown | undefined;
        finalHadStateKey: boolean;
        outcome:
          | { kind: "done" }
          | { kind: "error"; message: string; retryable: boolean };
      };

      /**
       * Run a single Rowboat streaming call. Returns the per-attempt
       * accumulator (buffered text, delta count, final conversation
       * metadata) along with an outcome:
       *   - { kind: "done" } on graceful completion
       *   - { kind: "error", message, retryable } on upstream failure
       *
       * Retryable means the error is in STATELESS_RETRY_ERRORS AND we
       * still have permission to retry (no deltas emitted yet AND we
       * haven't already retried).
       */
      const runOnce = async (
        messages: RowboatChatMessage[],
        useContinuation: boolean
      ): Promise<RunOnceResult> => {
        let buffered = "";
        let deltasEmitted = 0;
        let finalConversationId: string | undefined;
        let finalState: unknown | undefined;
        let finalHadStateKey = false;
        const pack = (
          outcome: RunOnceResult["outcome"]
        ): RunOnceResult => ({
          buffered,
          deltasEmitted,
          finalConversationId,
          finalState,
          finalHadStateKey,
          outcome
        });

        // `callRowboatChatStream` is an `async function*` — calling it
        // synchronously returns an AsyncGenerator object and the body
        // does not run until iteration begins. There is therefore no
        // synchronous throw path to catch here; any errors raised
        // during iteration emerge through `for await` and are caught
        // by the outer `try/catch (unexpected)` in
        // createDashboardChatStream. (Cursor Bugbot Low on PR #76
        // commit 7d36f3b removed an unreachable try/catch that
        // wrapped this assignment.)
        const stream: AsyncGenerator<RowboatStreamEvent> = callRowboatChatStream({
          businessId: input.businessId,
          projectId: input.projectId,
          bearer: input.bearer,
          messages,
          conversationId: useContinuation ? input.thread.rowboat_conversation_id : null,
          state: useContinuation ? input.thread.rowboat_state : null,
          // Forward the browser's AbortSignal so a client disconnect
          // tears down the upstream Rowboat fetch + body reader
          // promptly instead of waiting up to 30s for the internal
          // idle timer.
          signal: input.requestSignal
        });

        for await (const event of stream) {
          if (closed) {
            // Client gave up. Drop the rest of the stream so we stop
            // burning Rowboat budget.
            try {
              await stream.return?.(undefined);
            } catch {
              /* ignore */
            }
            return pack({ kind: "error", message: "client_disconnected", retryable: false });
          }
          if (event.type === "delta") {
            buffered += event.text;
            deltasEmitted += 1;
            lastForwardedAt = Date.now();
            writeLine({ type: "delta", content: event.text });
          } else if (event.type === "tool_call") {
            // v1: tool calls aren't surfaced to the dashboard UI yet.
            // We drop them silently rather than leaking implementation
            // detail to the owner — but the parser yields them so a
            // future "Coworker is calling tool X" affordance is a
            // strict additive change.
            continue;
          } else if (event.type === "done") {
            if (event.conversationId !== undefined) finalConversationId = event.conversationId;
            if (event.hasStateKey) {
              finalState = event.state;
              finalHadStateKey = true;
            }
            return pack({ kind: "done" });
          } else if (event.type === "error") {
            const retryable =
              STATELESS_RETRY_ERRORS.has(event.message) &&
              deltasEmitted === 0 &&
              !retriedStateless &&
              input.hasContinuation;
            return pack({ kind: "error", message: event.message, retryable });
          }
        }
        // Generator ended without yielding an explicit terminal
        // event. Today `callRowboatChatStream` always yields error/
        // done before returning, so this path is reachable only via
        // test mocks that exhaust their event array; production
        // streams never land here. Cursor Bugbot Low on PR #76
        // commit 837c6e8: even though unreachable in prod, the
        // fallback MUST stay correct because the architecture
        // depends on STATELESS_RETRY_ERRORS recovery — a future
        // generator-contract change must NOT silently bypass it.
        //
        // Two rules to mirror the inline branches:
        //   1. "Did the user see meaningful content?" uses
        //      `buffered.trim().length > 0` — same gate as
        //      persistence and the post-error friendly message.
        //      Whitespace-only buffered content is empty, full stop.
        //   2. `rowboat_empty_assistant` is in
        //      STATELESS_RETRY_ERRORS, so the retry gate here uses
        //      the SAME conditions as the inline error handler
        //      above (no deltas yet, haven't already retried,
        //      thread has a continuation worth blowing away).
        if (buffered.trim().length > 0) return pack({ kind: "done" });
        const retryable =
          deltasEmitted === 0 && !retriedStateless && input.hasContinuation;
        return pack({
          kind: "error",
          message: "rowboat_empty_assistant",
          retryable
        });
      };

      try {
        // First attempt — with continuation (if any).
        let result = await runOnce(input.initialMessages, true);
        if (result.outcome.kind === "error" && result.outcome.retryable) {
          retriedStateless = true;
          logger.info("dashboard chat: retrying stateless after pre-token error", {
            businessId: input.businessId,
            threadId: input.thread.id,
            firstError: result.outcome.message
          });
          // Re-run with the stateless-fallback message set; result
          // REPLACES the first-attempt result so persistence and the
          // post-error friendly-message logic see ONLY the second
          // attempt's accumulators. Stale metadata from the first
          // attempt cannot bleed forward.
          result = await runOnce(input.statelessMessages, false);
        }

        const {
          buffered,
          deltasEmitted,
          finalConversationId,
          finalState,
          finalHadStateKey,
          outcome
        } = result;

        if (outcome.kind === "error") {
          lastError = { message: outcome.message };
        }

        // Done path — persist, summarize, emit final event.
        if (outcome.kind === "done") {
          // Defensive: an explicit `done` with zero accumulated content
          // is functionally an empty-assistant case. Don't persist a
          // blank assistant row — surface as an error so the client
          // can prompt a re-send.
          if (buffered.trim().length === 0) {
            lastError = { message: "rowboat_empty_assistant" };
          } else {
            try {
              await appendMessage(input.thread.id, "assistant", buffered);
              // When we used the stateless fallback, the thread's
              // stored rowboat_conversation_id is *known* stale —
              // Rowboat had already failed with a STATELESS_RETRY_ERRORS
              // code on it. Even if the retry's response omits a
              // fresh conversationId, we MUST overwrite the DB with
              // whatever the retry returned (possibly null). Otherwise
              // the next turn re-sends the same dead id, fails,
              // retries, and we pay 2x latency forever.
              if (retriedStateless || finalConversationId || finalHadStateKey) {
                await updateThreadConversation(
                  input.thread.id,
                  finalConversationId ?? null,
                  finalHadStateKey ? finalState : undefined
                );
              }
              await touchChatActivity(input.businessId);

              const updated = await listMessages(input.thread.id);

              // Rolling-summary trigger. Fire-and-forget so a slow
              // Ollama doesn't block the chat response. Gate before
              // invoking so we don't spam logs with "below_threshold"
              // rejections on every short-thread turn.
              if (shouldSummarize(input.thread, updated.length)) {
                void summarizeThreadAndLog(input.businessId, input.thread.id);
              }

              writeLine({
                type: "done",
                threadId: input.thread.id,
                messages: serializeChatMessages(updated)
              });
            } catch (persistErr) {
              // Persistence failed AFTER the model already produced
              // text. The user has seen the reply; we cannot un-send
              // it. Log and emit an error so the UI can flag the
              // staleness on next reload.
              logger.error("dashboard chat: persistence failed after stream done", {
                businessId: input.businessId,
                threadId: input.thread.id,
                errorMessage:
                  persistErr instanceof Error ? persistErr.message : String(persistErr)
              });
              writeLine({
                type: "error",
                code: "INTERNAL_SERVER_ERROR",
                message:
                  "Saved your message but couldn't save the reply. Refresh to see the latest state."
              });
            }
          }
        }

        if (lastError) {
          // Pre-meaningful-content errors → friendly copy from
          // describeRowboatError ("didn't produce a reply", etc).
          // Post-meaningful-content errors → tell the user the
          // connection cut off, their reply may be incomplete.
          //
          // Cursor Bugbot Low on PR #76 commit e722c7d: pre-fix the
          // gate was `deltasEmitted === 0`, which treated whitespace-
          // only deltas as "user already saw content" and showed the
          // misleading "Connection cut off" message. The persistence
          // gate above uses `buffered.trim().length === 0` — these
          // two gates MUST stay aligned, otherwise the user sees a
          // "your reply may be incomplete" warning for a reply that
          // was actually never persisted (and disappears on refresh).
          const sawMeaningfulContent = buffered.trim().length > 0;
          const friendly = sawMeaningfulContent
            ? "Connection cut off — your reply may be incomplete. Please try again."
            : describeRowboatError(new Error(lastError.message));
          logger.warn("dashboard chat: rowboat stream failed", {
            businessId: input.businessId,
            threadId: input.thread.id,
            errorMessage: lastError.message,
            retriedStateless,
            deltasEmitted,
            sawMeaningfulContent
          });
          writeLine({
            type: "error",
            code: "CONFLICT",
            message: friendly
          });
        }
      } catch (unexpected) {
        // Anything we didn't anticipate — never crash the controller
        // without emitting an error event the client can render.
        logger.error("dashboard chat: unexpected stream error", {
          businessId: input.businessId,
          threadId: input.thread.id,
          errorMessage:
            unexpected instanceof Error ? unexpected.message : String(unexpected)
        });
        writeLine({
          type: "error",
          code: "INTERNAL_SERVER_ERROR",
          message: "Your coworker hit an unexpected error. Please try again."
        });
      } finally {
        clearInterval(heartbeat);
        input.requestSignal.removeEventListener("abort", onClientAbort);
        close();
      }
    }
  });
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
