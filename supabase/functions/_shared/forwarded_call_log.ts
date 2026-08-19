/**
 * Record a forwarded / transferred call in Call history.
 *
 * Call history reads `voice_call_transcripts`, which the VPS voice bridge writes
 * ONLY for AI-handled calls. Calls the routing layer transfers/forwards straight
 * to a human, per-caller transfer rules (e.g. Clever's Live-Transfer line →
 * Dave), voice-AiFlow `transfer`/`handoff`, safe-mode forwards, never engage the
 * bridge, so without this they never appear in the log.
 *
 * telnyx-voice-call-end knows each forwarded call's final outcome, so it calls
 * this at the same points it fires warm-transfer SMS notifications:
 *   - a human answered  → outcome 'answered' → status 'completed'
 *   - rang out / no-answer → outcome 'missed'   → status 'missed'
 *
 * The row carries no transcript turns (there was no AI conversation) and is
 * written with `summarized_at` set so the call-summary sweep never dispatches it.
 * Keyed on the unique `call_control_id`, so the same call is one row no matter
 * how many webhook deliveries land. Outcome precedence is answered > missed:
 *   - 'answered' UPSERTS (overwrites), so it supersedes an earlier 'missed'
 *     from a reordered webhook and refreshes ended_at on the final hangup.
 *   - 'missed' is INSERT-ONLY (ignoreDuplicates): it can never downgrade an
 *     answered row. The Telnyx wt hangup can carry a non-normal_clearing cause
 *     even after the human answered (call.bridged fired), without this the
 *     hangup would flip a completed call to missed. A blocked missed insert
 *     returns 'superseded' so the caller skips the missed-call follow-ups.
 *
 * Best-effort by contract: NEVER throws, recording a call for the log must never
 * break live call routing. Dependency-injected (structural supabase type) so it
 * is unit-tested from vitest under the shared 100% coverage gate.
 */

type Rows = { data: unknown[] | null; error: { message: string } | null };
type Row = { data: unknown; error: { message: string } | null };

/**
 * The sentinel this module writes into the NOT NULL `model` column. Its other
 * job is to identify our own rows: anything else in that column means the
 * voice bridge wrote the row for a call the AI actually handled.
 */
const FORWARDED_MODEL = "forwarded";

type ExistingTranscript = {
  model?: string | null;
  status?: string | null;
};

export interface ForwardedCallLogSupabase {
  from(table: string): {
    upsert(
      values: Record<string, unknown>,
      opts: { onConflict: string; ignoreDuplicates?: boolean }
    ): { select(columns: string): PromiseLike<Rows> };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): { select(columns: string): PromiseLike<Rows> };
    };
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<Row> };
    };
  };
}

export type ForwardedCallOutcome = "answered" | "missed";

export type ForwardedCallLogResult = {
  /** superseded = missed blocked by an existing (answered) row for this call. */
  status: "recorded" | "superseded" | "skipped" | "failed";
  /** no_call | no_business | <db error>. Unset on "recorded"/"superseded". */
  reason?: string;
};

/**
 * Record a forwarded-call row. `answered` maps to status 'completed' and
 * stamps ended_at (the leg is over by the time we know the outcome); `missed`
 * maps to status 'missed' with no ended_at (nobody ever picked up). See the
 * module docstring for the answered-over-missed precedence semantics.
 */
/**
 * The existing row for this call, or null when there is none (or when the read
 * itself failed).
 *
 * A failed read deliberately reports "no row", which sends the caller down the
 * upsert path it used before this check existed. The alternative, skipping the
 * write, would permanently drop a plain forwarded call out of Call history, and
 * that is both the common case and unrecoverable; an overwrite needs a failed
 * read AND an AI-handled call, and only costs fields a backfill can restore.
 */
async function readExistingTranscript(
  supabase: ForwardedCallLogSupabase,
  callControlId: string
): Promise<ExistingTranscript | null> {
  try {
    const { data, error } = await supabase
      .from("voice_call_transcripts")
      .select("model, status")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    if (error) return null;
    return (data as ExistingTranscript | null) ?? null;
  } catch {
    return null;
  }
}

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

    // An AI-handled call that was then warm-transferred already HAS a row,
    // written by the voice bridge, carrying the real model, the real direction,
    // and the transcript turns. The answered upsert below replaces a whole row,
    // so running it here would relabel an outbound AI call as incoming, drop
    // the model id, and stamp `summarized_at` so the summary sweep skips a call
    // that has plenty to summarize (Amy Laidlaw, call 5634b7f0, 2026-08-18).
    // Patch the forwarded facts onto that row instead.
    if (answered) {
      const existing = await readExistingTranscript(supabase, opts.callControlId);
      if (existing && existing.model !== FORWARDED_MODEL) {
        const patch: Record<string, unknown> = {
          call_kind: "forwarded",
          forwarded_to_e164: forwardedTo || null,
          // The hangup is the true end of the CALL. The bridge's teardown stamp
          // predates it by however long the AI stayed on (an interpreted call
          // runs through the whole human conversation), so refreshing this is
          // what makes the dashboard's duration right.
          ended_at: now,
          updated_at: now
        };
        // 'in_progress' means the bridge never finalized; a human answered, so
        // the call is over. An 'errored' session stays errored: a human picking
        // up afterwards does not make the AI's failure untrue.
        if (existing.status === "in_progress") patch.status = "completed";
        const { error } = await supabase
          .from("voice_call_transcripts")
          .update(patch)
          .eq("call_control_id", opts.callControlId)
          .select("call_control_id");
        if (error) return { status: "failed", reason: error.message };
        return { status: "recorded" };
      }
    }

    const row: Record<string, unknown> = {
      business_id: opts.businessId,
      call_control_id: opts.callControlId,
      call_kind: "forwarded",
      // A forwarded call is always inbound (a customer dialed the business DID
      // and we bridged them out to a human); outbound legs are AI-placed.
      direction: "inbound",
      // `model` is NOT NULL on the table; there's no AI model for a forwarded
      // call, so use a sentinel the UI can special-case.
      model: FORWARDED_MODEL,
      caller_e164: caller || null,
      forwarded_to_e164: forwardedTo || null,
      status: answered ? "completed" : "missed",
      started_at: opts.startedAtIso || now,
      ended_at: answered ? now : null,
      // No turns to summarize, mark terminal so the summary sweep skips it.
      summarized_at: now,
      updated_at: now
    };

    // answered: overwrite (supersedes an earlier missed, refreshes ended_at).
    // missed: insert-only, never downgrade an existing (answered) row; the
    // returned rows tell us whether the insert actually landed.
    const { data, error } = await supabase
      .from("voice_call_transcripts")
      .upsert(row, { onConflict: "call_control_id", ignoreDuplicates: !answered })
      .select("call_control_id");
    if (error) return { status: "failed", reason: error.message };
    if (!answered && (data ?? []).length === 0) return { status: "superseded" };
    return { status: "recorded" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
