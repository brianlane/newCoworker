/**
 * Agents — run execution.
 *
 *   POST /api/dashboard/agents/:agentId/run
 *     multipart: businessId + file            → run against a fresh upload
 *     JSON:      { businessId, documentId }   → run against an existing document
 *
 * One run = one Gemini transformation (executeAgentRun), executed INLINE —
 * a run is an owner-attended action and the model call is bounded at 90s,
 * same posture as document ingestion. Fresh uploads are stored in the
 * private business-docs bucket (`<businessId>/agent-inputs/<runId>/…`) so
 * run history keeps its input; document runs read the stored original for
 * full fidelity (not the condensed content_md). Runs are staff-allowed
 * (`operate_messages`) — using an agent is operating, not authoring.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessAgent, insertAgentRun, patchAgentRun } from "@/lib/agents/db";
import { executeAgentRun } from "@/lib/agents/run";
import { getBusinessDocument } from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { isSupportedDocumentMime, normalizeUploadMime } from "@/lib/documents/ingest";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Upload + Gemini transformation can take a while on big PDFs.
export const maxDuration = 120;

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const RUN_ERROR_MESSAGES: Record<string, string> = {
  unsupported_type: "Only PDF, plain text, markdown, or CSV attachments are supported",
  empty_content: "The attachment has no readable content",
  model_unavailable: "The AI service is not configured — try again later",
  model_failed: "The AI call failed — try again"
};

type RouteContext = { params: Promise<{ agentId: string }> };

type RunInputSource = {
  filename: string;
  mimeType: string;
  data: Buffer;
  documentId: string | null;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { agentId } = await context.params;
    if (!z.string().uuid().safeParse(agentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid agent id");
    }

    const db = await createSupabaseServiceClient();
    const contentType = request.headers.get("content-type") ?? "";
    let businessId: string;
    let upload: { filename: string; mimeType: string; data: Buffer } | null = null;
    let documentId: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (!form) return errorResponse("VALIDATION_ERROR", "Expected multipart form data");
      const parsedBusiness = z.string().uuid().safeParse(form.get("businessId"));
      if (!parsedBusiness.success) {
        return errorResponse("VALIDATION_ERROR", "businessId is required");
      }
      businessId = parsedBusiness.data;
      const file = form.get("file");
      if (!(file instanceof File)) return errorResponse("VALIDATION_ERROR", "file is required");
      // normalizeUploadMime maps VTT transcripts (text/vtt, or a .vtt name
      // under a blank/octet-stream reported type) onto their canonical mime.
      const mimeType = normalizeUploadMime(file.type, file.name);
      if (!isSupportedDocumentMime(mimeType)) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Only PDF, plain text, markdown, CSV, or VTT transcript attachments are supported"
        );
      }
      if (file.size === 0 || file.size > MAX_INPUT_BYTES) {
        return errorResponse("VALIDATION_ERROR", "Attachments must be between 1 byte and 10 MB");
      }
      upload = {
        filename: file.name.slice(0, 200) || "attachment",
        mimeType,
        data: Buffer.from(await file.arrayBuffer())
      };
    } else {
      const bodySchema = z.object({
        businessId: z.string().uuid(),
        documentId: z.string().uuid()
      });
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
      }
      businessId = body.data.businessId;
      documentId = body.data.documentId;
    }

    // Role gate BEFORE any tenant-data read (document lookup/download).
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    let input: RunInputSource;
    if (upload) {
      input = { ...upload, documentId: null };
    } else {
      const document = await getBusinessDocument(businessId, documentId!);
      if (!document) return errorResponse("NOT_FOUND", "Document not found", 404);
      // Mirror the dashboard picker's constraints server-side: only ingested
      // (ready) documents with a supported original format are runnable.
      if (document.status !== "ready") {
        return errorResponse("VALIDATION_ERROR", "That document isn't ready to use yet");
      }
      if (!isSupportedDocumentMime(document.mime_type.trim().toLowerCase())) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Only PDF, plain text, markdown, or CSV documents are supported"
        );
      }
      const { data: blob, error: downloadError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .download(document.storage_path);
      if (downloadError || !blob) {
        logger.warn("agents/run: document download failed", {
          businessId,
          documentId: document.id,
          error: downloadError?.message ?? "no data"
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not read the document file");
      }
      input = {
        filename: document.storage_path.split("/").pop() ?? document.title,
        mimeType: document.mime_type,
        data: Buffer.from(await blob.arrayBuffer()),
        documentId: document.id
      };
    }

    const agent = await getBusinessAgent(businessId, agentId);
    if (!agent) return errorResponse("NOT_FOUND", "Agent not found", 404);
    if (!agent.enabled) {
      return errorResponse("VALIDATION_ERROR", "This agent is disabled — enable it to run");
    }

    const runId = randomUUID();
    let inputStoragePath: string | null = null;
    if (!input.documentId) {
      const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "input";
      inputStoragePath = `${businessId}/agent-inputs/${runId}/${safeName}`;
      const { error: uploadError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .upload(inputStoragePath, input.data, { contentType: input.mimeType });
      if (uploadError) {
        // Input archival is best-effort — the run itself matters more than
        // keeping a re-viewable copy of its input.
        logger.warn("agents/run: input upload failed; running without archive", {
          businessId,
          error: uploadError.message
        });
        inputStoragePath = null;
      }
    }

    // Best-effort compensation: an aborted run must not leave an orphaned
    // archived input (no row pointing at it) in the bucket.
    const removeArchivedInput = async (): Promise<void> => {
      if (!inputStoragePath) return;
      const { error: removeError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .remove([inputStoragePath]);
      if (removeError) {
        logger.warn("agents/run: orphan input cleanup failed", {
          businessId,
          inputStoragePath,
          error: removeError.message
        });
      }
    };

    let run;
    try {
      run = await insertAgentRun({
        id: runId,
        agent_id: agent.id,
        business_id: businessId,
        source: "manual",
        input_document_id: input.documentId,
        input_filename: input.filename,
        input_mime_type: input.mimeType,
        input_storage_path: inputStoragePath
      });
    } catch (err) {
      await removeArchivedInput();
      throw err;
    }

    // executeAgentRun never throws for expected failures — it returns
    // { ok: false } and the terminal patch below records it. The try/catch
    // layering exists for UNEXPECTED throws (executor bug, DB failure on the
    // terminal write) so the row can never stick in 'running'.
    let result;
    try {
      result = await executeAgentRun({
        businessId,
        agent: { instructions: agent.instructions, output_format: agent.output_format },
        inputFilename: input.filename,
        inputMime: input.mimeType,
        data: input.data
      });
    } catch (err) {
      await patchAgentRun(businessId, runId, {
        status: "failed",
        error_detail: "The run failed unexpectedly — try again",
        completed_at: new Date().toISOString()
      }).catch((patchErr) => {
        logger.warn("agents/run: failed-state stamp failed", {
          businessId,
          runId,
          error: patchErr instanceof Error ? patchErr.message : String(patchErr)
        });
      });
      throw err;
    }

    const terminalPatch = result.ok
      ? {
          status: "succeeded" as const,
          output_md: result.outputMd,
          output_filename: result.outputFilename,
          output_mime_type: result.outputMime,
          error_detail: null,
          prompt_tokens: result.usage?.promptTokens ?? null,
          output_tokens: result.usage?.outputTokens ?? null,
          completed_at: new Date().toISOString()
        }
      : {
          status: "failed" as const,
          error_detail: RUN_ERROR_MESSAGES[result.error] ?? result.error,
          completed_at: new Date().toISOString()
        };
    try {
      await patchAgentRun(businessId, runId, terminalPatch);
    } catch (firstErr) {
      // The spend is already metered and (on success) the artifact exists —
      // worth a second identical write before giving up on it. Only after
      // the retry also fails do we fall back to a minimal failed stamp
      // (smaller payload, so it can survive a size/content-related failure)
      // rather than leaving the row 'running' forever.
      logger.warn("agents/run: terminal patch failed; retrying", {
        businessId,
        runId,
        error: firstErr instanceof Error ? firstErr.message : String(firstErr)
      });
      try {
        await patchAgentRun(businessId, runId, terminalPatch);
      } catch (retryErr) {
        await patchAgentRun(businessId, runId, {
          status: "failed",
          error_detail: "The result could not be saved — run the agent again",
          completed_at: new Date().toISOString()
        }).catch((stampErr) => {
          logger.warn("agents/run: failed-state stamp failed", {
            businessId,
            runId,
            error: stampErr instanceof Error ? stampErr.message : String(stampErr)
          });
        });
        throw retryErr;
      }
    }

    // Respond with the terminal state we just wrote — deterministic even if
    // a concurrent agent delete cascaded the row away mid-request (a re-read
    // could return null, and the pre-patch insert snapshot still says
    // 'running' with no artifact).
    return successResponse({ run: { ...run, ...terminalPatch } });
  } catch (err) {
    return handleRouteError(err);
  }
}
