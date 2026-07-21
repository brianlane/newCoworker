/**
 * Admin "Publish now": flips the post to published (guarded against a
 * concurrent sweep publishing it first) and runs the same fan-out the
 * scheduled path gets — subscriber email + Instagram cross-post.
 */

import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBlogPost, transitionBlogPost } from "@/lib/blog/db";
import { runBlogPublishSideEffects } from "@/lib/blog/publish";

type RouteContext = { params: Promise<{ postId: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireAdmin();
    const { postId } = await context.params;
    const post = await getBlogPost(postId);
    if (!post) return errorResponse("NOT_FOUND", "Post not found");
    if (post.status === "published") {
      return errorResponse("CONFLICT", "Post is already published");
    }

    const nowIso = new Date().toISOString();
    const claimed = await transitionBlogPost(postId, post.status, {
      status: "published",
      published_at: nowIso,
      scheduled_for: null
    });
    if (!claimed) {
      // The sweep (or another admin) got there first.
      return errorResponse("CONFLICT", "Post was just published elsewhere");
    }

    const fanOut = await runBlogPublishSideEffects({
      ...post,
      status: "published",
      published_at: nowIso
    });
    const updated = await getBlogPost(postId);
    return successResponse({ post: updated, fanOut });
  } catch (err) {
    return handleRouteError(err);
  }
}
