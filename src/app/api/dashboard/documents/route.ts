/**
 * Business Documents — dashboard management API.
 *
 *   GET  /api/dashboard/documents?businessId=…   → list documents
 *   POST /api/dashboard/documents (multipart)    → upload + ingest one document
 *
 * Upload flow: tier cap check → store the original in the private
 * `business-docs` bucket → insert a `processing` row → extract/condense via
 * Gemini (ingestDocument) → mark `ready` (or `failed` with detail) → re-sync
 * the VPS vault digest. Ingestion runs inline: a document upload is an
 * owner-attended action and the condense call is bounded at 60s.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import {
  countBusinessDocuments,
  deleteBusinessDocument,
  insertBusinessDocument,
  listBusinessDocuments,
  patchBusinessDocument
} from "@/lib/documents/db";
import {
  BUSINESS_DOCS_BUCKET,
  CONTACT_DOCUMENT_RECORDS_LIMIT,
  documentLimitForTier,
  parseExpirationInput
} from "@/lib/documents/core";
import { getTeamMember } from "@/lib/db/employees";
import { ingestDocument, isSupportedDocumentMime, normalizeUploadMime } from "@/lib/documents/ingest";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Upload + Gemini condense can take a while on big PDFs.
export const maxDuration = 120;

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const audienceSchema = z.enum(["clients", "staff", "both"]);

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const documents = await listBusinessDocuments(businessId.data);
    return successResponse({ documents });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const form = await request.formData().catch(() => null);
    if (!form) return errorResponse("VALIDATION_ERROR", "Expected multipart form data");

    const businessId = z.string().uuid().safeParse(form.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("VALIDATION_ERROR", "file is required");

    // normalizeUploadMime maps VTT transcripts (text/vtt, or a .vtt name
    // under a blank/octet-stream reported type) onto their canonical mime.
    const mimeType = normalizeUploadMime(file.type, file.name);
    if (!isSupportedDocumentMime(mimeType)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only PDF, Word (.docx), plain text, markdown, CSV, or VTT transcript documents are supported"
      );
    }
    if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
      return errorResponse("VALIDATION_ERROR", "Documents must be between 1 byte and 10 MB");
    }

    const titleRaw = String(form.get("title") ?? "").trim();
    const title = (titleRaw || file.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 200);
    if (!title) return errorResponse("VALIDATION_ERROR", "title is required");
    const category = String(form.get("category") ?? "general").trim().slice(0, 100) || "general";
    // Contact-linked records default to internal-only (matching the CSV
    // importer): a customer's policy/contract must never reach customer
    // channels unless the owner deliberately widens it. Library uploads
    // keep the historical "both" default.
    const audienceDefault = String(form.get("contactId") ?? "").trim() ? "staff" : "both";
    const audience = audienceSchema.safeParse(form.get("audience") ?? audienceDefault);
    if (!audience.success) {
      return errorResponse("VALIDATION_ERROR", "audience must be clients, staff, or both");
    }
    const expiresRaw = String(form.get("expiresAt") ?? "").trim();
    let expiresAt: string | null = null;
    if (expiresRaw) {
      // Date-only inputs mean "usable through that day" (end-of-day), not
      // the preceding UTC midnight — see parseExpirationInput.
      expiresAt = parseExpirationInput(expiresRaw);
      if (!expiresAt) return errorResponse("VALIDATION_ERROR", "expiresAt is not a date");
    }
    const renewalRaw = String(form.get("renewalDate") ?? "").trim();
    let renewalDate: string | null = null;
    if (renewalRaw) {
      // Same end-of-day semantics as expiresAt.
      renewalDate = parseExpirationInput(renewalRaw);
      if (!renewalDate) return errorResponse("VALIDATION_ERROR", "renewalDate is not a date");
    }
    const contactIdRaw = String(form.get("contactId") ?? "").trim();
    const contactId = contactIdRaw ? z.string().uuid().safeParse(contactIdRaw) : null;
    if (contactId && !contactId.success) {
      return errorResponse("VALIDATION_ERROR", "contactId must be a uuid");
    }
    const assignedRaw = String(form.get("assignedEmployeeId") ?? "").trim();
    const assignedEmployeeId = assignedRaw ? z.string().uuid().safeParse(assignedRaw) : null;
    if (assignedEmployeeId && !assignedEmployeeId.success) {
      return errorResponse("VALIDATION_ERROR", "assignedEmployeeId must be a uuid");
    }

    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const business = await getBusiness(businessId.data);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
    // Contact-linked records live under their own flat cap; unlinked
    // knowledge-library docs keep the per-tier cap.
    const capScope = contactId ? ("contact_records" as const) : ("library" as const);
    const limit = contactId
      ? CONTACT_DOCUMENT_RECORDS_LIMIT
      : documentLimitForTier(business.tier);
    const existing = await countBusinessDocuments(businessId.data, capScope);
    if (existing >= limit) {
      return errorResponse(
        "VALIDATION_ERROR",
        contactId
          ? `Contact document limit reached (${limit}).`
          : `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
      );
    }

    const db = await createSupabaseServiceClient();

    // Cross-tenant guards: a linked contact / assigned employee must belong
    // to this business.
    if (contactId) {
      const { data: contactRow, error: contactErr } = await db
        .from("contacts")
        .select("id")
        .eq("business_id", businessId.data)
        .eq("id", contactId.data)
        .maybeSingle();
      if (contactErr) {
        logger.warn("documents/upload: contact lookup failed", {
          businessId: businessId.data,
          error: contactErr.message
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Contact lookup failed");
      }
      if (!contactRow) return errorResponse("VALIDATION_ERROR", "Contact not found");
    }
    if (assignedEmployeeId) {
      const member = await getTeamMember(businessId.data, assignedEmployeeId.data);
      if (!member) return errorResponse("VALIDATION_ERROR", "Assigned employee not found");
    }
    const documentId = randomUUID();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
    const storagePath = `${businessId.data}/${documentId}/${safeName}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .upload(storagePath, bytes, { contentType: mimeType });
    if (uploadError) {
      logger.warn("documents/upload: storage upload failed", {
        businessId: businessId.data,
        error: uploadError.message
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Document upload failed");
    }

    // Best-effort compensation: an aborted upload must not leave an
    // orphaned object (no row pointing at it) in the bucket.
    const removeUploadedObject = async (): Promise<void> => {
      const { error: removeError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .remove([storagePath]);
      if (removeError) {
        logger.warn("documents/upload: orphan object cleanup failed", {
          businessId: businessId.data,
          storagePath,
          error: removeError.message
        });
      }
    };

    let row;
    try {
      row = await insertBusinessDocument({
        id: documentId,
        business_id: businessId.data,
        title,
        category,
        audience: audience.data,
        storage_path: storagePath,
        mime_type: mimeType,
        byte_size: file.size,
        expires_at: expiresAt,
        contact_id: contactId ? contactId.data : null,
        renewal_date: renewalDate,
        assigned_employee_id: assignedEmployeeId ? assignedEmployeeId.data : null
      });
    } catch (err) {
      await removeUploadedObject();
      throw err;
    }

    // Serial re-check closes the pre-insert cap race: concurrent uploads can
    // each pass the count above, so anyone who lands past the cap rolls
    // their own row back. Over-rollback on a photo-finish tie is acceptable
    // (both retry; the owner never ends up over their plan's limit).
    const afterInsert = await countBusinessDocuments(businessId.data, capScope);
    if (afterInsert > limit) {
      await deleteBusinessDocument(businessId.data, documentId);
      await removeUploadedObject();
      return errorResponse(
        "VALIDATION_ERROR",
        contactId
          ? `Contact document limit reached (${limit}).`
          : `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
      );
    }

    const ingested = await ingestDocument({
      businessId: businessId.data,
      title,
      mimeType,
      data: bytes,
      businessName: business.name
    });
    if (ingested.ok) {
      await patchBusinessDocument(businessId.data, documentId, {
        content_md: ingested.contentMd,
        summary: ingested.summary,
        status: "ready",
        error_detail: null
      });
      // Fire-and-forget: the Supabase write is canonical; a slow VPS must
      // not block the upload response.
      void syncVaultToVpsAndLog(businessId.data);
    } else {
      await patchBusinessDocument(businessId.data, documentId, {
        status: "failed",
        error_detail: ingested.detail ?? ingested.error
      });
    }

    return successResponse({
      document: {
        ...row,
        status: ingested.ok ? "ready" : "failed",
        error_detail: ingested.ok ? null : ingested.detail ?? ingested.error
      },
      ingest: ingested.ok ? { ok: true } : { ok: false, error: ingested.error }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
