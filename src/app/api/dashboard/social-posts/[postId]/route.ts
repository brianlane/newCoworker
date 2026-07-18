/**
 * Instagram posts — single-post management.
 *
 *   PATCH  /api/dashboard/social-posts/:postId
 *            body: { businessId, caption?, mediaUrl?,
 *                    publishAt? | null, action?: "cancel" }
 *   DELETE /api/dashboard/social-posts/:postId?businessId=…
 *
 * Edits apply to draft/scheduled posts only (a publishing/published post is
 * history). Cancel is a guarded transition so it can never race the sweep's
 * promotion into clobbering a mid-publish post.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteSocialPost,
  getSocialPost,
  transitionSocialPost,
  SOCIAL_CAPTION_MAX_LENGTH,
  type SocialPostPatch
} from "@/lib/social/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  caption: z.string().trim().max(SOCIAL_CAPTION_MAX_LENGTH).optional(),
  mediaUrl: z.string().trim().url().max(2000).startsWith("https://").optional(),
  /** ISO datetime schedules; null moves a scheduled post back to draft. */
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  action: z.literal("cancel").optional()
});

type RouteContext = { params: Promise<{ postId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { postId } = await context.params;
    if (!z.string().uuid().safeParse(postId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid post id");
    }
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const existing = await getSocialPost(body.data.businessId, postId);
    if (!existing) return errorResponse("NOT_FOUND", "Post not found", 404);

    if (body.data.action === "cancel") {
      // Guarded: only a still-scheduled (or draft) post can cancel.
      const cancelled =
        (await transitionSocialPost(body.data.businessId, postId, "scheduled", {
          status: "cancelled"
        })) ||
        (await transitionSocialPost(body.data.businessId, postId, "draft", {
          status: "cancelled"
        }));
      if (!cancelled) {
        const current = await getSocialPost(body.data.businessId, postId);
        if (current?.status === "cancelled") {
          // Idempotent: someone (or a parallel tab) cancelled it first.
          return successResponse({ post: current });
        }
        const reason =
          current?.status === "published"
            ? "This post already published."
            : "This post already started publishing and can't be cancelled.";
        return errorResponse("VALIDATION_ERROR", reason, 409);
      }
      const updated = await getSocialPost(body.data.businessId, postId);
      return successResponse({ post: updated });
    }

    if (existing.status !== "draft" && existing.status !== "scheduled" && existing.status !== "failed") {
      return errorResponse("VALIDATION_ERROR", "Only draft, scheduled, or failed posts can be edited.");
    }

    const patch: SocialPostPatch = {};
    if (body.data.caption !== undefined) patch.caption = body.data.caption;
    if (body.data.mediaUrl !== undefined) patch.media_url = body.data.mediaUrl;
    if (body.data.publishAt !== undefined) {
      if (body.data.publishAt === null) {
        patch.publish_at = null;
        patch.status = "draft";
      } else {
        if (Date.parse(body.data.publishAt) < Date.now() - 60_000) {
          return errorResponse("VALIDATION_ERROR", "The publish time is in the past");
        }
        patch.publish_at = new Date(body.data.publishAt).toISOString();
        patch.status = "scheduled";
        // A re-scheduled failed post starts a clean attempt.
        patch.error_detail = null;
      }
    }
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }

    // Guarded on the status we validated against: if the sweep promoted the
    // post to `publishing` between our read and this write, the edit loses
    // cleanly instead of yanking a mid-publish post around.
    const applied = await transitionSocialPost(
      body.data.businessId,
      postId,
      existing.status,
      patch
    );
    if (!applied) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This post just started publishing and can't be edited.",
        409
      );
    }
    const updated = await getSocialPost(body.data.businessId, postId);
    return successResponse({ post: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { postId } = await context.params;
    if (!z.string().uuid().safeParse(postId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid post id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const existing = await getSocialPost(businessId.data, postId);
    if (!existing) return successResponse({ deleted: true }); // idempotent
    // The delete itself is status-guarded (`neq publishing`), so a sweep
    // promotion racing this read can never drop a mid-publish post.
    const deleted = await deleteSocialPost(businessId.data, postId);
    if (!deleted) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This post is mid-publish; deleting isn't possible right now.",
        409
      );
    }
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
