/**
 * Business Documents — single-document management.
 *
 *   PATCH  /api/dashboard/documents/:documentId  → edit metadata / content
 *   DELETE /api/dashboard/documents/:documentId  → remove doc + stored file
 *
 * Changing `expiresAt` re-arms the expiration sweep's one-reminder-per-state
 * stamps; any grounding-relevant change re-syncs the VPS vault digest.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  deleteBusinessDocument,
  getBusinessDocument,
  patchBusinessDocument,
  type BusinessDocumentPatch
} from "@/lib/documents/db";
import {
  BUSINESS_DOCS_BUCKET,
  DOCUMENT_CONTENT_MD_MAX_CHARS,
  DOCUMENT_SUMMARY_MAX_CHARS
} from "@/lib/documents/core";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  audience: z.enum(["clients", "staff", "both"]).optional(),
  /** ISO date/datetime; null clears (never expires). */
  expiresAt: z.string().max(64).nullable().optional(),
  contentMd: z.string().max(DOCUMENT_CONTENT_MD_MAX_CHARS).optional(),
  summary: z.string().max(DOCUMENT_SUMMARY_MAX_CHARS).optional()
});

type RouteContext = { params: Promise<{ documentId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const existing = await getBusinessDocument(body.data.businessId, documentId);
    if (!existing) return errorResponse("NOT_FOUND", "Document not found", 404);

    const patch: BusinessDocumentPatch = {};
    if (body.data.title !== undefined) patch.title = body.data.title.trim();
    if (body.data.category !== undefined) patch.category = body.data.category.trim();
    if (body.data.audience !== undefined) patch.audience = body.data.audience;
    if (body.data.summary !== undefined) patch.summary = body.data.summary.trim();
    if (body.data.contentMd !== undefined) {
      patch.content_md = body.data.contentMd;
      // A manual content edit makes a previously failed ingest usable.
      if (body.data.contentMd.trim()) patch.status = "ready";
    }
    if (body.data.expiresAt !== undefined) {
      if (body.data.expiresAt === null || body.data.expiresAt.trim() === "") {
        patch.expires_at = null;
      } else {
        const ms = Date.parse(body.data.expiresAt);
        if (!Number.isFinite(ms)) {
          return errorResponse("VALIDATION_ERROR", "expiresAt is not a date");
        }
        patch.expires_at = new Date(ms).toISOString();
      }
      // Changing the date re-arms the sweep's reminders.
      patch.expiring_soon_notified_at = null;
      patch.expired_notified_at = null;
    }
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }

    await patchBusinessDocument(body.data.businessId, documentId, patch);
    void syncVaultToVpsAndLog(body.data.businessId);
    const updated = await getBusinessDocument(body.data.businessId, documentId);
    return successResponse({ document: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const existing = await getBusinessDocument(businessId.data, documentId);
    if (!existing) return errorResponse("NOT_FOUND", "Document not found", 404);

    // Row first (cascades shares), then the stored original — a leftover
    // object with no row is invisible garbage, the reverse would be a live
    // row pointing at nothing.
    await deleteBusinessDocument(businessId.data, documentId);
    const db = await createSupabaseServiceClient();
    const { error: removeError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .remove([existing.storage_path]);
    if (removeError) {
      logger.warn("documents/delete: storage remove failed", {
        businessId: businessId.data,
        documentId,
        error: removeError.message
      });
    }
    void syncVaultToVpsAndLog(businessId.data);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
