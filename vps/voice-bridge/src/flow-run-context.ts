/**
 * AiFlow → voice-bridge context bridge. Mirrors
 * `supabase/functions/_shared/ai_flows/run_context.ts` (the bridge is
 * rsynced to the VPS standalone, so it can't import across the repo) — the
 * DATA rules (query predicates, lookback, var filtering, status phrasing)
 * must stay identical to the shared module; only the surrounding wording is
 * voice-specific ("they are calling from it" vs "you are texting it").
 * tests/voice-bridge-flow-run-context.test.ts pins the two implementations
 * against each other so a one-sided edit is loud.
 *
 * Why this exists: when an automation texts a lead and the lead CALLS the
 * business instead of texting back, the voice assistant historically knew
 * nothing about the automation — it would restart intake on a caller whose
 * name, product, and renewal timing the flow had already collected (the SMS
 * twin of this bug shipped in the Truly Insurance 2026-07-11 incident).
 *
 * Kept dependency-free in its own module so repo-root tests and typecheck
 * can import it without pulling the bridge's runtime deps (@google/genai,
 * ws) that are only installed on the VPS.
 */

/** How far back a run still counts as conversation context. */
export const FLOW_CONTEXT_LOOKBACK_HOURS = 72;

/** Most runs summarized per caller (newest first). */
const MAX_RUNS_PER_CONTACT = 3;

/** Vars cap per run (schema-capped flows stay well under this). */
const MAX_VARS_PER_RUN = 12;

/** Per-value excerpt cap — long lead replies stay readable, not dominant. */
const MAX_VALUE_CHARS = 160;

/** Excerpt cap for each already-sent automated message body. */
const MAX_LAST_MESSAGE_CHARS = 300;

/**
 * Most recent automated messages quoted back to the model (mirror of the
 * shared module's MAX_FLOW_MESSAGES — keep in sync).
 */
export const MAX_FLOW_MESSAGES = 3;

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
    case "awaiting_call":
      return "on an AI phone call with this contact";
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
 * Per-caller context block for the voice system instruction. Null when
 * there is nothing to say (no recent runs and no recent automated messages).
 *
 * Ordering differs from the SMS mirror on purpose: the voice bridge hard-
 * clips this block to VOICE_FLOW_CONTEXT_MAX_CHARS, so the header, the
 * already-sent texts, and the continue-the-thread guidance LEAD — a clip can
 * only ever cost var lines of older runs, never the guidance itself.
 *
 * @param recentFlowMessages automated texts already sent to this caller,
 *   OLDEST FIRST (capped at MAX_FLOW_MESSAGES by the loader).
 */
export function formatVoiceFlowContext(
  runs: FlowRunSnapshot[],
  recentFlowMessages: string[]
): string | null {
  const shown = runs.slice(0, MAX_RUNS_PER_CONTACT);
  const messages = recentFlowMessages
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(-MAX_FLOW_MESSAGES);
  if (shown.length === 0 && messages.length === 0) return null;

  const lines: string[] = [
    "Automation context: this business's automated workflows recently handled this caller over text. " +
      "Facts the automation already collected are listed below — treat them as KNOWN. " +
      "Do NOT ask for or re-confirm any of them (including their phone number: they are calling from it)."
  ];
  if (messages.length > 0) {
    lines.push("");
    lines.push("Texts the automation ALREADY sent this caller (oldest first):");
    messages.forEach((m, i) => {
      lines.push(`${i + 1}. "${truncate(m, MAX_LAST_MESSAGE_CHARS)}"`);
    });
    lines.push(
      "These were already delivered — never repeat them or re-ask a question they contain. " +
        "If the caller brings one up or seems to be responding to it, continue THAT " +
        "conversation naturally — acknowledge and move forward; never restart intake."
    );
  }
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
  return lines.join("\n");
}

// Minimal structural client: only the query shapes this module uses, so the
// bridge's supabase-js client and test fakes both fit.
type AnyClient = any;

type RunRow = {
  flow_id: string;
  status: string;
  updated_at: string | null;
  context: Record<string, unknown> | null;
};

/**
 * PostgREST predicate excluding test runs AT THE QUERY so they can never
 * occupy the page and starve live runs out of the limit (mirror of the
 * shared module's NOT_TEST_RUN_OR — keep in sync).
 */
const NOT_TEST_RUN_OR =
  "context->trigger->>test_mode.is.null,context->trigger->>test_mode.neq.true";

function runVars(context: Record<string, unknown> | null): Record<string, unknown> {
  const vars = context?.vars;
  return vars && typeof vars === "object" ? (vars as Record<string, unknown>) : {};
}

/** True when a run's persisted trigger scope marks it as a test run. */
function isTestRun(context: Record<string, unknown> | null): boolean {
  const trigger = context?.trigger;
  return (
    trigger != null &&
    typeof trigger === "object" &&
    (trigger as Record<string, unknown>).test_mode === true
  );
}

/**
 * Load + format the per-caller block. Best-effort: any failure returns
 * null so the call proceeds with plain vault + customer-memory context.
 */
export async function loadVoiceFlowContext(
  supabase: AnyClient,
  businessId: string,
  callerE164: string
): Promise<string | null> {
  if (!callerE164) return null;
  try {
    const sinceIso = new Date(
      Date.now() - FLOW_CONTEXT_LOOKBACK_HOURS * 3_600_000
    ).toISOString();
    // Same lead-identity keys as the shared module (and goal_events): the
    // triggering sender, the extracted lead phone, or the number a wait is
    // parked on.
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("flow_id, status, updated_at, context")
      .eq("business_id", businessId)
      .gte("updated_at", sinceIso)
      .or(
        `context->trigger->>from.eq.${callerE164},context->vars->>lead_phone.eq.${callerE164},context->waiting_reply->>from.eq.${callerE164}`
      )
      .or(NOT_TEST_RUN_OR)
      .order("updated_at", { ascending: false })
      .limit(MAX_RUNS_PER_CONTACT);
    if (error) {
      console.warn("voice-bridge: flow-context run lookup failed (non-fatal)", error);
      return null;
    }
    const rows = ((data ?? []) as RunRow[]).filter((row) => !isTestRun(row.context));

    const flowIds = [...new Set(rows.map((r) => r.flow_id))];
    const names = new Map<string, string>();
    if (flowIds.length > 0) {
      const { data: flows, error: flowErr } = await supabase
        .from("ai_flows")
        .select("id, name")
        .in("id", flowIds);
      if (flowErr) {
        console.warn("voice-bridge: flow-context name lookup failed (non-fatal)", flowErr);
      } else {
        for (const row of (flows ?? []) as Array<{ id: string; name?: string | null }>) {
          names.set(row.id, (row.name ?? "").trim() || "Untitled workflow");
        }
      }
    }
    const snapshots: FlowRunSnapshot[] = rows.map((row) => ({
      flowName: names.get(row.flow_id) ?? "Untitled workflow",
      status: row.status,
      updatedAt: row.updated_at,
      vars: runVars(row.context)
    }));

    // The last few things an automation texted this caller (send_sms steps
    // only — agent offers and owner notices go to teammates, not the lead).
    // Multiple messages, not just the newest — mirror of the shared module.
    let recentFlowMessages: string[] = [];
    const { data: outbound, error: outboundErr } = await supabase
      .from("sms_outbound_log")
      .select("body")
      .eq("business_id", businessId)
      .eq("to_e164", callerE164)
      .eq("source", "ai_flow")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(MAX_FLOW_MESSAGES);
    if (outboundErr) {
      console.warn("voice-bridge: flow-context outbound lookup failed (non-fatal)", outboundErr);
    } else {
      // Query is newest-first for the LIMIT; the prompt reads oldest-first.
      recentFlowMessages = ((outbound ?? []) as Array<{ body?: string | null }>)
        .map((row) => (typeof row.body === "string" ? row.body : ""))
        .filter((body) => body.trim().length > 0)
        .reverse();
    }

    return formatVoiceFlowContext(snapshots, recentFlowMessages);
  } catch (e) {
    console.warn("voice-bridge: flow-context load failed (non-fatal)", e);
    return null;
  }
}
