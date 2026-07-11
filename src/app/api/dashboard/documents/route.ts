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
  insertBusinessDocument,
  listBusinessDocuments,
  patchBusinessDocument
} from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET, documentLimitForTier } from "@/lib/documents/core";
import { ingestDocument, isSupportedDocumentMime } from "@/lib/documents/ingest";
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

    const mimeType = file.type.trim().toLowerCase();
    if (!isSupportedDocumentMime(mimeType)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only PDF, plain text, markdown, or CSV documents are supported"
      );
    }
    if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
      return errorResponse("VALIDATION_ERROR", "Documents must be between 1 byte and 10 MB");
    }

    const titleRaw = String(form.get("title") ?? "").trim();
    const title = (titleRaw || file.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 200);
    if (!title) return errorResponse("VALIDATION_ERROR", "title is required");
    const category = String(form.get("category") ?? "general").trim().slice(0, 100) || "general";
    const audience = audienceSchema.safeParse(form.get("audience") ?? "both");
    if (!audience.success) {
      return errorResponse("VALIDATION_ERROR", "audience must be clients, staff, or both");
    }
    const expiresRaw = String(form.get("expiresAt") ?? "").trim();
    let expiresAt: string | null = null;
    if (expiresRaw) {
      const ms = Date.parse(expiresRaw);
      if (!Number.isFinite(ms)) return errorResponse("VALIDATION_ERROR", "expiresAt is not a date");
      expiresAt = new Date(ms).toISOString();
    }

    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_settings");

    const business = await getBusiness(businessId.data);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
    const limit = documentLimitForTier(business.tier);
    const existing = await countBusinessDocuments(businessId.data);
    if (existing >= limit) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
      );
    }

    const db = await createSupabaseServiceClient();
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

    const row = await insertBusinessDocument({
      id: documentId,
      business_id: businessId.data,
      title,
      category,
      audience: audience.data,
      storage_path: storagePath,
      mime_type: mimeType,
      byte_size: file.size,
      expires_at: expiresAt
    });

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
