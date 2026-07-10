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
 * Abuse controls, in order of cheapness: per-IP and per-session in-memory
 * rate limits, message char cap, and the per-business rolling-24h visitor
 * message ceiling (hard stop protecting the tenant's shared AI budget from
 * anonymous traffic — the spend fuse degrading to the local model is the
 * soft layer under this).
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import {
  appendWebchatMessage,
  countWebchatUserMessagesSince,
  insertWebchatJob,
  listWebchatMessages,
  serializeWebchatMessages,
  touchWebchatSession
} from "@/lib/webchat/db";
import {
  resolveWidgetContext,
  verifyWebchatSession,
  webchatDailyMessageCap
} from "@/lib/webchat/service";
import {
  buildWebchatRowboatMessages,
  WEBCHAT_HISTORY_TURNS,
  WEBCHAT_MAX_MESSAGE_CHARS,
  WEBCHAT_RESEND_TAIL_MESSAGES
} from "@/lib/webchat/prompt";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MESSAGE_RATE_PER_SESSION = { interval: 5 * 60 * 1000, maxRequests: 20 };
const MESSAGE_RATE_PER_IP = { interval: 5 * 60 * 1000, maxRequests: 40 };

const bodySchema = z.object({
  key: z.string().max(200),
  message: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .max(WEBCHAT_MAX_MESSAGE_CHARS, `Message is too long (max ${WEBCHAT_MAX_MESSAGE_CHARS} chars)`)
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

    const ip = rateLimitIdentifierFromRequest(request);
    const sessionLimiter = rateLimit(`webchat-msg:s:${session.id}`, MESSAGE_RATE_PER_SESSION);
    const ipLimiter = rateLimit(`webchat-msg:ip:${ip}`, MESSAGE_RATE_PER_IP);
    if (!sessionLimiter.success || !ipLimiter.success) {
      return errorResponse("CONFLICT", "Too many messages, please wait a minute.", 429);
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

    // Persist the visitor message BEFORE enqueueing — a failed enqueue
    // leaves their typed message recoverable on retry.
    const userMsg = await appendWebchatMessage(session.id, ctx.business.id, "user", body.message);

    const job = await insertWebchatJob({
      businessId: ctx.business.id,
      sessionId: session.id,
      userMessageId: userMsg.id,
      inputMessages,
      statelessInputMessages,
      rowboatConversationId: hasHistoryMarker ? session.rowboat_conversation_id : null
    });

    await touchWebchatSession(session.id);

    return successResponse({
      jobId: job.id,
      userMessageId: userMsg.id,
      messages: serializeWebchatMessages([...history, userMsg])
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
