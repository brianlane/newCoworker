/**
 * Internal AiFlow adapter: read a document (the triggering email's PDF/text
 * attachment), extract the flow's typed fields with Gemini, and optionally
 * file it into Business Documents.
 *
 * Called by the ai-flow-worker for a `doc_extract` step — the worker can't
 * run Gemini's document pipeline or touch the documents store from the edge
 * runtime, so it proxies here (same pattern as /api/internal/aiflow-email-fetch).
 *
 * Auth is gateway-only (per-tenant/shared ROWBOAT_GATEWAY_TOKEN with business
 * binding), so the worker can never read another tenant's attachments.
 *
 * Response mirrors the other adapters: `{ ok, detail?, data? }` with HTTP 200
 * for permanent input problems (unsupported ref/type, oversized, unreadable →
 * the worker maps to a permanent step failure) and 500 for transport/model
 * faults (the worker retries).
 */
import { z } from "zod";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { docExtract } from "@/lib/ai-flows/doc-extract";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

export const maxDuration = 120;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  sourceRef: z.string().min(1).max(600),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        description: z.string().max(300).optional()
      })
    )
    .min(1)
    .max(15),
  fileAs: z
    .object({
      title: z.string().min(1).max(200),
      audience: z.enum(["clients", "staff", "both"])
    })
    .optional()
});

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid args" : "invalid body";
    return voiceToolValidationError(detail);
  }

  const bindGuard = await gatewayBusinessGuard(request, body.businessId);
  if (bindGuard) return bindGuard;

  try {
    const result = await docExtract({
      businessId: body.businessId,
      sourceRef: body.sourceRef,
      fields: body.fields,
      ...(body.fileAs ? { fileAs: body.fileAs } : {})
    });
    if (!result.ok) {
      // Permanent input problem → ok:false 200 so the worker fails the step
      // without retrying into the same wall.
      return voiceToolResponse({ ok: false, detail: `${result.error}${result.detail ? `: ${result.detail}` : ""}` });
    }
    return voiceToolResponse({
      ok: true,
      data: {
        vars: result.vars,
        filed: result.filed,
        ...(result.fileError ? { fileError: result.fileError } : {})
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/doc-extract failed", { businessId: body.businessId, error: message });
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "error",
      event: "ai_flow_doc_extract_failed",
      message: `Document extraction failed: ${message}`,
      payload: { source_ref: body.sourceRef.slice(0, 200) }
    });
    return voiceToolResponse({ ok: false, detail: "doc_extract_failed" }, 500);
  }
}
