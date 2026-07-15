/**
 * Resume a batch-flow run parked by a `place_ai_call` step (status
 * `awaiting_call`) with the call's outcome.
 *
 * Writers (both status-guarded, so only the FIRST outcome lands):
 *   - telnyx-voice-call-end on the outbound leg's hangup ("transferred" /
 *     "answered" / "no_answer", derived from the session's transfer_initiated
 *     stamp and the reservation's answer_issued_at);
 *   - the VPS voice bridge the moment its live-transfer tool connects the
 *     callee to a human ("transferred" — immediate, because a transferred
 *     human conversation can outlive the run's wait ceiling). The bridge is a
 *     separate Node codebase, so it carries its own copy of this write (see
 *     vps/voice-bridge/src/index.ts resumeFlowRunWithCallOutcome) — keep the
 *     two in lockstep like the chat-spend-cap mirrors.
 *
 * The timeout sweep (resume_overdue_call_waits) is the no-webhook backstop.
 * Mirrors the wait_for_reply resume conventions: outcome into
 * context.vars[save_as], per-step marker stamped, waiting_call.result for the
 * run-detail audit view, revision-gated optimistic write. Never throws.
 */

/** Outcomes a voice-path resume can deliver (sweep adds "no_answer" on timeout). */
export type PlaceCallOutcome = "transferred" | "answered" | "no_answer";

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** The session context's flow_run link (see OutboundSessionContext.flow_run). */
export type FlowRunLink = {
  run_id?: unknown;
  save_as?: unknown;
  marker?: unknown;
  step_index?: unknown;
};

/**
 * Apply `outcome` to the linked parked run. Returns true when THIS write
 * resumed the run (false: no/invalid link, run not awaiting this call's step,
 * a racing writer won, or a read/write error — all safe to ignore because
 * the timeout sweep backstops a never-resumed run).
 */
export async function resumeFlowRunWithCallOutcome(
  supabase: AnyClient,
  link: FlowRunLink | null | undefined,
  outcome: PlaceCallOutcome
): Promise<boolean> {
  const runId = typeof link?.run_id === "string" ? link.run_id : "";
  if (!runId) return false;
  const saveAs =
    typeof link?.save_as === "string" && link.save_as.trim() ? link.save_as : "call_outcome";
  const marker =
    typeof link?.marker === "string" && link.marker.trim() ? link.marker : "__called_unknown";
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, status, context, revision")
      .eq("id", runId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("call_outcome: run lookup", error);
      return false;
    }
    const run = data as {
      id: string;
      status: string;
      context: Record<string, unknown> | null;
      revision: number;
    };
    if (run.status !== "awaiting_call") return false;
    // Belt-and-braces: the parked step must be the one this call was placed
    // for (a stale link from a re-run must never resolve a different wait).
    const waiting = (run.context?.waiting_call ?? {}) as { step_index?: unknown };
    if (
      typeof link?.step_index === "number" &&
      typeof waiting.step_index === "number" &&
      waiting.step_index !== link.step_index
    ) {
      return false;
    }
    const prevVars =
      run.context?.vars && typeof run.context.vars === "object"
        ? (run.context.vars as Record<string, unknown>)
        : {};
    const nextContext = {
      ...(run.context ?? {}),
      vars: { ...prevVars, [saveAs]: outcome, [marker]: "1" },
      waiting_call: {
        ...(run.context?.waiting_call as Record<string, unknown>),
        result: outcome
      }
    };
    const { data: updated, error: updErr } = await supabase
      .from("ai_flow_runs")
      .update({
        status: "queued",
        respond_by_at: null,
        claimed_at: null,
        context: nextContext,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("revision", run.revision)
      .eq("status", "awaiting_call")
      .select("id");
    if (updErr) {
      console.error("call_outcome: run resume", updErr);
      return false;
    }
    return ((updated ?? []) as unknown[]).length > 0;
  } catch (e) {
    console.error("call_outcome: resume threw", e);
    return false;
  }
}
