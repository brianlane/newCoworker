/**
 * Record a forwarded / transferred call in Call history.
 *
 * Call history reads `voice_call_transcripts`, which the VPS voice bridge writes
 * ONLY for AI-handled calls. Calls the routing layer transfers/forwards straight
 * to a human — per-caller transfer rules (e.g. Clever's Live-Transfer line →
 * Dave), voice-AiFlow `transfer`/`handoff`, safe-mode forwards — never engage the
 * bridge, so without this they never appear in the log.
 *
 * telnyx-voice-call-end knows each forwarded call's final outcome, so it calls
 * this at the same points it fires warm-transfer SMS notifications:
 *   - a human answered  → outcome 'answered' → status 'completed'
 *   - rang out / no-answer → outcome 'missed'   → status 'missed'
 *
 * The row carries no transcript turns (there was no AI conversation) and is
 * written with `summarized_at` set so the call-summary sweep never dispatches it.
 * Upserts on the unique `call_control_id`, so the same call is one row no matter
 * how many webhook deliveries land, and a later `answered` correctly supersedes
 * an earlier `missed` (a dropped call.bridged then a normal_clearing hangup).
 *
 * Best-effort by contract: NEVER throws — recording a call for the log must never
 * break live call routing. Dependency-injected (structural supabase type) so it
 * is unit-tested from vitest under the shared 100% coverage gate.
 */

type Row = { data: unknown; error: { message: string } | null };

export interface ForwardedCallLogSupabase {
  from(table: string): {
    upsert(
      values: Record<string, unknown>,
      opts: { onConflict: string }
    ): PromiseLike<Row>;
  };
}

export type ForwardedCallOutcome = "answered" | "missed";

export type ForwardedCallLogResult = {
  status: "recorded" | "skipped" | "failed";
  /** no_call | no_business | <db error>. Unset on "recorded". */
  reason?: string;
};

/**
 * Upsert a forwarded-call row. `answered` maps to status 'completed' and
 * stamps ended_at (the leg is over by the time we know the outcome); `missed`
 * maps to status 'missed' with no ended_at (nobody ever picked up).
 */
export async function recordForwardedCall(
  supabase: ForwardedCallLogSupabase,
  opts: {
    businessId: string;
    callControlId: string;
    outcome: ForwardedCallOutcome;
    /** Caller's E.164 (empty for a withheld inbound number → stored NULL). */
    callerE164?: string | null;
    /** The human number the call was forwarded/transferred to. */
    forwardedToE164?: string | null;
    /** When the call started, if known (falls back to now()). */
    startedAtIso?: string | null;
    nowIso?: string;
  }
): Promise<ForwardedCallLogResult> {
  try {
    if (!opts.callControlId) return { status: "skipped", reason: "no_call" };
    if (!opts.businessId) return { status: "skipped", reason: "no_business" };

    const now = opts.nowIso ?? new Date().toISOString();
    const answered = opts.outcome === "answered";
    const caller = (opts.callerE164 ?? "").trim();
    const forwardedTo = (opts.forwardedToE164 ?? "").trim();

    const row: Record<string, unknown> = {
      business_id: opts.businessId,
      call_control_id: opts.callControlId,
      call_kind: "forwarded",
      // A forwarded call is always inbound (a customer dialed the business DID
      // and we bridged them out to a human); outbound legs are AI-placed.
      direction: "inbound",
      // `model` is NOT NULL on the table; there's no AI model for a forwarded
      // call, so use a sentinel the UI can special-case.
      model: "forwarded",
      caller_e164: caller || null,
      forwarded_to_e164: forwardedTo || null,
      status: answered ? "completed" : "missed",
      started_at: opts.startedAtIso || now,
      ended_at: answered ? now : null,
      // No turns to summarize — mark terminal so the summary sweep skips it.
      summarized_at: now,
      updated_at: now
    };

    const { error } = await supabase
      .from("voice_call_transcripts")
      .upsert(row, { onConflict: "call_control_id" });
    if (error) return { status: "failed", reason: error.message };
    return { status: "recorded" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
