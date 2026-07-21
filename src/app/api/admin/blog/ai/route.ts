/**
 * Admin blog AI assist: draft from a topic, translate to Spanish, or
 * generate a featured image. Long-running Gemini calls — nodejs runtime
 * with an extended budget.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  draftBlogPostWithAi,
  generateBlogImageWithAi,
  translateBlogPostWithAi
} from "@/lib/blog/ai";
import { blogImagePublicUrl } from "@/lib/blog/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const maxDuration = 120;
export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), topic: z.string().trim().min(3).max(4000) }),
  z.object({
    action: z.literal("translate"),
    title: z.string().min(1).max(200),
    excerpt: z.string().max(2200),
    content: z.string().min(1).max(200_000)
  }),
  z.object({
    action: z.literal("image"),
    title: z.string().min(1).max(200),
    excerpt: z.string().max(2200)
  })
]);

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    if (!(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY)) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Gemini API key is not configured", 500);
    }
    const body = bodySchema.parse(await request.json());

    if (body.action === "draft") {
      return successResponse({ draft: await draftBlogPostWithAi(body.topic) });
    }
    if (body.action === "translate") {
      return successResponse({
        translation: await translateBlogPostWithAi({
          title: body.title,
          excerpt: body.excerpt,
          content: body.content
        })
      });
    }
    const db = await createSupabaseServiceClient();
    const path = await generateBlogImageWithAi(
      { title: body.title, excerpt: body.excerpt },
      db
    );
    return successResponse({ path, url: blogImagePublicUrl(path) });
  } catch (err) {
    return handleRouteError(err);
  }
}
