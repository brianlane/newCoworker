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
  type RowboatChatMessage
} from "@/lib/rowboat/chat";
import {
  shouldSummarize,
  summarizeThreadAndLog
} from "@/lib/dashboard-chat/summarizer";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;

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
    // Rolling summary (if any) is prepended as a system message so the
    // model sees long-term context without us having to stuff older
    // raw turns into the prompt. The summary covers everything the
    // tail truncation would have dropped; on threads with <= 20
    // messages there's no summary yet (summarizer below skips that
    // case) and this prepend is a no-op.
    const summaryPreamble: RowboatChatMessage[] =
      thread.summary_md && thread.summary_md.trim()
        ? [
            {
              role: "system",
              content: `Conversation summary so far:\n\n${thread.summary_md.trim()}`
            }
          ]
        : [];
    const rowboatMessages: RowboatChatMessage[] = [
      ...summaryPreamble,
      ...tail.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: body.message }
    ];

    let reply: string;
    let conversationId: string | undefined;
    let state: unknown | undefined;
    try {
      const parsed = await callRowboatChat({
        businessId: body.businessId,
        projectId,
        bearer,
        messages: rowboatMessages,
        conversationId: thread.rowboat_conversation_id,
        state: thread.rowboat_state
      });
      reply = parsed.reply;
      conversationId = parsed.conversationId;
      state = parsed.hasStateKey ? parsed.state : undefined;
    } catch (err) {
      const friendly = describeRowboatError(err);
      return errorResponse("CONFLICT", friendly, 502);
    }

    // Success path: persist user + assistant together so they always appear
    // as a matched turn in history. Order is preserved by created_at.
    await appendMessage(thread.id, "user", body.message);
    await appendMessage(thread.id, "assistant", reply);
    if (conversationId || state !== undefined) {
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
