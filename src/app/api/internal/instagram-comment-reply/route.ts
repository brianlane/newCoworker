/**
 * Internal Instagram comment-reply endpoint: the bridge the Deno AiFlow
 * worker calls for `reply_to_comment` steps. The Graph client and the page
 * token's decryption both live in src/lib and need the Node runtime, same
 * arrangement as /api/internal/whatsapp-send.
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth).
 *
 * POST { businessId, commentId, text, mode: "public" | "private" }
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
  replyToInstagramComment,
  sendInstagramPrivateReply
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  commentId: z.string().min(1).max(200),
  text: z.string().min(1).max(INSTAGRAM_COMMENT_MAX_LENGTH),
  mode: z.enum(["public", "private"])
});

export type InstagramCommentReplyResult =
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
      return successResponse<InstagramCommentReplyResult>({
        ok: false,
        reason: "not_connected"
      });
    }
    if (!connection.is_active) {
      return successResponse<InstagramCommentReplyResult>({
        ok: false,
        reason: "connection_inactive"
      });
    }
    // The private reply is addressed through the PAGE node (we are a
    // Facebook Login app); without a page id there is nothing to post to.
    const pageId = connection.page_id;
    if (body.mode === "private" && !pageId) {
      return successResponse<InstagramCommentReplyResult>({ ok: false, reason: "no_page_id" });
    }

    try {
      if (body.mode === "public") {
        const { commentId } = await replyToInstagramComment(
          body.commentId,
          connection.pageToken,
          body.text
        );
        return successResponse<InstagramCommentReplyResult>({
          ok: true,
          mode: "public",
          id: commentId
        });
      }
      const { messageId } = await sendInstagramPrivateReply(
        pageId as string,
        connection.pageToken,
        body.commentId,
        body.text
      );
      return successResponse<InstagramCommentReplyResult>({
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
        metaCode: meta.metaCode,
        metaSubcode: meta.metaSubcode,
        message: meta.message
      });
      const retryable =
        meta.code !== "request_failed" ||
        (meta.status ?? 0) >= 500 ||
        (meta.metaCode !== undefined && RETRYABLE_META_CODES.has(meta.metaCode));
      return successResponse<InstagramCommentReplyResult>({
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
