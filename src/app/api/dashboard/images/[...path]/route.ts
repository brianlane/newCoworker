/**
 * Owner-authenticated proxy for coworker-generated images.
 *
 * GET /api/dashboard/images/<businessId>/<file>
 *
 * Generated images live in the private `generated-images` bucket
 * (service-role only, no storage RLS policies). Dashboard chat embeds them
 * with this STABLE URL instead of a signed URL, because chat threads are
 * long-lived history — a 7-day signed URL would rot in a saved thread. The
 * route authenticates the session against the businessId path prefix (same
 * "operate_messages" gate as the chat routes that display the image) and
 * streams the object bytes.
 *
 * DELETE /api/dashboard/images/<businessId>/<file> → { ok: true }
 *
 * Removes the stored object for real — Storage objects can't carry the
 * soft-delete stamp the row-backed items use, so this is the one HARD
 * delete among the owner delete actions (documented exception). Same
 * business-scoped path validation and role gate as the GET; idempotent
 * (deleting a missing object is still ok).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { GENERATED_IMAGES_BUCKET } from "@/lib/image-tools/handlers";

export const dynamic = "force-dynamic";

const DELETE_RATE = { interval: 60 * 1000, maxRequests: 30 };

// <businessId>/<uuid>.<ext> — the only shape the generator writes. Anything
// else (traversal attempts, nested paths) is rejected before touching storage.
const paramsSchema = z.object({
  path: z.tuple([
    z.string().uuid(),
    z.string().regex(/^[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i, "invalid image name")
  ])
});

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const parsed = paramsSchema.safeParse(await ctx.params);
    if (!parsed.success) return errorResponse("NOT_FOUND", "Image not found");
    const [businessId, fileName] = parsed.data.path;

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    const { data, error } = await db.storage
      .from(GENERATED_IMAGES_BUCKET)
      .download(`${businessId}/${fileName}`);
    if (error || !data) return errorResponse("NOT_FOUND", "Image not found");

    const bytes = await data.arrayBuffer();
    return new NextResponse(bytes, {
      headers: {
        "content-type": data.type || "image/png",
        // Objects are immutable (uuid-named, written once) — cache hard.
        "cache-control": "private, max-age=31536000, immutable"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const parsed = paramsSchema.safeParse(await ctx.params);
    if (!parsed.success) return errorResponse("NOT_FOUND", "Image not found");
    const [businessId, fileName] = parsed.data.path;

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`image-delete:${businessId}`, DELETE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Storage remove() succeeds (with an empty list) for missing objects, so
    // retries stay idempotent; only a real storage error surfaces.
    const db = await createSupabaseServiceClient();
    const { error } = await db.storage
      .from(GENERATED_IMAGES_BUCKET)
      .remove([`${businessId}/${fileName}`]);
    if (error) return errorResponse("INTERNAL_SERVER_ERROR", "Couldn't delete the image");

    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
