/**
 * Business Documents — access the original uploaded file.
 *
 *   GET /api/dashboard/documents/:documentId/download?businessId=…
 *     → { url } — a short-lived signed URL on the private `business-docs`
 *       bucket with a Content-Disposition download filename (same pattern
 *       as the email-attachments route). Read-only, so view-as is allowed.
 *
 *   `?disposition=inline` signs WITHOUT the download filename so the
 *   browser renders the file in place (PDF viewer, plain text for
 *   .vtt/.md/.csv) — the "Open in browser" action.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessDocument } from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Long enough to click and save; short enough not to be a durable link. */
const SIGNED_URL_TTL_S = 300;

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const doc = await getBusinessDocument(businessId.data, documentId);
    if (!doc) return errorResponse("NOT_FOUND", "Document not found", 404);

    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    const filename = doc.storage_path.split("/").pop() || "document";
    const db = await createSupabaseServiceClient();
    const { data, error } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .createSignedUrl(
        doc.storage_path,
        SIGNED_URL_TTL_S,
        inline ? undefined : { download: filename }
      );
    if (error || !data?.signedUrl) {
      logger.warn("documents/download: signed url failed", {
        businessId: businessId.data,
        documentId,
        error: error?.message
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Could not create the download link");
    }

    return successResponse({ url: data.signedUrl });
  } catch (err) {
    return handleRouteError(err);
  }
}
