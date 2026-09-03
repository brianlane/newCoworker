/**
 * wait_for_reply resume: a lead (or a tester using their own phone) texts
 * back while a run is parked waiting on their number.
 *
 * Capturing the reply lets the flow skip remaining `no_reply` nudges. That
 * does NOT, by itself, own the conversational turn. The SMS coworker still
 * answers unless the waiting flow set `options.suppressDefaultReply` (it
 * will send its own next customer text: an ack, a classify-then-reply).
 *
 * KIN 2026-09-02: a lead replied that they had booked but were unsure of
 * the time. The parked wait swallowed the inbound (`suppressed_by_ai_flow`),
 * the flow had no reply-handling send, and the coworker never confirmed.
 * Cadence waits are timeouts, not a mute.
 *
 * Revision-gated like the other inbound resumes so a concurrent timeout
 * sweep cannot be clobbered. Losing a race means that run's no-reply
 * branch already ran. Never throws: a failure here must not break inbound
 * SMS processing.
 */
import { telemetryRecord } from "../telemetry.ts";

// Minimal structural client (the _shared convention): only the query
// shapes this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type WaitReplyResumeResult = {
  /** Runs whose wait consumed this text and were re-queued. */
  resumedIds: string[];
  /**
   * True when at least one resumed flow set `suppressDefaultReply`.
   * The inbound webhook stamps `sms_inbound_jobs.suppress_reply` from this
   * so the coworker stays quiet only when the flow asked to own the turn.
   * A flow-options read failure fails CLOSED (suppress), matching the
   * previous wait-always-mutes behavior, because a realtor-style flow that
   * sends its own ack must not double-text on a blip.
   */
  suppressCoworker: boolean;
};

const EMPTY: WaitReplyResumeResult = { resumedIds: [], suppressCoworker: false };

/** True when this flow definition asked to own the inbound SMS turn. */
export function flowOwnsCoworkerTurn(definition: unknown): boolean {
  if (!definition || typeof definition !== "object") return false;
  const options = (definition as { options?: { suppressDefaultReply?: unknown } }).options;
  return options?.suppressDefaultReply === true;
}

/**
 * Match this sender to EVERY run parked waiting on their number
 * (status='awaiting_reply', context.waiting_reply.from). One lead can
 * legitimately have several flows waiting, and their single text answers
 * all of them. Each run gets the reply written into context.vars[save_as],
 * the per-step resolution marker stamped, and a re-queue.
 *
 * A non-empty `resumedIds` makes the caller skip trigger evaluation (the
 * waiting flow already has this turn's text; starting a fresh run would
 * double-process the lead). Coworker suppression is a separate bit.
 */
export async function resumeAwaitingReplyRun(
  supabase: AnyClient,
  businessId: string,
  from: string | null,
  bodyText: string
): Promise<WaitReplyResumeResult> {
  if (!from) return EMPTY;
  // Hoisted so a throw after a successful re-queue still reports those ids.
  // Returning EMPTY from the outer catch would let trigger evaluation start
  // a second run, and would fail-open the coworker mute.
  const resumed: Array<{ id: string; flowId: string | null }> = [];
  try {
    const { data } = await supabase
      .from("ai_flow_runs")
      .select("id, flow_id, context, revision")
      .eq("business_id", businessId)
      .eq("status", "awaiting_reply")
      .eq("context->waiting_reply->>from", from)
      .order("updated_at", { ascending: false })
      .limit(10);
    const rows = (data ?? []) as Array<{
      id: string;
      flow_id: string | null;
      context: Record<string, unknown> | null;
      revision: number;
    }>;
    if (rows.length === 0) return EMPTY;

    for (const run of rows) {
      const waiting =
        (run.context?.waiting_reply as { save_as?: unknown; marker?: unknown } | undefined) ?? {};
      const saveAs =
        typeof waiting.save_as === "string" && waiting.save_as.trim()
          ? waiting.save_as
          : "reply_text";
      const prevVars =
        run.context?.vars && typeof run.context.vars === "object"
          ? (run.context.vars as Record<string, unknown>)
          : {};
      const markerVars =
        typeof waiting.marker === "string" && waiting.marker.trim()
          ? { [waiting.marker]: "1" }
          : {};
      const nextContext = {
        ...(run.context ?? {}),
        vars: { ...prevVars, [saveAs]: bodyText.slice(0, 4000), ...markerVars },
        waiting_reply: {
          ...(run.context?.waiting_reply as Record<string, unknown>),
          result: "reply"
        }
      };
      const { data: updated, error } = await supabase
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
        .eq("status", "awaiting_reply")
        .select("id");
      if (error) {
        console.error("ai_flow_runs wait_for_reply resume", error);
        continue;
      }
      if ((updated ?? []).length > 0) {
        resumed.push({ id: run.id, flowId: run.flow_id });
        await telemetryRecord(supabase, "ai_flow_run_reply_resumed", {
          business_id: businessId,
          run_id: run.id
        });
      }
    }
    if (resumed.length === 0) return EMPTY;

    const resumedIds = resumed.map((r) => r.id);
    const flowIds = [
      ...new Set(resumed.map((r) => r.flowId).filter((id): id is string => typeof id === "string" && id.length > 0))
    ];
    if (flowIds.length === 0) {
      // Resumed a row with no flow_id. Cannot tell whether it owns the turn;
      // keep the coworker quiet rather than risk a double text.
      return { resumedIds, suppressCoworker: true };
    }

    const { data: flows, error: flowErr } = await supabase
      .from("ai_flows")
      .select("id, definition")
      .in("id", flowIds);
    if (flowErr) {
      console.error("ai_flows wait_for_reply suppress lookup", flowErr);
      return { resumedIds, suppressCoworker: true };
    }
    const definitions = ((flows ?? []) as Array<{ definition: unknown }>).map((f) => f.definition);
    // A missing flow row is treated as "does not own the turn": cadences
    // like KIN's are the common wait_for_reply shape, and they do not set
    // the flag. A realtor-style flow that does set it is still found when
    // the row exists.
    return {
      resumedIds,
      suppressCoworker: definitions.some(flowOwnsCoworkerTurn)
    };
  } catch (e) {
    console.error("resumeAwaitingReplyRun", e);
    if (resumed.length === 0) return EMPTY;
    return {
      resumedIds: resumed.map((r) => r.id),
      suppressCoworker: true
    };
  }
}
