/**
 * Admin blog settings — the weekly-digest toggles and the Instagram
 * cross-post target/mode (single fixed blog_settings row).
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getBlogSettings, updateBlogSettings } from "@/lib/blog/db";

const putSchema = z.object({
  digest_enabled: z.boolean().optional(),
  digest_as_draft: z.boolean().optional(),
  digest_include_image: z.boolean().optional(),
  instagram_business_id: z.string().uuid().nullable().optional(),
  instagram_publish_immediately: z.boolean().optional()
});

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return successResponse({ settings: await getBlogSettings() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = putSchema.parse(await request.json());
    await updateBlogSettings(body);
    return successResponse({ settings: await getBlogSettings() });
  } catch (err) {
    return handleRouteError(err);
  }
}
