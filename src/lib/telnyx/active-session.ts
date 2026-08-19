/**
 * Shared "is this voice session actually live?" classifier.
 *
 * `voice_active_sessions` is the bridge's own record of a media stream: a row
 * is upserted when audio starts, `last_seen_at` is heartbeated every ~15s
 * while frames flow, and `ended_at` is stamped when the WebSocket closes.
 * Anything that wants to know "is a call in progress on this tenant right
 * now?" reads that table, and today the only reader is
 * `debug/redeploy-voice-bridge.ts`, which refuses to recreate a container
 * while a caller is mid-sentence.
 *
 * Reading `ended_at is null` alone is not enough. If a bridge is SIGKILLed
 * (OOM, host reboot, `docker rm -f`) the close handler never runs, so the row
 * keeps `ended_at = null` forever. The 5-minute maintenance sweep normally
 * reaps those, but a sweep that is broken or paused leaves a permanent
 * "call in progress" that blocks that tenant's redeploys with no error: the
 * failure looks exactly like the safety check doing its job.
 *
 * So liveness carries an age ceiling. A session whose last heartbeat is older
 * than {@link VOICE_SESSION_MAX_AGE_MS} is classified `"stale"`, not `"live"`,
 * because no real call runs that long. Callers surface stale rows as a warning
 * and keep going, instead of blocking forever on a leak.
 *
 * `now` is injectable so tests stay deterministic.
 */

/**
 * How long an unended session can go without a heartbeat before we stop
 * believing it is a live call.
 *
 * Deliberately far above the two thresholds that bound a real session: the
 * bridge heartbeats `last_seen_at` every 15 seconds, and
 * `voice_sweep_zombie_active_sessions` already declares a session dead after
 * 15 minutes of silence. Two hours is 8x the sweep's window, so this ceiling
 * can only ever fire on rows the sweep should have removed and did not. It
 * errs toward "still live" (skip the redeploy) for anything ambiguous.
 */
export const VOICE_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The `voice_active_sessions` columns liveness depends on. */
export type VoiceSessionRow = {
  call_control_id: string;
  /** Set by the bridge's WS close handler; non-null means the call finished. */
  ended_at?: string | null;
  /** Heartbeated every ~15s while media flows. */
  last_seen_at?: string | null;
  /** Fallback age signal when the first heartbeat never landed. */
  media_started_at?: string | null;
};

/**
 * - `"live"`, unended and heartbeating; a caller is on the line.
 * - `"ended"`, the bridge stamped `ended_at`; the call is over.
 * - `"stale"`, unended but silent past the ceiling; a leaked row, not a call.
 */
export type VoiceSessionLiveness = "live" | "ended" | "stale";

/**
 * Most recent credible activity timestamp for a session, in epoch ms.
 *
 * `last_seen_at` is the real heartbeat, but a row whose stream died before the
 * first heartbeat write only has `media_started_at`. Take the later of the two
 * so a corrupt or missing heartbeat can never make a fresh session look
 * ancient. Returns `null` when neither column parses, which callers treat as
 * "cannot tell" rather than "stale".
 */
function lastActivityMs(row: VoiceSessionRow): number | null {
  const stamps = [row.last_seen_at, row.media_started_at]
    .map((v) => (v ? new Date(v).getTime() : Number.NaN))
    .filter((n) => !Number.isNaN(n));
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

export function classifyVoiceSession(
  row: VoiceSessionRow,
  now: Date = new Date(),
  maxAgeMs: number = VOICE_SESSION_MAX_AGE_MS
): VoiceSessionLiveness {
  if (row.ended_at) return "ended";
  const activity = lastActivityMs(row);
  // No usable timestamp at all: treat as live. "We cannot tell" must not be
  // silently downgraded to "safe to drop this caller's call".
  if (activity === null) return "live";
  return now.getTime() - activity < maxAgeMs ? "live" : "stale";
}

/**
 * Split a tenant's session rows into the ones that block a disruptive action
 * and the ones that are merely leaked.
 *
 * Callers act on `live` (skip the box) and report `stale` (warn, proceed), so
 * a future leak degrades to noise in the log instead of a permanent block.
 */
export function partitionVoiceSessions(
  rows: readonly VoiceSessionRow[],
  now: Date = new Date(),
  maxAgeMs: number = VOICE_SESSION_MAX_AGE_MS
): { live: VoiceSessionRow[]; stale: VoiceSessionRow[] } {
  const live: VoiceSessionRow[] = [];
  const stale: VoiceSessionRow[] = [];
  for (const row of rows) {
    const state = classifyVoiceSession(row, now, maxAgeMs);
    if (state === "live") live.push(row);
    else if (state === "stale") stale.push(row);
  }
  return { live, stale };
}
