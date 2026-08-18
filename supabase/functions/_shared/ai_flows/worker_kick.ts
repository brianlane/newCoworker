/**
 * Start a queued run NOW instead of at the worker's next tick.
 *
 * The inbound webhook queues an ai_flow_run and returns; the worker's cron tick
 * picks it up within about a minute. That minute is invisible for a nurture
 * sequence and fatal for a lead source that withdraws the lead if nobody
 * responds: HomeLight pulls a warm transfer back within a couple of minutes, and
 * once withdrew one after three seconds.
 *
 * So a flow can opt in (`options.startImmediately`) and the webhook kicks the
 * worker in the background after queueing. The kick is deliberately weak:
 *
 *   - it is fire-and-forget, because awaiting it would make the webhook wait for
 *     the run's OWN steps (browser reads, Gemini calls) before answering Telnyx;
 *   - the request is delivered and then the client wait is abandoned, which is
 *     what keeps the webhook's own latency bounded;
 *   - a failure is not retried and not surfaced. The tick still owns the run, so
 *     the worst case is the latency this was trying to remove.
 *
 * It asks for `runsOnly`, which tells the worker to skip its periodic sweeps and
 * trigger polls and go straight to claiming. Without that, every inbound text on
 * an opted-in flow would re-run four mailbox/calendar HTTP polls and every
 * overdue sweep.
 */

/** Milliseconds to wait for the kick to be ACCEPTED before abandoning the wait. */
export const KICK_ABANDON_MS = 1500;

/** The body that tells the worker to claim runs and skip its periodic sweeps. */
export const RUNS_ONLY_BODY = JSON.stringify({ runsOnly: true });

/** Shape of the flow definitions the caller just queued runs for. */
export type KickCandidate = { options?: { startImmediately?: boolean } | null } | null;

/**
 * Whether anything just queued asked to start immediately. Pure, so the webhook
 * can decide without touching the network.
 */
export function wantsImmediateStart(defs: readonly KickCandidate[]): boolean {
  return defs.some((d) => d?.options?.startImmediately === true);
}

export type KickDeps = {
  /** Supabase project URL; the worker lives at /functions/v1/ai-flow-worker. */
  supabaseUrl: string;
  /** INTERNAL_CRON_SECRET, the worker's bearer. NOT the service-role key. */
  cronSecret: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real timer. */
  setTimeoutImpl?: typeof setTimeout;
};

/**
 * Kick the worker. Resolves `true` when the request was accepted (or abandoned
 * after delivery, which is the normal path), `false` when it could not be sent
 * at all. Never throws and never rejects: the caller is a webhook whose reply to
 * the carrier must not depend on this.
 */
export async function kickAiFlowWorker(deps: KickDeps): Promise<boolean> {
  const base = deps.supabaseUrl.trim().replace(/\/+$/, "");
  const secret = deps.cronSecret.trim();
  // Fail closed and silent: an unconfigured kick is just the old behaviour.
  if (!base || !secret) return false;
  const doFetch = deps.fetchImpl ?? fetch;
  const timer = deps.setTimeoutImpl ?? setTimeout;
  const controller = new AbortController();
  // Abandoning the wait does NOT cancel the worker: the request has already been
  // delivered, and the worker runs to completion on its own side.
  const handle = timer(() => controller.abort(), KICK_ABANDON_MS);
  try {
    await doFetch(`${base}/functions/v1/ai-flow-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`
      },
      body: RUNS_ONLY_BODY,
      signal: controller.signal
    });
    return true;
  } catch (err) {
    // An abort here is the EXPECTED outcome once the worker starts working, so
    // it is a success for our purposes: the run is already under way.
    const aborted =
      (err as { name?: string } | null)?.name === "AbortError" ||
      controller.signal.aborted;
    if (!aborted) {
      console.error("kickAiFlowWorker: could not reach the worker", err);
    }
    return aborted;
  } finally {
    clearTimeout(handle as unknown as number);
  }
}

/** Whether a worker request asked to skip the periodic sweeps. Never throws. */
export async function isRunsOnlyRequest(req: Request): Promise<boolean> {
  try {
    const text = await req.text();
    if (!text.trim()) return false;
    const parsed = JSON.parse(text) as { runsOnly?: unknown } | null;
    return parsed?.runsOnly === true;
  } catch {
    // A cron tick posts no body (or an empty one); treat anything unreadable as
    // a full tick so a malformed kick can never skip the sweeps silently.
    return false;
  }
}
