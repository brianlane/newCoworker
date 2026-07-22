/**
 * Shared cores for the dashboard coworker's "run automations" tools
 * (`list_aiflows` / `run_aiflow`), used by BOTH dashboard-chat turn paths:
 *
 *   - the INLINE primary path (src/lib/dashboard-chat/action-tools.ts), and
 *   - the Rowboat fallback path (/api/rowboat/tool-call — the over-budget /
 *     no-platform-key worker turns, tool names `dashboard_list_aiflows` /
 *     `dashboard_run_aiflow`).
 *
 * One implementation keeps the two paths byte-identical in behavior (flow
 * resolution, honest refusals, model steering copy) — the same parity this
 * module's callers exist to guarantee. Result objects are returned to the
 * model verbatim, so the wording here is model-facing guidance, not UI copy.
 */

import { z } from "zod";
import { listAiFlows, enqueueAiFlowRun, type AiFlowRow } from "@/lib/ai-flows/db";
import { manualTriggerScope } from "@/lib/ai-flows/trigger-eval";

export const runAiflowToolArgsSchema = z.object({
  flow: z.string().min(1).max(200),
  // Same bound as the dashboard "Run now" endpoint.
  input: z.string().max(4000).optional()
});

/** Cap on flows returned to the model (a business rarely has more). */
export const LIST_AIFLOWS_MAX = 50;

/** One-line human summary of what starts a flow, for the model's listing. */
export function flowTriggerSummary(definition: {
  trigger?: { channel?: string; on?: string };
}): string {
  const trigger = definition?.trigger;
  if (!trigger?.channel) return "unknown trigger";
  if (trigger.channel === "manual") return "manual (run on demand)";
  if (trigger.channel === "calendar") return `calendar (${trigger.on ?? "event"})`;
  return trigger.channel;
}

export type ManualRunToolDeps = {
  /** Injectable cores (tests). */
  listFlows?: typeof listAiFlows;
  enqueueFlowRun?: typeof enqueueAiFlowRun;
};

export type ListAiFlowsToolResult = {
  ok: true;
  flows: { id: string; name: string; enabled: boolean; trigger: string }[];
  note: string;
};

/**
 * Resolve a model-supplied flow reference against the business's flows:
 * exact id → exact name → unique substring. Ambiguity and misses refuse
 * honestly with model-facing steering (shared by run_aiflow / edit_aiflow).
 */
export function resolveAiFlowByRef(
  flows: AiFlowRow[],
  ref: string
): { ok: true; flow: AiFlowRow } | { ok: false; message: string } {
  const trimmed = ref.trim();
  const refLc = trimmed.toLowerCase();
  let matches = flows.filter((f) => f.id === trimmed);
  if (matches.length === 0) matches = flows.filter((f) => f.name.toLowerCase() === refLc);
  if (matches.length === 0) {
    matches = flows.filter((f) => f.name.toLowerCase().includes(refLc));
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message: `No AiFlow matches "${trimmed}". Call list_aiflows and use one of the real names or ids.`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${trimmed}" matches ${matches.length} flows (${matches
        .slice(0, 5)
        .map((f) => f.name)
        .join("; ")}). Ask the owner which one and use its exact name or id.`
    };
  }
  return { ok: true, flow: matches[0] };
}

export type RunAiFlowToolResult =
  | { ok: true; runId: string; flowName: string; note: string }
  | { ok: false; message: string };

/** List the business's AiFlows for the model (id, name, enabled, trigger). */
export async function listAiFlowsTool(
  businessId: string,
  deps: ManualRunToolDeps = {}
): Promise<ListAiFlowsToolResult> {
  /* c8 ignore next -- production default; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const flows = await listFlows(businessId);
  return {
    ok: true,
    flows: flows.slice(0, LIST_AIFLOWS_MAX).map((f) => ({
      id: f.id,
      name: f.name,
      enabled: f.enabled,
      trigger: flowTriggerSummary(f.definition)
    })),
    note:
      "When one of these matches what the owner asked for, offer it as an option next to doing the action directly and let the owner choose. Disabled flows can be mentioned but not run — the owner reviews/enables them at /dashboard/aiflows."
  };
}

/**
 * Resolve a flow by id / exact name / unique substring and enqueue a manual
 * run. Ambiguity, disabled flows, and voice flows refuse honestly with
 * model-facing steering (never a fake success).
 */
export async function runAiFlowTool(
  businessId: string,
  args: { flow: string; input?: string },
  deps: ManualRunToolDeps = {}
): Promise<RunAiFlowToolResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const enqueueFlowRun = deps.enqueueFlowRun ?? enqueueAiFlowRun;
  /* c8 ignore stop */
  const flows = await listFlows(businessId);
  const resolved = resolveAiFlowByRef(flows, args.flow);
  if (!resolved.ok) return resolved;
  const flow = resolved.flow;
  if (!flow.enabled) {
    return {
      ok: false,
      message: `"${flow.name}" is DISABLED, so it cannot be run. Tell the owner it's awaiting their review — they can enable it at /dashboard/aiflows, then ask again.`
    };
  }
  // Voice flows run on the real-time call path, not the async worker —
  // same refusal as the dashboard "Run now" endpoint (an enqueued run
  // would only fail while the model tells the owner it started).
  if ((flow.definition as { trigger?: { channel?: string } })?.trigger?.channel === "voice") {
    return {
      ok: false,
      message: `"${flow.name}" is a voice flow — it runs when a call comes in and cannot be started manually. Tell the owner to place a call from the trigger number to test it.`
    };
  }
  const run = await enqueueFlowRun({
    businessId,
    flowId: flow.id,
    trigger: manualTriggerScope(args.input ?? "", "assistant"),
    // Every model-initiated run is its own run; dedupe only guards
    // automatic enqueues (mirror of the dashboard "Run now" endpoint).
    dedupeKey: `manual:${crypto.randomUUID()}`
  });
  if (!run) {
    return { ok: false, message: "The run could not be enqueued — tell the owner to try again." };
  }
  return {
    ok: true,
    runId: run.id,
    flowName: flow.name,
    note: `Run enqueued — it starts within about a minute. Tell the owner "${flow.name}" is running and they can watch it at /dashboard/aiflows.`
  };
}
