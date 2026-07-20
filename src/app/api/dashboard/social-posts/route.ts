/**
 * Instagram posts — dashboard management API.
 *
 *   GET  /api/dashboard/social-posts?businessId=…   → list posts
 *   POST /api/dashboard/social-posts                → create (draft or scheduled)
 *
 * A post is a caption + an image, published by the per-minute sweep once
 * its publish time passes. The image is either an UPLOAD (stored in the
 * private generated-images bucket as `/api/dashboard/images/<biz>/<file>`;
 * the sweep signs it for Meta at publish time) or a public https URL that
 * Meta downloads directly. Everything stays owner-reviewed: nothing
 * publishes without an explicit schedule (or an explicit "publish now").
 * Same auth bar as email campaigns (manage_settings).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeImageRef } from "@/lib/image-tools/handlers";
import {
  insertSocialPost,
  listSocialPosts,
  SOCIAL_CAPTION_MAX_LENGTH
} from "@/lib/social/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const createSchema = z
  .object({
    businessId: z.string().uuid(),
    caption: z.string().trim().max(SOCIAL_CAPTION_MAX_LENGTH).optional(),
    /**
     * Either an uploaded image (`/api/dashboard/images/<biz>/<file>`, tenant
     * checked below) or a public https URL Meta downloads server-side.
     */
    mediaUrl: z.string().trim().min(1).max(2000),
    /** ISO datetime; present = scheduled, absent = draft. */
    publishAt: z.string().datetime({ offset: true }).optional(),
    /** Schedule for the next sweep beat (~1 min). Excludes publishAt. */
    publishNow: z.boolean().optional()
  })
  .refine((body) => !(body.publishAt && body.publishNow), {
    message: "Send publishAt or publishNow, not both"
  });

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const posts = await listSocialPosts(businessId.data);
    return successResponse({ posts });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const body = createSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`social-posts-write:${body.data.businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    // The image is an uploaded ref (rebuilt via normalizeImageRef so it can
    // only ever point inside THIS tenant's prefix) or a plain https URL.
    const uploadedRef = normalizeImageRef(body.data.businessId, body.data.mediaUrl);
    const isHttpsUrl =
      !uploadedRef && z.string().url().startsWith("https://").safeParse(body.data.mediaUrl).success;
    if (!uploadedRef && !isHttpsUrl) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Upload an image or paste a public https image link"
      );
    }
    const mediaUrl = uploadedRef ? `/api/dashboard/images/${uploadedRef}` : body.data.mediaUrl;

    if (body.data.publishAt && Date.parse(body.data.publishAt) < Date.now() - 60_000) {
      return errorResponse(
        "VALIDATION_ERROR",
        'That time is in the past — pick a future time, or use "Publish now"'
      );
    }

    const publishAtIso = body.data.publishNow
      ? new Date().toISOString()
      : body.data.publishAt
        ? new Date(body.data.publishAt).toISOString()
        : null;

    const post = await insertSocialPost({
      business_id: body.data.businessId,
      caption: body.data.caption ?? "",
      media_url: mediaUrl,
      ...(publishAtIso ? { status: "scheduled" as const, publish_at: publishAtIso } : {})
    });
    return successResponse({ post });
  } catch (err) {
    return handleRouteError(err);
  }
}
