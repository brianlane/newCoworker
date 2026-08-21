/**
 * The floor under a residency purge, and the cron precondition under a mode
 * flip. Two invariants the runbook stated in prose and nothing enforced.
 *
 * THE KEEP-HOURS FLOOR. `residency_purge_business(p_business, p_keep_hours)`
 * deletes history older than the cutoff from the 8 purged tables. The engine
 * reads several of those tables over FIXED recency windows, and the widest
 * of them is exactly the purge default of 72h, leaving no margin at all.
 * Purging inside a window does not error; it just removes rows the coworker
 * was about to read, so the model answers from a shorter memory than it
 * thinks it has. The contact timeline is the sharp one: it feeds the prompt,
 * so an operator running `--keep-hours 24` truncates what the AI knows about
 * a customer in the middle of a conversation.
 *
 * The windows are declared here and pinned against the Deno sources by
 * tests/residency-keep-window.test.ts, so widening one of them fails until
 * the floor moves with it.
 *
 * THE REPLAY-CRON PRECONDITION. `edge-residency-replay` is deliberately
 * UNSCHEDULED while zero tenants use residency
 * (20260812000200_unschedule_residency_replay.sql). `dual` mode does not
 * replicate without it: the write journal grows and never drains. README
 * step 0 says to re-schedule it before flipping anyone to `dual`, but the
 * admin route offered the flip regardless.
 */

/**
 * Fixed recency windows the engine reads over a PURGED table, which the
 * floor MUST cover. Keys are repo-relative paths; the lockstep test reads
 * each file and checks the literal still matches, so widening one fails
 * until the floor moves with it.
 */
export const RESIDENCY_ENGINE_LOOKBACK_WINDOWS = [
  {
    file: "supabase/functions/_shared/contact_context.ts",
    constant: "CONTACT_TIMELINE_LOOKBACK_HOURS",
    literal: 72,
    hours: 72,
    reads: "sms_outbound_log + voice_call_transcripts, into the model's prompt"
  },
  {
    file: "supabase/functions/_shared/ai_flows/run_context.ts",
    constant: "FLOW_CONTEXT_LOOKBACK_HOURS",
    literal: 72,
    hours: 72,
    reads: "sms_outbound_log, the context behind a flow run"
  },
  {
    file: "supabase/functions/_shared/ai_flows/contact_said.ts",
    constant: "SAID_LOOKBACK_HOURS",
    literal: 72,
    hours: 72,
    reads: "voice_call_transcripts + turns, what the contact said"
  },
  {
    file: "supabase/functions/_shared/call_summary_sweep.ts",
    constant: "CALL_SUMMARY_WINDOW_HOURS",
    literal: 48,
    hours: 48,
    reads: "voice_call_transcripts, calls still awaiting a summary"
  },
  {
    file: "supabase/functions/_shared/needs_human.ts",
    constant: "NEEDS_HUMAN_REPAGE_HOURS",
    literal: 24,
    hours: 24,
    reads: "notifications, to suppress a duplicate human page"
  },
  {
    file: "supabase/functions/_shared/ai_flows/call_guards.ts",
    constant: "DEFAULT_DIAL_WINDOW_HOURS",
    literal: 24,
    hours: 24,
    reads: "voice_outbound_dial_log, the dial-cap backstop"
  }
] as const;

/**
 * Windows over a purged table that are WIDER than the floor and knowingly
 * accept truncation.
 *
 * The floor cannot simply rise to cover these. `residency_purge_business`
 * documents a default of 72 hours, so a 168h floor would make the default
 * call fail, and the runbook's own step 4 would stop working. The honest
 * answer is per window: say which ones lose data and why that is tolerable.
 *
 * Pinned by the same lockstep test, so a window cannot join or leave this
 * list silently.
 */
export const RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION = [
  {
    file: "supabase/functions/_shared/hardware_escalation.ts",
    constant: "ADVISOR_WINDOW_DAYS",
    // The source literal is in DAYS; `hours` is what the floor compares.
    literal: 7,
    hours: 7 * 24,
    reads: "voice_call_transcripts across the whole fleet",
    why:
      "internal weekly capacity advisory, not customer-facing and not billing. It projects " +
      "monthly minutes from the window, so a residency tenant purged at 72h is under-counted " +
      "and may simply not be flagged for an upgrade. Degraded advice about one tenant, against " +
      "a floor rise that would break the purge's own documented 72h default"
  }
] as const;

export const RESIDENCY_MIN_KEEP_HOURS = 72;

export class ResidencyKeepWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyKeepWindowError";
  }
}

/** Throws when a purge would cut inside a window the engine still reads. */
export function assertKeepHoursCoversEngineWindows(keepHours: number): void {
  if (Number.isInteger(keepHours) && keepHours >= RESIDENCY_MIN_KEEP_HOURS) return;
  const windows = RESIDENCY_ENGINE_LOOKBACK_WINDOWS.map(
    (w) => `${w.constant}=${w.hours}h (${w.reads})`
  ).join("; ");
  throw new ResidencyKeepWindowError(
    `keep-hours ${keepHours} is below the ${RESIDENCY_MIN_KEEP_HOURS}h engine floor. ` +
      `The coworker reads purged tables over fixed windows: ${windows}. ` +
      "Purging inside one of them does not error, it just removes rows the engine was " +
      "about to read, so the AI answers from a shorter memory than it thinks it has. " +
      "Raise keep-hours, or narrow the engine windows first."
  );
}

export class ResidencyReplayCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyReplayCronError";
  }
}

/** Minimal structural client, so callers can pass the service client as-is. */
type CronCheckClient = {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Throws unless the replay cron is scheduled and active.
 *
 * FAILS CLOSED, including when the check itself errors. Wrongly allowing the
 * flip builds a journal that grows forever and replicates nothing, which is
 * discovered late and by hand; wrongly blocking it stops a rare, deliberate
 * maintenance action with a message naming the fix. Only the second is
 * recoverable in a minute.
 */
export async function assertResidencyReplayCronScheduled(
  db: CronCheckClient,
  mode: string
): Promise<void> {
  // Turning residency OFF is always allowed: a tenant must never be wedged
  // forward, the same posture as the tier gate.
  if (mode !== "dual" && mode !== "vps") return;
  const { data, error } = await db.rpc("residency_replay_cron_active");
  if (error || data !== true) {
    throw new ResidencyReplayCronError(
      `cannot flip data residency to '${mode}': the edge-residency-replay cron is not active` +
        (error ? ` (check failed: ${error.message})` : "") +
        ". Without the replayer the write journal never drains, so 'dual' replicates nothing " +
        "and 'vps' would read a box that is missing everything written since the flip. " +
        "Run step 0 of the residency runbook (README, Data residency): re-schedule " +
        "'edge-residency-replay', then verify with " +
        "select jobname, schedule, active from cron.job where jobname = 'edge-residency-replay';"
    );
  }
}
