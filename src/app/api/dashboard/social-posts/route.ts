/**
 * Instagram posts — dashboard management API.
 *
 *   GET  /api/dashboard/social-posts?businessId=…   → list posts
 *   POST /api/dashboard/social-posts                → create (draft or scheduled)
 *
 * A post is a caption + a publicly fetchable image URL, published by the
 * per-minute sweep once its publish time passes. Everything stays
 * owner-reviewed: nothing publishes without an explicit schedule. Same
 * auth bar as email campaigns (manage_settings).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  insertSocialPost,
  listSocialPosts,
  SOCIAL_CAPTION_MAX_LENGTH
} from "@/lib/social/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const createSchema = z.object({
  businessId: z.string().uuid(),
  caption: z.string().trim().max(SOCIAL_CAPTION_MAX_LENGTH).optional(),
  /** Meta downloads the image server-side — must be a public https URL. */
  mediaUrl: z.string().trim().url().max(2000).startsWith("https://"),
  /** ISO datetime; present = scheduled, absent = draft. */
  publishAt: z.string().datetime({ offset: true }).optional()
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

    if (body.data.publishAt && Date.parse(body.data.publishAt) < Date.now() - 60_000) {
      return errorResponse("VALIDATION_ERROR", "The publish time is in the past");
    }

    const post = await insertSocialPost({
      business_id: body.data.businessId,
      caption: body.data.caption ?? "",
      media_url: body.data.mediaUrl,
      ...(body.data.publishAt
        ? { status: "scheduled" as const, publish_at: new Date(body.data.publishAt).toISOString() }
        : {})
    });
    return successResponse({ post });
  } catch (err) {
    return handleRouteError(err);
  }
}
