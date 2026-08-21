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
 * Every fixed recency window the engine reads over a PURGED table, with the
 * module that owns it. Keys are repo-relative paths; the lockstep test reads
 * each file and checks the literal still matches.
 */
export const RESIDENCY_ENGINE_LOOKBACK_WINDOWS = [
  {
    file: "supabase/functions/_shared/contact_context.ts",
    constant: "CONTACT_TIMELINE_LOOKBACK_HOURS",
    hours: 72,
    reads: "sms_outbound_log + voice_call_transcripts, into the model's prompt"
  },
  {
    file: "supabase/functions/_shared/needs_human.ts",
    constant: "NEEDS_HUMAN_REPAGE_HOURS",
    hours: 24,
    reads: "notifications, to suppress a duplicate human page"
  },
  {
    file: "supabase/functions/_shared/ai_flows/call_guards.ts",
    constant: "DEFAULT_DIAL_WINDOW_HOURS",
    hours: 24,
    reads: "voice_outbound_dial_log, the dial-cap backstop"
  }
] as const;

/**
 * Smallest keep-hours a purge may use: the widest engine window. Kept in
 * lockstep with the same literal in
 * 20260822233041_residency_purge_keep_floor_and_replay_cron_check.sql, which
 * enforces it again in the RPC because the RPC is callable without the
 * wrapper.
 */
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
