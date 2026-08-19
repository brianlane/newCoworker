import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { resolveStaffCaller } from "@/lib/voice-tools/staff-caller";
import { listAiFlowsTool, runAiFlowTool } from "@/lib/ai-flows/manual-run-tool";
import { logger } from "@/lib/logger";

/**
 * `run_aiflow`, voice-bridge adapter, STAFF ONLY.
 *
 * Lets the owner (or a roster teammate) start one of their automations from a
 * phone call: "I got a new lead, Jane, 602 555 1212, run my new lead intake".
 * Every other conversational owner surface could already do this (dashboard
 * chat and the owner-SMS operator both carry the tool); voice was the one
 * surface with no flow tool at all, so a spoken request had nowhere to go.
 *
 * Same shared core as those surfaces (src/lib/ai-flows/manual-run-tool.ts), so
 * flow resolution, the disabled-flow refusal, and the voice-flow refusal are
 * identical everywhere. Omitting `flow` lists what is available instead of
 * guessing, which is what the model needs when the caller is vague.
 *
 * TWO gates, because a customer must never start a tenant's automations:
 *   1. the bridge only DECLARES this tool for staff callers, and
 *   2. this route re-resolves `callerE164` server-side and refuses anyone who
 *      is not the owner or an active roster member (fails closed).
 */

const argsSchema = z.object({
  /** Flow id, exact name, or a unique fragment. Omitted = list them. */
  flow: z.string().min(1).max(200).optional(),
  /** What the caller said, passed to the run as its trigger text. */
  input: z.string().max(4000).optional()
});

export async function POST(request: Request) {
  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "run_aiflow"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;

  // Server-side staff gate (see the module doc): a customer asking for this
  // gets an honest refusal, never someone else's automation.
  const staff = await resolveStaffCaller(envelope.businessId, envelope.callerE164);
  if (!staff) {
    return voiceToolResponse({
      ok: false,
      detail: "not_staff",
      data: {
        message:
          "Only the business owner or a team member can start an automation, and this call is not from a number I recognize as one. Tell the caller you'll pass the request along instead."
      }
    });
  }

  try {
    if (!args.flow) {
      const listed = await listAiFlowsTool(envelope.businessId);
      return voiceToolResponse({ ok: true, data: listed });
    }
    const result = await runAiFlowTool(envelope.businessId, {
      flow: args.flow,
      ...(args.input ? { input: args.input } : {})
    });
    // A refusal (unknown/ambiguous/disabled/voice flow) is a 200 with ok:false
    // carrying the model-facing reason, exactly like the other adapters: the
    // AI explains it on the call instead of treating it as a failure.
    return voiceToolResponse(
      result.ok ? { ok: true, data: result } : { ok: false, detail: "refused", data: result }
    );
  } catch (err) {
    logger.warn("voice-tools/run-aiflow failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
