/**
 * POST /api/widget/message — one visitor turn on the website chat widget.
 *
 * Write-and-queue, mirroring /api/dashboard/chat (PR #79): the route
 * persists the visitor message, enqueues a webchat_jobs row with the
 * pre-built Rowboat input, and returns the jobId immediately. The
 * per-tenant VPS chat-worker produces the reply; the widget POLLS
 * /api/widget/poll for it (anonymous visitors have no Realtime identity).
 *
 * Auth: public site key (body) + per-session bearer (Authorization).
 * Abuse controls, in order of cheapness: per-session in-memory + per-IP
 * durable rate limits, message char cap, and the per-business rolling-24h visitor
 * message ceiling (hard stop protecting the tenant's shared AI budget from
 * anonymous traffic — the spend fuse degrading to the local model is the
 * soft layer under this).
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit, rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import {
  appendWebchatMessage,
  countWebchatUserMessagesSince,
  deleteWebchatMessage,
  getWebchatJobForUserMessage,
  getWebchatMessageByClientId,
  insertWebchatJob,
  isWebchatUniqueViolation,
  listWebchatMessages,
  serializeWebchatMessages,
  touchWebchatSession,
  type WebchatMessageRow
} from "@/lib/webchat/db";
import { logger } from "@/lib/logger";
import {
  resolveWidgetContext,
  sessionSatisfiesContactGate,
  verifyWebchatSession,
  webchatDailyMessageCap
} from "@/lib/webchat/service";
import {
  buildWebchatRowboatMessages,
  WEBCHAT_HISTORY_TURNS,
  WEBCHAT_MAX_MESSAGE_CHARS,
  WEBCHAT_RESEND_TAIL_MESSAGES
} from "@/lib/webchat/prompt";
import { appendVisitorPage, parseVisitorMeta } from "@/lib/webchat/visitor-meta";
import { updateWebchatSessionMeta, type WebchatSessionRow } from "@/lib/webchat/db";

/**
 * Best-effort page-trail append — runs on normal sends AND idempotent
 * replays (a retry whose original POST died before the trail write must
 * still record the page). Never throws: the turn is already safe.
 */
async function recordVisitorPage(
  session: Pick<WebchatSessionRow, "id" | "visitor_meta">,
  page: string | undefined
): Promise<void> {
  if (!page) return;
  const next = appendVisitorPage(parseVisitorMeta(session.visitor_meta ?? null), page);
  if (!next) return;
  await updateWebchatSessionMeta(session.id, next).catch((err) => {
    logger.warn("widget/message: visitor page-trail update failed", {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err)
    });
  });
}

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Per-session stays in-memory (cheap local backstop — a session is already
// a scarce, bearer-authed identity); per-IP is durable so the quota binds
// fleet-wide instead of per Vercel isolate (audit 2026-07, finding M3).
const MESSAGE_RATE_PER_SESSION = { interval: 5 * 60 * 1000, maxRequests: 20 };
const MESSAGE_RATE_PER_IP = { interval: 5 * 60 * 1000, maxRequests: 40 };

const bodySchema = z.object({
  key: z.string().max(200),
  message: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .max(WEBCHAT_MAX_MESSAGE_CHARS, `Message is too long (max ${WEBCHAT_MAX_MESSAGE_CHARS} chars)`),
  // Client-generated idempotency key: the widget mints one UUID per send
  // and RETRIES a network-failed POST with the same value, so a turn that
  // actually persisted server-side is replayed (original message + job)
  // instead of duplicated.
  clientMessageId: z.string().uuid().optional(),
  // The page the visitor is on when sending — appended to the session's
  // visitor_meta page trail (deduped/capped). Best-effort, never blocking.
  page: z.string().trim().max(2000).optional()
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());

    const ctx = await resolveWidgetContext({ key: body.key });
    if (!ctx.ok) {
      if (ctx.reason === "offline") {
        return errorResponse("CONFLICT", "Chat is offline right now. Please try again later.");
      }
      return errorResponse("UNAUTHORIZED", "This chat widget is not available.");
    }

    const session = await verifyWebchatSession({
      authorizationHeader: request.headers.get("authorization"),
      businessId: ctx.business.id
    });
    if (!session) {
      // The widget restarts its session on 401 — expired TTL and stale
      // bearers are normal, not errors.
      return errorResponse("UNAUTHORIZED", "Chat session expired. Please start a new chat.");
    }

    // Pre-chat contact gate, re-checked EVERY turn: a bearer minted while
    // the form was off (or by a client that skipped it) can't keep chatting
    // past a later-enabled requirement. The frame maps this 403 to the
    // contact form.
    if (!sessionSatisfiesContactGate(ctx.settings, session)) {
      return errorResponse(
        "FORBIDDEN",
        "Please share your name and an email or phone number to continue this chat.",
        403
      );
    }

    const ip = rateLimitIdentifierFromRequest(request);
    const sessionLimiter = rateLimit(`webchat-msg:s:${session.id}`, MESSAGE_RATE_PER_SESSION);
    if (!sessionLimiter.success) {
      return errorResponse("CONFLICT", "Too many messages, please wait a minute.", 429);
    }
    const ipLimiter = await rateLimitDurable(`webchat-msg:ip:${ip}`, MESSAGE_RATE_PER_IP);
    if (!ipLimiter.success) {
      return errorResponse("CONFLICT", "Too many messages, please wait a minute.", 429);
    }

    // Idempotent-send replay: if this clientMessageId already persisted (the
    // widget retried after a network/parse failure on a POST that actually
    // succeeded), return the ORIGINAL message + job instead of re-running
    // the turn. Checked before the daily cap so a replay never burns quota.
    if (body.clientMessageId) {
      const existing = await getWebchatMessageByClientId(session.id, body.clientMessageId);
      if (existing) {
        const existingJob = await getWebchatJobForUserMessage(existing.id);
        const history = await listWebchatMessages(session.id);
        await recordVisitorPage(session, body.page);
        return successResponse({
          jobId: existingJob?.id ?? null,
          userMessageId: existing.id,
          messages: serializeWebchatMessages(history),
          replayed: true
        });
      }
    }

    // Per-business rolling-24h ceiling. Checked BEFORE persisting the turn
    // so over-cap traffic writes nothing.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = await countWebchatUserMessagesSince(ctx.business.id, since);
    if (used >= webchatDailyMessageCap()) {
      return errorResponse(
        "CONFLICT",
        "Chat is very busy right now. Please try again later or contact us directly.",
        429
      );
    }

    // Build the Rowboat input off the persisted history plus the new turn
    // (the new message rides separately as the [Webchat] user turn).
    const history = await listWebchatMessages(session.id);
    const tail = history.slice(-WEBCHAT_HISTORY_TURNS);

    // The worker always runs webchat turns stateless with an explicit
    // startAgent (see vps/chat-worker/worker.mjs); the stored conversation
    // id is only a "this session has prior Rowboat history" marker that
    // flips us to the full-tail variant.
    const hasHistoryMarker =
      typeof session.rowboat_conversation_id === "string" &&
      session.rowboat_conversation_id.trim().length > 0;

    const visitor = {
      name: session.visitor_name,
      email: session.visitor_email,
      phone: session.visitor_phone
    };
    const inputMessages = buildWebchatRowboatMessages({
      tail: tail.slice(-WEBCHAT_RESEND_TAIL_MESSAGES),
      newUserMessage: body.message,
      visitor,
      sessionId: session.id,
      businessTimezone: ctx.business.timezone
    });
    const statelessInputMessages = hasHistoryMarker
      ? buildWebchatRowboatMessages({
          tail,
          newUserMessage: body.message,
          visitor,
          sessionId: session.id,
          businessTimezone: ctx.business.timezone
        })
      : null;

    // Persist the visitor message, then enqueue. Two failure shapes:
    //   * The INSERT loses the idempotency race (two concurrent identical
    //     retries): re-read the winner and replay its job.
    //   * The JOB insert fails after the message persisted: delete the
    //     orphaned message (compensating write) and surface the error —
    //     otherwise the transcript would keep a visitor turn no worker will
    //     ever answer, and the widget's retry (same clientMessageId) would
    //     replay a jobless message forever.
    let userMsg: WebchatMessageRow;
    try {
      userMsg = await appendWebchatMessage(session.id, ctx.business.id, "user", body.message, {
        clientMessageId: body.clientMessageId ?? null
      });
    } catch (err) {
      if (body.clientMessageId && isWebchatUniqueViolation(err)) {
        const winner = await getWebchatMessageByClientId(session.id, body.clientMessageId);
        if (winner) {
          const winnerJob = await getWebchatJobForUserMessage(winner.id);
          const history = await listWebchatMessages(session.id);
          await recordVisitorPage(session, body.page);
          return successResponse({
            jobId: winnerJob?.id ?? null,
            userMessageId: winner.id,
            messages: serializeWebchatMessages(history),
            replayed: true
          });
        }
      }
      throw err;
    }

    let job;
    try {
      job = await insertWebchatJob({
        businessId: ctx.business.id,
        sessionId: session.id,
        userMessageId: userMsg.id,
        inputMessages,
        statelessInputMessages,
        rowboatConversationId: hasHistoryMarker ? session.rowboat_conversation_id : null
      });
    } catch (err) {
      try {
        await deleteWebchatMessage(userMsg.id);
      } catch (cleanupErr) {
        // Non-fatal: the orphan stays in the transcript, but the 500 below
        // still tells the widget the turn failed so the visitor retries.
        logger.warn("widget/message: orphan cleanup failed after job insert error", {
          messageId: userMsg.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        });
      }
      throw err;
    }

    await touchWebchatSession(session.id);

    // Page-trail append — best-effort, after the turn is safely enqueued.
    await recordVisitorPage(session, body.page);

    return successResponse({
      jobId: job.id,
      userMessageId: userMsg.id,
      messages: serializeWebchatMessages([...history, userMsg])
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
