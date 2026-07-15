/**
 * Internal AiFlow adapter: run a saved Agent (business_agents) against
 * flow-rendered text and return the artifact.
 *
 * Called by the ai-flow-worker when a `run_agent` step executes — this is
 * where agents become event-triggerable: any flow trigger (SMS, email,
 * webhook, schedule, ...) can feed an agent. The endpoint re-checks the
 * agent exists and is enabled (write-time validation can go stale), runs
 * the same executor as manual dashboard runs (metered into the shared AI
 * budget under `agent_run`), and records an `agent_runs` history row with
 * source='flow' + the flow run id so both the flow run detail and the
 * agent's own history show the linkage.
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
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

// The agent transformation is bounded at 90s inside executeAgentRun; leave
// headroom for the DB writes around it.
export const maxDuration = 120;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  agentId: z.string().uuid(),
  /** Rendered flow content the agent transforms. */
  input: z.string().min(1).max(40_000),
  /** ai_flow_runs id, recorded on the history row. */
  flowRunId: z.string().uuid().optional()
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

    const runId = randomUUID();
    await insertAgentRun({
      id: runId,
      agent_id: agent.id,
      business_id: body.businessId,
      source: "flow",
      flow_run_id: body.flowRunId ?? null,
      input_filename: "flow-input.txt",
      input_mime_type: "text/plain"
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
        inputFilename: "flow-input.txt",
        inputMime: "text/plain",
        data: Buffer.from(body.input, "utf8")
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

    return voiceToolResponse({
      ok: true,
      data: { output: result.outputMd, runId }
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
