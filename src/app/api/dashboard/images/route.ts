/**
 * Dashboard image upload: POST /api/dashboard/images (multipart form).
 *
 * Lets the owner attach a photo in dashboard chat so the coworker can EDIT it
 * (dashboard_generate_image inputImageUrl). The file is stored in the same
 * private generated-images bucket — and under the same
 * `<businessId>/<uuid>.<ext>` shape — that generated images use, so the
 * existing owner-authenticated GET proxy ([...path]/route.ts) serves it and
 * the image tools' business-scoped ref validation accepts it with no extra
 * machinery.
 *
 * Form fields: `businessId` (uuid), `file` (image/png|jpeg|webp, ≤ 10 MB).
 * Auth mirrors the chat routes that display the result ("operate_messages").
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { GENERATED_IMAGES_BUCKET, MAX_INPUT_IMAGE_BYTES } from "@/lib/image-tools/handlers";

export const dynamic = "force-dynamic";

const UPLOAD_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Keep admin impersonation read-only: an uploaded object is a write to
    // the tenant's storage.
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const form = await request.formData().catch(() => null);
    if (!form) return errorResponse("VALIDATION_ERROR", "Expected multipart form data");

    const businessId = z.string().uuid().safeParse(form.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("VALIDATION_ERROR", "file is required");

    const mimeType = file.type.trim().toLowerCase();
    const ext = UPLOAD_EXT_BY_MIME[mimeType];
    if (!ext) {
      return errorResponse("VALIDATION_ERROR", "Only PNG, JPEG, or WebP images can be attached");
    }
    if (file.size === 0 || file.size > MAX_INPUT_IMAGE_BYTES) {
      return errorResponse("VALIDATION_ERROR", "Images must be between 1 byte and 10 MB");
    }

    if (!user.isAdmin) await requireBusinessRole(businessId.data, "operate_messages");

    const db = await createSupabaseServiceClient();
    const path = `${businessId.data}/${randomUUID()}.${ext}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    const { error } = await db.storage
      .from(GENERATED_IMAGES_BUCKET)
      .upload(path, bytes, { contentType: mimeType });
    if (error) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Image upload failed");
    }

    return successResponse({ imageUrl: `/api/dashboard/images/${path}` });
  } catch (err) {
    return handleRouteError(err);
  }
}
