/**
 * Admin blog CRUD — list + create. Admin-only (requireAdmin), matching the
 * other /api/admin/* consoles.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  BLOG_CATEGORIES,
  blogSlugExists,
  insertBlogPost,
  listPostsAdmin
} from "@/lib/blog/db";
// House rule: no em dashes in blog copy, ever — normalized on save too.
import { sanitizeBlogCopyFields } from "@/lib/blog/copy";
import { slugifyBlogTitle, uniqueBlogSlug } from "@/lib/blog/slug";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(120).optional(),
  excerpt: z.string().max(2200).optional(),
  content: z.string().max(200_000).optional(),
  title_es: z.string().max(200).nullable().optional(),
  excerpt_es: z.string().max(2200).nullable().optional(),
  content_es: z.string().max(200_000).nullable().optional(),
  category: z.enum(BLOG_CATEGORIES).optional(),
  author_name: z.string().trim().min(1).max(120).optional(),
  featured_image_path: z.string().max(300).nullable().optional(),
  featured_image_alt: z.string().max(300).nullable().optional()
});

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return successResponse({ posts: await listPostsAdmin() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = sanitizeBlogCopyFields(createSchema.parse(await request.json()));

    const requestedSlug = body.slug ? slugifyBlogTitle(body.slug) : "";
    const slug = requestedSlug
      ? requestedSlug
      : await uniqueBlogSlug(body.title, (candidate) => blogSlugExists(candidate));
    if (requestedSlug && (await blogSlugExists(requestedSlug))) {
      return errorResponse("CONFLICT", "A post with that slug already exists");
    }

    const post = await insertBlogPost({ ...body, slug, status: "draft" });
    return successResponse({ post }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
