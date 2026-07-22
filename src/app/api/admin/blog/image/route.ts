/**
 * Admin featured-image upload: multipart form (`file`) into the public
 * blog-images bucket. Returns the storage path + public URL.
 */

import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { BLOG_IMAGES_BUCKET, blogImagePublicUrl } from "@/lib/blog/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return errorResponse("VALIDATION_ERROR", "Attach an image as the 'file' field");
    }
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return errorResponse("VALIDATION_ERROR", "Only PNG, JPEG, or WebP images are allowed");
    }
    if (file.size > MAX_BYTES) {
      return errorResponse("VALIDATION_ERROR", "Image must be 10 MB or smaller");
    }

    const path = `${crypto.randomUUID()}.${ext}`;
    const db = await createSupabaseServiceClient();
    const bytes = Buffer.from(await file.arrayBuffer());
    const { error } = await db.storage
      .from(BLOG_IMAGES_BUCKET)
      .upload(path, bytes, { contentType: file.type });
    if (error) {
      return errorResponse("INTERNAL_SERVER_ERROR", `Upload failed: ${error.message}`, 500);
    }
    return successResponse({ path, url: blogImagePublicUrl(path) });
  } catch (err) {
    return handleRouteError(err);
  }
}
