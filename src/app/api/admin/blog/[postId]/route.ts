/**
 * Admin blog CRUD — read / update / delete one post.
 *
 * PATCH handles field edits AND lifecycle moves short of "publish now"
 * (which is its own route so the fan-out side effects stay explicit):
 * save draft, schedule for a time, or pull a post back to draft.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  BLOG_CATEGORIES,
  blogSlugExists,
  deleteBlogPost,
  getBlogPost,
  patchBlogPost
} from "@/lib/blog/db";
import { slugifyBlogTitle } from "@/lib/blog/slug";

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  excerpt: z.string().max(2200).optional(),
  content: z.string().max(200_000).optional(),
  title_es: z.string().max(200).nullable().optional(),
  excerpt_es: z.string().max(2200).nullable().optional(),
  content_es: z.string().max(200_000).nullable().optional(),
  category: z.enum(BLOG_CATEGORIES).optional(),
  author_name: z.string().trim().min(1).max(120).optional(),
  featured_image_path: z.string().max(300).nullable().optional(),
  featured_image_alt: z.string().max(300).nullable().optional(),
  status: z.enum(["draft", "scheduled"]).optional(),
  scheduled_for: z.string().datetime({ offset: true }).nullable().optional()
});

type RouteContext = { params: Promise<{ postId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireAdmin();
    const { postId } = await context.params;
    const post = await getBlogPost(postId);
    if (!post) return errorResponse("NOT_FOUND", "Post not found");
    return successResponse({ post });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireAdmin();
    const { postId } = await context.params;
    const body = patchSchema.parse(await request.json());

    const post = await getBlogPost(postId);
    if (!post) return errorResponse("NOT_FOUND", "Post not found");

    if (body.slug !== undefined) {
      const normalized = slugifyBlogTitle(body.slug);
      if (!normalized) return errorResponse("VALIDATION_ERROR", "Slug cannot be empty");
      if (normalized !== post.slug && (await blogSlugExists(normalized))) {
        return errorResponse("CONFLICT", "A post with that slug already exists");
      }
      body.slug = normalized;
    }

    // Scheduling requires a time; un-scheduling clears it.
    if (body.status === "scheduled" && !body.scheduled_for && !post.scheduled_for) {
      return errorResponse("VALIDATION_ERROR", "A scheduled post needs a publish time");
    }
    if (body.status === "draft") {
      body.scheduled_for = null;
    }

    await patchBlogPost(postId, body);
    const updated = await getBlogPost(postId);
    return successResponse({ post: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireAdmin();
    const { postId } = await context.params;
    await deleteBlogPost(postId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
