/**
 * Internal AiFlow adapter: run a saved Agent (business_agents) against
 * flow-rendered text OR a document and return the artifact.
 *
 * Called by the ai-flow-worker when a `run_agent` step executes — this is
 * where agents become event-triggerable: any flow trigger (SMS, email,
 * webhook, schedule, ...) can feed an agent. Two input modes:
 *   - `input` — rendered flow text (the original mode);
 *   - `documentRef` — an `email-attachments:<path>` ({{trigger.document}})
 *     or `business-docs:<id>` ref, resolved through the same tenant-gated
 *     source resolver as doc_extract, so a carrier's emailed PDF can feed a
 *     quote-comparison agent directly.
 * `saveDocument` additionally files the artifact into Business Documents
 * (staff audience — an automated run must never widen output to customer
 * channels); a filing failure is non-fatal (`fileError`) because the
 * artifact the flow branches on already exists.
 *
 * The endpoint re-checks the agent exists and is enabled (write-time
 * validation can go stale), runs the same executor as manual dashboard runs
 * (metered into the shared AI budget under `agent_run`), and records an
 * `agent_runs` history row with source='flow' + the flow run id so both the
 * flow run detail and the agent's own history show the linkage.
 *
 * Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN / per-tenant token), like the
 * other worker adapters (send-owner-email). Response contract mirrors them:
 * `{ ok, detail?, data? }` with HTTP 200 for "configured wrong" outcomes
 * (the worker maps those to a permanent step failure) and 500 only for
 * transport faults (the worker retries those).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getBusinessAgent, insertAgentRun, patchAgentRun } from "@/lib/agents/db";
import { executeAgentRun } from "@/lib/agents/run";
import { saveAgentRunArtifact } from "@/lib/agents/save-artifact";
import { resolveFlowDocumentSource } from "@/lib/ai-flows/doc-source";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

// The agent transformation is bounded at 90s inside executeAgentRun; leave
// headroom for the document download + DB writes around it.
export const maxDuration = 120;

const bodySchema = z
  .object({
    businessId: z.string().uuid(),
    agentId: z.string().uuid(),
    /** Rendered flow content the agent transforms (text mode). */
    input: z.string().min(1).max(40_000).optional(),
    /** Rendered document ref the agent runs on (document mode). */
    documentRef: z.string().min(1).max(600).optional(),
    /** File the artifact into Business Documents after the run. */
    saveDocument: z.object({ title: z.string().min(1).max(200) }).optional(),
    /** ai_flow_runs id, recorded on the history row. */
    flowRunId: z.string().uuid().optional()
  })
  .refine((b) => Boolean(b.input) !== Boolean(b.documentRef), {
    message: "provide exactly one of input / documentRef"
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
    const agent = await getBusinessAgent(body.businessId, body.agentId);
    if (!agent) return voiceToolResponse({ ok: false, detail: "agent_not_found" });
    if (!agent.enabled) return voiceToolResponse({ ok: false, detail: "agent_disabled" });

    // Resolve the run input: document refs go through the tenant-gated
    // source resolver (permanent problems → ok:false 200, the worker fails
    // the step without retrying; a transient ownership-lookup fault throws
    // → 500 → retry).
    let inputFilename = "flow-input.txt";
    let inputMime = "text/plain";
    let inputData: Buffer;
    let inputDocumentId: string | null = null;
    if (body.documentRef) {
      const resolved = await resolveFlowDocumentSource(body.businessId, body.documentRef);
      if (!resolved.ok) {
        return voiceToolResponse({
          ok: false,
          detail: `${resolved.error}${resolved.detail ? `: ${resolved.detail}` : ""}`
        });
      }
      inputFilename = resolved.source.filename;
      inputMime = resolved.source.mimeType;
      inputData = resolved.source.bytes;
      inputDocumentId = resolved.source.documentId;
    } else {
      inputData = Buffer.from(body.input ?? "", "utf8");
    }

    const runId = randomUUID();
    await insertAgentRun({
      id: runId,
      agent_id: agent.id,
      business_id: body.businessId,
      source: "flow",
      flow_run_id: body.flowRunId ?? null,
      input_document_id: inputDocumentId,
      input_filename: inputFilename,
      input_mime_type: inputMime
    });

    // executeAgentRun never throws for expected failures; an UNEXPECTED
    // throw after the insert must still stamp the history row failed —
    // otherwise it sticks in 'running' and the worker's 500-retry could
    // pile up additional orphaned rows.
    let result;
    try {
      result = await executeAgentRun({
        businessId: body.businessId,
        agent: { instructions: agent.instructions, output_format: agent.output_format },
        inputFilename,
        inputMime,
        data: inputData
      });
    } catch (execErr) {
      await patchAgentRun(body.businessId, runId, {
        status: "failed",
        error_detail: "The run failed unexpectedly",
        completed_at: new Date().toISOString()
      }).catch((patchErr) => {
        logger.warn("aiflows/run-agent: failed-state stamp failed", {
          businessId: body.businessId,
          runId,
          error: patchErr instanceof Error ? patchErr.message : String(patchErr)
        });
      });
      throw execErr;
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
          error_detail: result.error,
          completed_at: new Date().toISOString()
        };
    // Best-effort history stamp: the artifact (or failure) below is the
    // worker's source of truth; a failed history write must not turn a
    // successful transformation into a failed step.
    await patchAgentRun(body.businessId, runId, terminalPatch).catch((patchErr) => {
      logger.warn("aiflows/run-agent: history stamp failed", {
        businessId: body.businessId,
        runId,
        error: patchErr instanceof Error ? patchErr.message : String(patchErr)
      });
    });

    if (!result.ok) {
      await recordSystemLog({
        businessId: body.businessId,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_run_agent_failed",
        message: `Agent "${agent.name}" flow run failed: ${result.error}`,
        payload: {
          agent_id: agent.id,
          flow_run_id: body.flowRunId ?? null,
          detail: result.detail ?? null
        }
      });
      return voiceToolResponse({ ok: false, detail: result.error });
    }

    // ── Filing (non-fatal) ──────────────────────────────────────────────
    // The artifact the flow branches on already exists; a filing failure is
    // reported (`fileError`) rather than failing the step. Audience is
    // hard-pinned to 'staff' — an automated run must never widen an
    // artifact to customer channels.
    let filed: { documentId: string; title: string } | null = null;
    let fileError: string | undefined;
    if (body.saveDocument) {
      try {
        const saved = await saveAgentRunArtifact({
          businessId: body.businessId,
          run: {
            output_md: result.outputMd,
            output_filename: result.outputFilename,
            output_mime_type: result.outputMime,
            input_filename: inputFilename
          },
          agentName: agent.name,
          title: body.saveDocument.title,
          audience: "staff"
        });
        if (saved.ok) {
          filed = { documentId: saved.document.id, title: saved.document.title };
        } else {
          fileError = saved.detail;
        }
      } catch (saveErr) {
        fileError = saveErr instanceof Error ? saveErr.message : String(saveErr);
        logger.warn("aiflows/run-agent: artifact filing failed", {
          businessId: body.businessId,
          runId,
          error: fileError
        });
      }
    }

    return voiceToolResponse({
      ok: true,
      data: {
        output: result.outputMd,
        runId,
        filed,
        ...(fileError ? { fileError } : {})
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/run-agent failed", {
      businessId: body.businessId,
      agentId: body.agentId,
      error: message
    });
    return voiceToolResponse({ ok: false, detail: "agent_run_failed" }, 500);
  }
}
