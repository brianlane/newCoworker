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
  countBusinessDocuments,
  deleteBusinessDocument,
  getBusinessDocument,
  listDocumentSignatureRequests,
  patchBusinessDocument,
  voidAllSignatureRequestsForDocument,
  type BusinessDocumentPatch
} from "@/lib/documents/db";
import {
  BUSINESS_DOCS_BUCKET,
  CONTACT_DOCUMENT_RECORDS_LIMIT,
  DOCUMENT_CONTENT_MD_MAX_CHARS,
  DOCUMENT_SUMMARY_MAX_CHARS,
  documentLimitForTier,
  parseExpirationInput
} from "@/lib/documents/core";
import { getBusiness } from "@/lib/db/businesses";
import { getTeamMember } from "@/lib/db/employees";
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
  /** ISO date/datetime; null clears (no renewal tracking). */
  renewalDate: z.string().max(64).nullable().optional(),
  /** Contact the document belongs to; null unlinks. */
  contactId: z.string().uuid().nullable().optional(),
  /** Roster member handling the renewal; null unassigns. */
  assignedEmployeeId: z.string().uuid().nullable().optional(),
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
      // A manual content edit makes a previously failed ingest usable —
      // and clears its stale failure text.
      if (body.data.contentMd.trim()) {
        patch.status = "ready";
        patch.error_detail = null;
      }
    }
    if (body.data.expiresAt !== undefined) {
      let nextExpires: string | null;
      if (body.data.expiresAt === null || body.data.expiresAt.trim() === "") {
        nextExpires = null;
      } else {
        // Date-only inputs mean "usable through that day" (end-of-day).
        nextExpires = parseExpirationInput(body.data.expiresAt);
        if (!nextExpires) {
          return errorResponse("VALIDATION_ERROR", "expiresAt is not a date");
        }
      }
      // Only a CHANGED date re-arms the sweep's reminders — re-submitting
      // the same date (the UI sends the field on every save) must not
      // trigger duplicate notifications.
      if (nextExpires !== existing.expires_at) {
        patch.expires_at = nextExpires;
        patch.expiring_soon_notified_at = null;
        patch.expired_notified_at = null;
      }
    }
    if (body.data.renewalDate !== undefined) {
      let nextRenewal: string | null;
      if (body.data.renewalDate === null || body.data.renewalDate.trim() === "") {
        nextRenewal = null;
      } else {
        // Same end-of-day semantics as expiresAt.
        nextRenewal = parseExpirationInput(body.data.renewalDate);
        if (!nextRenewal) {
          return errorResponse("VALIDATION_ERROR", "renewalDate is not a date");
        }
      }
      // Same changed-only rule: an unchanged renewal date keeps its stamp.
      if (nextRenewal !== existing.renewal_date) {
        patch.renewal_date = nextRenewal;
        patch.renewal_due_notified_at = null;
      }
    }
    if (body.data.contactId !== undefined) {
      // Linking/unlinking moves the document BETWEEN cap pools (per-tier
      // knowledge-library cap vs the flat contact-records cap), so the
      // destination pool is checked exactly like POST upload / CSV import —
      // otherwise PATCH would be a cap bypass.
      const movingToLinked = body.data.contactId !== null && existing.contact_id === null;
      const movingToUnlinked = body.data.contactId === null && existing.contact_id !== null;
      if (movingToLinked) {
        const linkedCount = await countBusinessDocuments(body.data.businessId, "contact_records");
        if (linkedCount >= CONTACT_DOCUMENT_RECORDS_LIMIT) {
          return errorResponse(
            "VALIDATION_ERROR",
            `Contact document limit reached (${CONTACT_DOCUMENT_RECORDS_LIMIT}).`
          );
        }
      } else if (movingToUnlinked) {
        const business = await getBusiness(body.data.businessId);
        if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
        const limit = documentLimitForTier(business.tier);
        const libraryCount = await countBusinessDocuments(body.data.businessId, "library");
        if (libraryCount >= limit) {
          return errorResponse(
            "VALIDATION_ERROR",
            `Document limit reached for your plan (${limit}). Unlinking would exceed it — delete a library document first.`
          );
        }
      }
      if (body.data.contactId === null) {
        patch.contact_id = null;
      } else {
        const db = await createSupabaseServiceClient();
        const { data: contactRow, error: contactErr } = await db
          .from("contacts")
          .select("id")
          .eq("business_id", body.data.businessId)
          .eq("id", body.data.contactId)
          .maybeSingle();
        if (contactErr) {
          logger.warn("documents/patch: contact lookup failed", {
            businessId: body.data.businessId,
            error: contactErr.message
          });
          return errorResponse("INTERNAL_SERVER_ERROR", "Contact lookup failed");
        }
        if (!contactRow) return errorResponse("VALIDATION_ERROR", "Contact not found");
        patch.contact_id = body.data.contactId;
      }
    }
    if (body.data.assignedEmployeeId !== undefined) {
      if (body.data.assignedEmployeeId === null) {
        patch.assigned_employee_id = null;
      } else {
        const member = await getTeamMember(body.data.businessId, body.data.assignedEmployeeId);
        if (!member) return errorResponse("VALIDATION_ERROR", "Assigned employee not found");
        patch.assigned_employee_id = body.data.assignedEmployeeId;
      }
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

    // Signed signature requests are retained legal evidence: deleting the
    // document would cascade them away. Refuse instead — the owner keeps
    // the audit trail (and the document its certificate references).
    //
    // Race-safe ordering: FIRST void every still-signable request (the
    // signing write is conditional on status sent/viewed, so after this
    // sweep no concurrent signer can complete), THEN re-check for signed
    // rows. A signature that landed before the void survives the void
    // untouched and is caught by the re-check — so a signed row can never
    // slip through into the cascade.
    const signedBefore = (await listDocumentSignatureRequests(businessId.data, documentId)).some(
      (r) => r.status === "signed"
    );
    if (!signedBefore) {
      await voidAllSignatureRequestsForDocument(businessId.data, documentId);
    }
    const signatureRequests = await listDocumentSignatureRequests(businessId.data, documentId);
    if (signatureRequests.some((r) => r.status === "signed")) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This document has completed signatures and can't be deleted — the signed record is retained as evidence. Set an expiration date instead to retire it.",
        409
      );
    }

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
