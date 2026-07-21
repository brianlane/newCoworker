/**
 * start_aiflow_for_contact — the texting coworker's ONLY path into AiFlows.
 *
 * The customer-facing SMS persona is deliberately barred from the owner's
 * automations (rowboat-gates.ts: "customers must never enumerate or start
 * the owner's automations"); this core is the narrow, double-gated
 * exception behind the tool of the same name:
 *
 *   1. Per-flow owner opt-in: only flows whose definition carries
 *      `options.agentInvocable: true` can be seen or started — everything
 *      else refuses with model-facing steering, so a prompt-injected turn
 *      can at worst enroll the texter in a sequence the owner explicitly
 *      approved for exactly that purpose.
 *   2. Current texter only: the run is enqueued with the texter's E.164 as
 *      the trigger sender AND a seeded `lead_phone` var, so send steps,
 *      re-entry checks, and stop-on-response all see that one person.
 *   3. Loop guard: a texter who already has a LIVE run of the flow is never
 *      re-enrolled (hasActiveRunForLead, contact-expanded) — a flow-sent
 *      text can't cause the model to restart the same sequence.
 *
 * Modeled on manual-run-tool.ts (the owner-surface run_aiflow); result
 * objects are returned to the model verbatim, so wording here is
 * model-facing guidance, not UI copy.
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlows, enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { firstUrlInText } from "@/lib/ai-flows/trigger-eval";
import { recordSystemLog } from "@/lib/db/system-logs";
import { hasActiveRunForLead } from "../../../supabase/functions/_shared/ai_flows/reentry";

export const startAiflowForContactArgsSchema = z.object({
  flow: z.string().min(1).max(200),
  /** The CURRENT texter's number — the only person the tool may enroll. */
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164, e.g. +15551234567"),
  /** Why the conversation calls for this flow (lands in the run context). */
  reason: z.string().max(1000).optional()
});

export type AgentStartFlowDeps = {
  /** Injectable cores (tests). */
  listFlows?: typeof listAiFlows;
  enqueueFlowRun?: typeof enqueueAiFlowRun;
  /** Injectable live-run check (tests). */
  hasLiveRun?: (businessId: string, flowId: string, phone: string) => Promise<boolean>;
};

export type AgentStartFlowResult =
  | { ok: true; runId: string; flowName: string; note: string }
  | { ok: false; message: string };

/**
 * Resolve an agent-invocable flow and enroll the current texter. Refusals
 * are honest and steer the model back to replying normally — never a fake
 * success.
 */
export async function startAiFlowForContactTool(
  businessId: string,
  args: { flow: string; phone: string; reason?: string },
  deps: AgentStartFlowDeps = {}
): Promise<AgentStartFlowResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const enqueueFlowRun = deps.enqueueFlowRun ?? enqueueAiFlowRun;
  const hasLiveRun =
    deps.hasLiveRun ??
    (async (biz: string, flowId: string, phone: string) =>
      hasActiveRunForLead(await createSupabaseServiceClient(), biz, flowId, phone));
  /* c8 ignore stop */

  const flows = await listFlows(businessId);
  const ref = args.flow.trim();
  const refLc = ref.toLowerCase();
  // Resolve: exact id → exact name → unique substring (manual-run-tool
  // parity, so both surfaces steer the model identically).
  let matches = flows.filter((f) => f.id === ref);
  if (matches.length === 0) matches = flows.filter((f) => f.name.toLowerCase() === refLc);
  if (matches.length === 0) {
    matches = flows.filter((f) => f.name.toLowerCase().includes(refLc));
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message:
        `No automation matches "${ref}". Only use the exact names listed in your ` +
        `"Automations you may start" context — never invent one. If none fits, just reply normally.`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${ref}" matches ${matches.length} automations (${matches
        .slice(0, 5)
        .map((f) => f.name)
        .join("; ")}). Use the exact name from your context.`
    };
  }
  const flow = matches[0];
  if (!flow.enabled) {
    return {
      ok: false,
      message: `"${flow.name}" is DISABLED and cannot be started. Reply to the customer normally.`
    };
  }
  // The key gate: the owner must have flagged this flow for agent
  // enrollment. Without it the customer-facing surface stays barred.
  if (flow.definition?.options?.agentInvocable !== true) {
    return {
      ok: false,
      message:
        `The owner has not allowed the texting coworker to start "${flow.name}". ` +
        `Only automations listed in your "Automations you may start" context can be started. Reply normally.`
    };
  }
  if ((flow.definition as { trigger?: { channel?: string } })?.trigger?.channel === "voice") {
    return {
      ok: false,
      message: `"${flow.name}" is a voice flow — it runs on live calls and cannot enroll a texter.`
    };
  }
  // Loop guard: never re-enroll someone who is currently inside the flow.
  if (await hasLiveRun(businessId, flow.id, args.phone)) {
    return {
      ok: false,
      message:
        `This customer is already in "${flow.name}" — do not enroll them again. ` +
        `Reply to their message normally; the automation continues on its own.`
    };
  }

  const reason = (args.reason ?? "").trim();
  const windowText = [`phone: ${args.phone}`, reason].filter(Boolean).join("\n");
  const run = await enqueueFlowRun({
    businessId,
    flowId: flow.id,
    trigger: {
      channel: "manual",
      windowText,
      url: firstUrlInText(windowText),
      // The trigger sender is the TEXTER (identity for re-entry checks and
      // stop-on-response), with the starter recorded separately.
      from: args.phone,
      started_by: "sms_coworker"
    },
    // Pre-seeded identity so {{vars.lead_phone}} sends work without an
    // extract_text step.
    vars: { lead_phone: args.phone },
    // Every agent-initiated enrollment is its own run; the live-run guard
    // above (not the dedupe key) is what prevents double-enrollment.
    dedupeKey: `agent:${crypto.randomUUID()}`
  });
  if (!run) {
    // enqueueAiFlowRun answers null when the flow's own re-entry gate
    // blocked the enrollment — same customer-facing meaning as the live-run
    // guard.
    return {
      ok: false,
      message: `This customer was already enrolled in "${flow.name}" — reply normally.`
    };
  }
  await recordSystemLog({
    businessId,
    source: "aiflow",
    level: "info",
    event: "ai_flow_run_enqueued_by_sms_coworker",
    message: `The texting coworker enrolled ${args.phone} in "${flow.name}"`,
    payload: {
      flow_id: flow.id,
      run_id: run.id,
      contact: args.phone,
      ...(reason ? { reason: reason.slice(0, 300) } : {})
    }
  });
  return {
    ok: true,
    runId: run.id,
    flowName: flow.name,
    note:
      `"${flow.name}" is now running for this customer (starts within about a minute). ` +
      `Do NOT repeat what the automation will send — just answer their message naturally.`
  };
}
