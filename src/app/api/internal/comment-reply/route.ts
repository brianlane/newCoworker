/**
 * Internal comment-reply endpoint: the bridge the Deno AiFlow worker calls
 * for `reply_to_comment` steps, on Instagram and Facebook alike. The Graph
 * client and the page token's decryption both live in src/lib and need the
 * Node runtime, same arrangement as /api/internal/whatsapp-send.
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth).
 *
 * POST { businessId, commentId, text, mode, platform }
 *   mode:     "public"    reply on the comment thread
 *             "private"   direct message to the commenter
 *   platform: "instagram" | "facebook"
 * → 200 with a structured result. An `ok:false` outcome is NOT an HTTP
 *   error: a permanent refusal is a step-level skip the worker reports in
 *   actions_taken, not a transport failure worth retrying.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getMetaConnection } from "@/lib/db/meta-connections";
import {
  INSTAGRAM_COMMENT_MAX_LENGTH,
  MetaApiError,
  isMetaPermissionDenied,
  replyToFacebookComment,
  replyToInstagramComment,
  sendInstagramPrivateReply
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";
import { reportMetaCallFailure } from "@/lib/meta/token-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  commentId: z.string().min(1).max(200),
  text: z.string().min(1).max(INSTAGRAM_COMMENT_MAX_LENGTH),
  mode: z.enum(["public", "private"]),
  // Older workers predate this field; Instagram was the only surface then.
  platform: z.enum(["instagram", "facebook"]).default("instagram")
});

export type CommentReplyResult =
  | { ok: true; mode: "public" | "private"; id: string | null }
  | { ok: false; reason: string; detail?: string };

/**
 * Meta error codes that mean "try again later": transient platform blips
 * and the throttling family. Everything else on the error path is treated
 * as permanent FOR THIS COMMENT, because the private-reply rules make most
 * refusals unrepeatable by design: one reply per comment, 7-day window,
 * live-broadcast-only for a Live. Retrying those just burns the step's
 * retry budget and can never succeed.
 *
 * Deliberately a retryable allowlist rather than a permanent-error list:
 * Meta's refusal codes for the reply paths are not fully enumerated in the
 * docs, and guessing wrong in this direction only costs a delayed reply,
 * while guessing wrong the other way spams a commenter's inbox.
 */
const RETRYABLE_META_CODES = new Set([
  1, // API Unknown (transient)
  2, // API Service (temporary Graph problem)
  4, // application-level rate limit
  17, // user-level rate limit
  32, // page-level rate limit
  341, // application temporarily blocked
  613 // calls-per-second limit
]);

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    const connection = await getMetaConnection(body.businessId);
    if (!connection?.pageToken) {
      return successResponse<CommentReplyResult>({
        ok: false,
        reason: "not_connected"
      });
    }
    if (!connection.is_active) {
      return successResponse<CommentReplyResult>({
        ok: false,
        reason: "connection_inactive"
      });
    }
    // The private reply is addressed through the PAGE node on BOTH surfaces
    // (we are a Facebook Login app); without a page id there is nothing to
    // post to.
    const pageId = connection.page_id;
    if (body.mode === "private" && !pageId) {
      return successResponse<CommentReplyResult>({ ok: false, reason: "no_page_id" });
    }

    try {
      if (body.mode === "public") {
        // Different edges for the same idea: Instagram replies live on
        // /{comment_id}/replies, Facebook's on /{comment_id}/comments.
        const reply =
          body.platform === "facebook" ? replyToFacebookComment : replyToInstagramComment;
        const { commentId } = await reply(body.commentId, connection.pageToken, body.text);
        return successResponse<CommentReplyResult>({
          ok: true,
          mode: "public",
          id: commentId
        });
      }
      // The private reply is the SAME call on both surfaces: the Messenger
      // Send API addressed by recipient.comment_id, on the Page node.
      const { messageId } = await sendInstagramPrivateReply(
        pageId as string,
        connection.pageToken,
        body.commentId,
        body.text
      );
      return successResponse<CommentReplyResult>({
        ok: true,
        mode: "private",
        id: messageId
      });
    } catch (err) {
      // graphRequest only ever throws MetaApiError.
      const meta = err as MetaApiError;
      logger.warn("instagram comment reply failed", {
        businessId: body.businessId,
        mode: body.mode,
        platform: body.platform,
        metaCode: meta.metaCode,
        metaSubcode: meta.metaSubcode,
        message: meta.message
      });
      // Our app was never granted the permission this call needs. Nothing
      // the owner can do fixes it, and it is NOT a dead token, so it must not
      // send them off to reconnect. Reported as its own reason so the worker
      // can say something true and non-alarming.
      //
      // Detected from Meta's answer rather than from a hardcoded scope list,
      // so the day App Review grants the permission this simply starts
      // working with no code change.
      if (isMetaPermissionDenied(err)) {
        logger.warn("comment reply refused: app permission not granted", {
          businessId: body.businessId,
          mode: body.mode,
          platform: body.platform,
          metaCode: meta.metaCode
        });
        return successResponse<CommentReplyResult>({
          ok: false,
          reason: "permission_not_granted",
          detail: meta.message
        });
      }
      // A dead token is not a per-comment refusal: every Meta call for this
      // tenant is failing, so it escalates to the owner instead of being
      // reported as "Instagram refused this comment".
      await reportMetaCallFailure(body.businessId, err, { surface: "comment_reply" });
      const retryable =
        meta.code !== "request_failed" ||
        (meta.status ?? 0) >= 500 ||
        (meta.metaCode !== undefined && RETRYABLE_META_CODES.has(meta.metaCode));
      return successResponse<CommentReplyResult>({
        ok: false,
        reason: retryable ? "send_failed" : "refused",
        // Meta's own words: the worker puts this in actions_taken, so the
        // owner reads why instead of "it didn't work".
        detail: meta.message
      });
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
