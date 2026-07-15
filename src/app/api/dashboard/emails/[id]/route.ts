/**
 * Single-email body + attachments endpoint.
 *
 * GET /api/dashboard/emails/:id?businessId=<uuid>
 *   → { body_preview, body_full, attachments: [{ filename, mime_type, size_bytes, url }] }
 *
 * The Emails list deliberately omits the full body + attachments (it loads up to
 * 200 rows and only needs the preview). The reading pane fetches them here when a
 * message is opened. Attachment storage paths never reach the client — they're
 * resolved to short-lived signed download URLs server-side. Scoped by businessId
 * + requireBusinessRole so one tenant can never read another's mail; admins bypass.
 *
 * DELETE /api/dashboard/emails/:id?businessId=<uuid> → { ok: true }
 *   Removes the email from the owner's view. Soft delete under the hood
 *   (admin-restorable via /api/admin/deleted-items) but behaves like a hard
 *   delete here: idempotent, and the row never surfaces again.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getEmailBody, softDeleteEmailLogEntry } from "@/lib/db/email-log";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Default bucket for inbound attachments. Each stored attachment may name its
// own bucket (outbound flow screenshots live in `aiflow-screenshots`); rows
// without one predate that and fall back here.
const DEFAULT_ATTACHMENTS_BUCKET = "email-attachments";
// Signed-URL lifetime: long enough for the owner to click download, short
// enough that a leaked URL expires quickly.
const SIGNED_URL_TTL_S = 300;

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({ businessId: z.string().uuid() });

const DELETE_RATE = { interval: 60 * 1000, maxRequests: 30 };

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    const body = await getEmailBody(businessId, id, db);
    if (!body) return errorResponse("NOT_FOUND", "Email not found");

    const attachments = await Promise.all(
      body.attachments.map(async (a) => {
        const { data } = await db.storage
          .from(a.bucket ?? DEFAULT_ATTACHMENTS_BUCKET)
          .createSignedUrl(a.storage_path, SIGNED_URL_TTL_S, { download: a.filename });
        return {
          filename: a.filename,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
          url: data?.signedUrl ?? null
        };
      })
    );

    return successResponse({
      body_preview: body.body_preview,
      body_full: body.body_full,
      body_html: body.body_html,
      attachments
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`email-delete:${businessId}`, DELETE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Delete-if-exists semantics: ok even when the row is already gone so
    // flaky-network retries never surface an error for a completed delete.
    await softDeleteEmailLogEntry(businessId, id, user.userId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
