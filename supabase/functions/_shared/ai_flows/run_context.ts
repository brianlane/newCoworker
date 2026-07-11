/**
 * AiFlow → AI-worker context bridge.
 *
 * When a flow run finishes (or parks) after texting a lead, later messages
 * from that lead are answered by the generic AI reply path, which
 * historically knew NOTHING about the automation. Production showed it
 * asking a lead "what's the best way to reach you by phone?" over SMS, one
 * turn after the flow had already extracted their name, product, and phone
 * (Truly Insurance, 2026-07-11): the flow asked a question, the run ended,
 * and the lead's answer landed on a model with zero flow context.
 *
 * This module summarizes a lead's recent runs — the workflow name, where it
 * stands, the vars it collected, and the last automated message sent to the
 * lead — into a prompt block reply workers prepend so the model continues
 * the conversation instead of restarting it. A business-wide variant gives
 * dashboard chat (owner-facing) an "automation activity" digest.
 *
 * Formatting is pure and unit-tested; the loaders are thin best-effort IO
 * wrappers — a context failure must never break the reply path.
 */
import { isTestModeTrigger } from "./test_mode.ts";

/** How far back a run still counts as conversation context. */
export const FLOW_CONTEXT_LOOKBACK_HOURS = 72;

/** Most runs summarized per lead (newest first). */
const MAX_RUNS_PER_CONTACT = 3;

/** Most runs summarized in the business-wide digest. */
const MAX_RUNS_PER_BUSINESS = 10;

/** Vars cap per run (schema-capped flows stay well under this). */
const MAX_VARS_PER_RUN = 12;

/** Per-value excerpt cap — long lead replies stay readable, not dominant. */
const MAX_VALUE_CHARS = 160;

/** Excerpt cap for the last automated message body. */
const MAX_LAST_MESSAGE_CHARS = 300;

export type FlowRunSnapshot = {
  flowName: string;
  status: string;
  updatedAt: string | null;
  vars: Record<string, unknown>;
};

/** Human phrasing for run statuses (fallback: the raw status). */
function statusPhrase(status: string): string {
  switch (status) {
    case "queued":
    case "running":
      return "in progress";
    case "awaiting_reply":
      return "waiting for this contact's reply";
    case "awaiting_approval":
      return "waiting on an owner approval";
    case "awaiting_agent":
      return "waiting on a teammate to claim";
    case "done":
      return "finished";
    case "failed":
      return "stopped with an error";
    default:
      return status;
  }
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * The run vars worth showing: engine markers (`__`-prefixed) and empty
 * values are dropped; everything else is stringified and clipped.
 */
export function presentableVars(vars: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith("__")) continue;
    const text =
      typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
    if (!text.trim()) continue;
    out.push([key, truncate(text, MAX_VALUE_CHARS)]);
    if (out.length >= MAX_VARS_PER_RUN) break;
  }
  return out;
}

/**
 * Per-contact context block for customer-facing reply workers. Null when
 * there is nothing to say (no recent runs and no recent automated message).
 */
export function formatFlowRunContext(
  runs: FlowRunSnapshot[],
  lastFlowMessage: string | null
): string | null {
  const shown = runs.slice(0, MAX_RUNS_PER_CONTACT);
  if (shown.length === 0 && !lastFlowMessage?.trim()) return null;

  const lines: string[] = [
    "Automation context: this business's automated workflows recently handled this contact. " +
      "Facts the automation already collected are listed below — treat them as KNOWN. " +
      "Do NOT ask for or re-confirm any of them (including their phone number: you are texting it)."
  ];
  for (const run of shown) {
    const when = run.updatedAt ? `, last update ${run.updatedAt}` : "";
    lines.push("");
    lines.push(`Workflow "${run.flowName}" — ${statusPhrase(run.status)}${when}:`);
    const vars = presentableVars(run.vars);
    if (vars.length === 0) {
      lines.push("- (no collected details)");
    } else {
      for (const [key, value] of vars) lines.push(`- ${key}: ${value}`);
    }
  }
  if (lastFlowMessage?.trim()) {
    lines.push("");
    lines.push(
      `Last automated message sent to this contact: "${truncate(lastFlowMessage, MAX_LAST_MESSAGE_CHARS)}"`
    );
    lines.push(
      "If their message reads like an answer to it, continue THAT thread naturally — " +
        "acknowledge the answer and move forward; never restart the conversation."
    );
  }
  return lines.join("\n");
}

/**
 * Business-wide digest for owner-facing dashboard chat: one line per recent
 * run so the owner's assistant knows what the automations have been doing.
 */
export function formatBusinessFlowActivity(
  runs: (FlowRunSnapshot & { leadLabel: string | null })[]
): string | null {
  const shown = runs.slice(0, MAX_RUNS_PER_BUSINESS);
  if (shown.length === 0) return null;
  const lines: string[] = [
    "Recent automation (AiFlow) activity — cite these when the owner asks what the automations did:"
  ];
  for (const run of shown) {
    const who = run.leadLabel ? ` for ${run.leadLabel}` : "";
    const when = run.updatedAt ? ` (last update ${run.updatedAt})` : "";
    lines.push(`- "${run.flowName}"${who}: ${statusPhrase(run.status)}${when}`);
  }
  return lines.join("\n");
}

// Minimal structural client (the _shared convention): only the query shapes
// this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

type RunRow = {
  flow_id: string;
  status: string;
  updated_at: string | null;
  context: Record<string, unknown> | null;
};

function runVars(context: Record<string, unknown> | null): Record<string, unknown> {
  const vars = context?.vars;
  return vars && typeof vars === "object" ? (vars as Record<string, unknown>) : {};
}

function runTrigger(context: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const trigger = context?.trigger;
  return trigger && typeof trigger === "object"
    ? (trigger as Record<string, unknown>)
    : undefined;
}

/** Flow names for a set of ids (unknown/missing ids get a generic label). */
async function loadFlowNames(supabase: AnyClient, flowIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (flowIds.length === 0) return names;
  const { data, error } = await supabase.from("ai_flows").select("id, name").in("id", flowIds);
  if (error) {
    console.error("run_context: flow name lookup", error);
    return names;
  }
  for (const row of (data ?? []) as Array<{ id: string; name?: string | null }>) {
    names.set(row.id, (row.name ?? "").trim() || "Untitled workflow");
  }
  return names;
}

/** Drop test runs — simulated sends never reached the contact. */
function liveRuns(rows: RunRow[]): RunRow[] {
  return rows.filter((row) => !isTestModeTrigger(runTrigger(row.context)));
}

function toSnapshot(row: RunRow, names: Map<string, string>): FlowRunSnapshot {
  return {
    flowName: names.get(row.flow_id) ?? "Untitled workflow",
    status: row.status,
    updatedAt: row.updated_at,
    vars: runVars(row.context)
  };
}

/**
 * Load + format the per-contact block. Best-effort: any failure returns
 * null so the reply path proceeds with plain customer-memory context.
 */
export async function loadFlowRunContext(
  supabase: AnyClient,
  businessId: string,
  contactE164: string
): Promise<string | null> {
  if (!contactE164) return null;
  try {
    const sinceIso = new Date(
      Date.now() - FLOW_CONTEXT_LOOKBACK_HOURS * 3_600_000
    ).toISOString();
    // Same lead-identity keys as goal_events: the triggering sender, the
    // extracted lead phone, or the number a wait is parked on.
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("flow_id, status, updated_at, context")
      .eq("business_id", businessId)
      .gte("updated_at", sinceIso)
      .or(
        `context->trigger->>from.eq.${contactE164},context->vars->>lead_phone.eq.${contactE164},context->waiting_reply->>from.eq.${contactE164}`
      )
      .order("updated_at", { ascending: false })
      // Over-fetch a little: test runs are dropped after the query and must
      // not starve the live ones out of the page.
      .limit(MAX_RUNS_PER_CONTACT * 2);
    if (error) {
      console.error("run_context: run lookup", error);
      return null;
    }
    const rows = liveRuns((data ?? []) as RunRow[]);
    const names = await loadFlowNames(supabase, [...new Set(rows.map((r) => r.flow_id))]);
    const snapshots = rows.map((row) => toSnapshot(row, names));

    // The last thing an automation texted this lead (send_sms steps only —
    // agent offers and owner notices go to teammates, not the lead).
    let lastFlowMessage: string | null = null;
    const { data: outbound, error: outboundErr } = await supabase
      .from("sms_outbound_log")
      .select("body")
      .eq("business_id", businessId)
      .eq("to_e164", contactE164)
      .eq("source", "ai_flow")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (outboundErr) {
      console.error("run_context: outbound lookup", outboundErr);
    } else {
      const body = (outbound as Array<{ body?: string | null }> | null)?.[0]?.body;
      if (typeof body === "string" && body.trim()) lastFlowMessage = body;
    }

    return formatFlowRunContext(snapshots, lastFlowMessage);
  } catch (e) {
    console.error("loadFlowRunContext", e);
    return null;
  }
}

/**
 * Load + format the owner-facing digest for dashboard chat. Best-effort.
 */
export async function loadBusinessFlowActivity(
  supabase: AnyClient,
  businessId: string
): Promise<string | null> {
  try {
    const sinceIso = new Date(
      Date.now() - FLOW_CONTEXT_LOOKBACK_HOURS * 3_600_000
    ).toISOString();
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("flow_id, status, updated_at, context")
      .eq("business_id", businessId)
      .gte("updated_at", sinceIso)
      .order("updated_at", { ascending: false })
      // Same over-fetch as the per-contact loader (test runs are dropped).
      .limit(MAX_RUNS_PER_BUSINESS * 2);
    if (error) {
      console.error("run_context: business run lookup", error);
      return null;
    }
    const rows = liveRuns((data ?? []) as RunRow[]);
    const names = await loadFlowNames(supabase, [...new Set(rows.map((r) => r.flow_id))]);
    const withLeads = rows.map((row) => ({
      ...toSnapshot(row, names),
      leadLabel: leadLabelFor(row)
    }));
    return formatBusinessFlowActivity(withLeads);
  } catch (e) {
    console.error("loadBusinessFlowActivity", e);
    return null;
  }
}

/** "Dwight Colclough (+14168775223)" — best available lead identity. */
function leadLabelFor(row: RunRow): string | null {
  const vars = runVars(row.context);
  const trigger = runTrigger(row.context);
  const name = typeof vars.lead_name === "string" ? vars.lead_name.trim() : "";
  const phone =
    (typeof vars.lead_phone === "string" && vars.lead_phone.trim()) ||
    (typeof trigger?.from === "string" && (trigger.from as string).trim()) ||
    "";
  if (name && phone) return `${name} (${phone})`;
  return name || phone || null;
}
