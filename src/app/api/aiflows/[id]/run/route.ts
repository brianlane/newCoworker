/**
 * Manual "Run now" for an AiFlow. Owner-only (admins may act for a tenant).
 *
 * Enqueues a queued ai_flow_run with a `manual` trigger context; the
 * ai-flow-worker claims it on its next cron tick like any other run. The
 * optional `input` text populates {{trigger.windowText}} (and its first link
 * becomes {{trigger.url}}), so flows whose first step is extract_url can be
 * exercised by pasting a link.
 *
 * Works for ANY trigger channel — a manual start is how you test an SMS- or
 * email-triggered flow without waiting for a real message — but the flow must
 * be enabled (the worker cancels runs of disabled flows on claim).
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { enqueueAiFlowRun, getAiFlow } from "@/lib/ai-flows/db";
import { manualTriggerScope } from "@/lib/ai-flows/trigger-eval";

const idSchema = z.string().uuid();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  input: z.string().max(4000).optional()
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const flow = await getAiFlow(body.businessId, id);
    if (!flow) return errorResponse("NOT_FOUND", "AiFlow not found");
    if (!flow.enabled) {
      return errorResponse("VALIDATION_ERROR", "Enable the flow before running it");
    }
    // Voice flows run on the real-time Telnyx call path (telnyx-voice-inbound),
    // not the async worker — there's nothing for a "Run now" run to execute, and
    // the worker has no handler for voice steps. Refuse rather than enqueue a run
    // that would only fail. Place a test call from the trigger number instead.
    if (flow.definition.trigger.channel === "voice") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Voice flows run when a call comes in — place a call from the trigger number to test."
      );
    }

    const run = await enqueueAiFlowRun({
      businessId: body.businessId,
      flowId: id,
      trigger: manualTriggerScope(body.input ?? "", user.email),
      // Every click is its own run; dedupe only guards automatic enqueues.
      dedupeKey: `manual:${crypto.randomUUID()}`
    });
    return successResponse(run);
  } catch (err) {
    return handleRouteError(err);
  }
}
