/**
 * Manual owner reply into a Messenger/Instagram DM conversation.
 *
 * POST { businessId, conversationId, text }
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages")
 * (admins bypass) — the same capability that gates manual SMS sends.
 *
 * Delivery: the SAME 24h-window gate + Send API path the AI worker uses,
 * then the message is appended with role 'owner' so the thread view (and
 * the engine's history mapping) can tell a human reply from the AI's.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  appendMessengerMessage,
  getMessengerConversationById,
  messengerWindowOpen
} from "@/lib/messenger/db";
import { getActiveMetaConnectionByPageId } from "@/lib/db/meta-connections";
import { sendMessengerMessage, MESSENGER_MAX_TEXT_LENGTH } from "@/lib/meta/client";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(MESSENGER_MAX_TEXT_LENGTH)
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (!user.isAdmin) {
      await requireBusinessRole(body.businessId, "operate_messages");
    }

    const conversation = await getMessengerConversationById(body.conversationId);
    if (!conversation || conversation.business_id !== body.businessId) {
      return errorResponse("NOT_FOUND", "Conversation not found");
    }

    if (!messengerWindowOpen(conversation)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Meta's 24-hour reply window has closed - it reopens when the lead messages again"
      );
    }

    const connection = await getActiveMetaConnectionByPageId(conversation.page_id);
    if (!connection?.pageToken) {
      return errorResponse("VALIDATION_ERROR", "Facebook is no longer connected");
    }

    await sendMessengerMessage(
      conversation.page_id,
      connection.pageToken,
      conversation.psid,
      body.text
    );

    const message = await appendMessengerMessage({
      conversationId: conversation.id,
      businessId: body.businessId,
      role: "owner",
      content: body.text
    });

    return successResponse({ messageId: message?.id ?? null });
  } catch (err) {
    return handleRouteError(err);
  }
}
