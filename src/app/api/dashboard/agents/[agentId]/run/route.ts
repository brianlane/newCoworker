/**
 * Agents — run execution.
 *
 *   POST /api/dashboard/agents/:agentId/run
 *     multipart: businessId + file (repeatable)      → run against fresh uploads
 *     JSON:      { businessId, documentId }          → run against one document
 *     JSON:      { businessId, documentIds: [...] }  → run against several documents
 *
 * One run = one Gemini transformation (executeAgentRun) over EVERY attached
 * file — multi-file runs exist for side-by-side work ("compare these
 * carrier quotes"). Executed INLINE — a run is an owner-attended action and
 * the model call is bounded at 90s, same posture as document ingestion.
 * Fresh uploads are stored in the private business-docs bucket
 * (`<businessId>/agent-inputs/<runId>/…`) so run history keeps its inputs;
 * document runs read the stored originals for full fidelity (not the
 * condensed content_md). Runs are staff-allowed (`operate_messages`) —
 * using an agent is operating, not authoring.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getBusinessAgent,
  insertAgentRun,
  patchAgentRun,
  type AgentRunInputFileMeta
} from "@/lib/agents/db";
import { executeAgentRun } from "@/lib/agents/run";
import { AGENT_RUN_MAX_FILES, AGENT_RUN_MAX_TOTAL_BYTES } from "@/lib/agents/core";
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
  empty_content: "An attachment has no readable content",
  too_many_files: `A run can carry at most ${AGENT_RUN_MAX_FILES} files`,
  model_unavailable: "The AI service is not configured — try again later",
  model_failed: "The AI call failed — try again"
};

type RouteContext = { params: Promise<{ agentId: string }> };

type RunInputFile = {
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
    const uploads: Array<{ filename: string; mimeType: string; data: Buffer }> = [];
    let documentIds: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (!form) return errorResponse("VALIDATION_ERROR", "Expected multipart form data");
      const parsedBusiness = z.string().uuid().safeParse(form.get("businessId"));
      if (!parsedBusiness.success) {
        return errorResponse("VALIDATION_ERROR", "businessId is required");
      }
      businessId = parsedBusiness.data;
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (files.length === 0) return errorResponse("VALIDATION_ERROR", "file is required");
      if (files.length > AGENT_RUN_MAX_FILES) {
        return errorResponse(
          "VALIDATION_ERROR",
          `Attach at most ${AGENT_RUN_MAX_FILES} files per run`
        );
      }
      let totalBytes = 0;
      for (const file of files) {
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
        totalBytes += file.size;
        uploads.push({
          filename: file.name.slice(0, 200) || "attachment",
          mimeType,
          data: Buffer.from(await file.arrayBuffer())
        });
      }
      if (totalBytes > AGENT_RUN_MAX_TOTAL_BYTES) {
        return errorResponse("VALIDATION_ERROR", "Attachments exceed 25 MB combined");
      }
    } else {
      const bodySchema = z
        .object({
          businessId: z.string().uuid(),
          documentId: z.string().uuid().optional(),
          documentIds: z.array(z.string().uuid()).min(1).max(AGENT_RUN_MAX_FILES).optional()
        })
        .refine((b) => Boolean(b.documentId) !== Boolean(b.documentIds), {
          message: "provide documentId or documentIds"
        });
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
      }
      businessId = body.data.businessId;
      documentIds = body.data.documentIds ?? [body.data.documentId!];
      if (new Set(documentIds).size !== documentIds.length) {
        return errorResponse("VALIDATION_ERROR", "Duplicate documents in the selection");
      }
    }

    // Role gate BEFORE any tenant-data read (document lookup/download).
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    let inputs: RunInputFile[];
    if (uploads.length > 0) {
      inputs = uploads.map((u) => ({ ...u, documentId: null }));
    } else {
      inputs = [];
      let totalBytes = 0;
      for (const documentId of documentIds) {
        const document = await getBusinessDocument(businessId, documentId);
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
        const data = Buffer.from(await blob.arrayBuffer());
        totalBytes += data.byteLength;
        if (totalBytes > AGENT_RUN_MAX_TOTAL_BYTES) {
          return errorResponse("VALIDATION_ERROR", "Documents exceed 25 MB combined");
        }
        inputs.push({
          filename: document.storage_path.split("/").pop() ?? document.title,
          mimeType: document.mime_type,
          data,
          documentId: document.id
        });
      }
    }

    const agent = await getBusinessAgent(businessId, agentId);
    if (!agent) return errorResponse("NOT_FOUND", "Agent not found", 404);
    if (!agent.enabled) {
      return errorResponse("VALIDATION_ERROR", "This agent is disabled — enable it to run");
    }

    const runId = randomUUID();
    // Archive fresh uploads so run history keeps its inputs (best-effort —
    // the run itself matters more than a re-viewable copy). One object per
    // file, index-prefixed so same-named uploads can't collide.
    const archivedPaths: (string | null)[] = inputs.map(() => null);
    if (uploads.length > 0) {
      for (const [i, input] of inputs.entries()) {
        const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "input";
        const path = `${businessId}/agent-inputs/${runId}/${i}-${safeName}`;
        const { error: uploadError } = await db.storage
          .from(BUSINESS_DOCS_BUCKET)
          .upload(path, input.data, { contentType: input.mimeType });
        if (uploadError) {
          logger.warn("agents/run: input upload failed; running without archive", {
            businessId,
            error: uploadError.message
          });
        } else {
          archivedPaths[i] = path;
        }
      }
    }

    // Best-effort compensation: an aborted run must not leave orphaned
    // archived inputs (no row pointing at them) in the bucket.
    const removeArchivedInputs = async (): Promise<void> => {
      const paths = archivedPaths.filter((p): p is string => p !== null);
      if (paths.length === 0) return;
      const { error: removeError } = await db.storage.from(BUSINESS_DOCS_BUCKET).remove(paths);
      if (removeError) {
        logger.warn("agents/run: orphan input cleanup failed", {
          businessId,
          paths,
          error: removeError.message
        });
      }
    };

    const inputFilesMeta: AgentRunInputFileMeta[] = inputs.map((input, i) => ({
      filename: input.filename,
      mime_type: input.mimeType,
      document_id: input.documentId,
      storage_path: archivedPaths[i]
    }));

    let run;
    try {
      run = await insertAgentRun({
        id: runId,
        agent_id: agent.id,
        business_id: businessId,
        source: "manual",
        // Scalar columns mirror the FIRST file (single-file rows read
        // exactly as before); input_files carries the full ordered list.
        input_document_id: inputs[0].documentId,
        input_filename: inputs[0].filename,
        input_mime_type: inputs[0].mimeType,
        input_storage_path: archivedPaths[0],
        input_files: inputFilesMeta
      });
    } catch (err) {
      await removeArchivedInputs();
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
        inputFilename: inputs[0].filename,
        inputMime: inputs[0].mimeType,
        data: inputs[0].data,
        extraFiles: inputs.slice(1).map((i) => ({
          filename: i.filename,
          mime: i.mimeType,
          data: i.data
        }))
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
