/**
 * One reply worker for every coworker channel.
 *
 * Claims from the shared `coworker_jobs` queue, hands each job to its
 * channel's adapter, and owns the parts that were identical in every copy of
 * this loop: the stale reclaim, the bounded batch, and turning an unexpected
 * throw into a retryable failure instead of a lost job.
 *
 * ONE QUEUE, NOT ONE PER CHANNEL, and that is the point. The claim RPC
 * serialises per conversation and orders by age across all channels, so a
 * busy Slack workspace cannot starve a Telegram thread the way two
 * independent workers on independent cron schedules would. It also means one
 * sweep, one cron entry, and one watchdog expectation rather than N of each,
 * which is the difference between adding a channel and adding a channel plus
 * four pieces of infrastructure.
 *
 * A job whose channel has no registered adapter fails TERMINALLY. That state
 * means a row was written by code that has since been removed, or a deploy
 * is half-rolled; retrying it forever would keep a permanently unrunnable
 * job at the head of its conversation and block every later message in that
 * thread behind it.
 */

import {
  claimCoworkerJob,
  failCoworkerJob,
  reclaimStaleCoworkerJobs,
  type CoworkerJobRow
} from "@/lib/db/coworker-chat";
import { coworkerAdapterFor } from "./registry";
import { logger } from "@/lib/logger";

/** Claim ceiling per pass; the inline kick handles the common case. */
const MAX_JOBS_PER_RUN = 8;

export type CoworkerWorkerResult = {
  reclaimed: number;
  processed: number;
  failed: number;
};

export type CoworkerWorkerDeps = {
  reclaim?: typeof reclaimStaleCoworkerJobs;
  claim?: typeof claimCoworkerJob;
  fail?: typeof failCoworkerJob;
  adapterFor?: typeof coworkerAdapterFor;
};

export async function processCoworkerJobs(
  deps: CoworkerWorkerDeps = {}
): Promise<CoworkerWorkerResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const reclaim = deps.reclaim ?? reclaimStaleCoworkerJobs;
  const claim = deps.claim ?? claimCoworkerJob;
  const fail = deps.fail ?? failCoworkerJob;
  const adapterFor = deps.adapterFor ?? coworkerAdapterFor;
  /* c8 ignore stop */

  const workerId = `coworker-worker-${Math.random().toString(36).slice(2, 10)}`;
  let reclaimed = 0;
  try {
    reclaimed = await reclaim();
  } catch (err) {
    // Best effort. A reclaim that fails costs us wedged jobs a minute
    // later; refusing to drain the queue over it costs every waiting reply.
    logger.warn("coworker-worker: stale reclaim failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < MAX_JOBS_PER_RUN; i += 1) {
    let job: CoworkerJobRow | null;
    try {
      job = await claim(workerId);
    } catch (err) {
      logger.error("coworker-worker: claim failed", {
        error: err instanceof Error ? err.message : String(err)
      });
      break;
    }
    if (!job) break;

    const adapter = adapterFor(job.channel);
    if (!adapter) {
      failed += 1;
      logger.error("coworker-worker: no adapter for channel", {
        jobId: job.id,
        channel: job.channel
      });
      await fail({
        jobId: job.id,
        errorCode: "unknown_channel",
        errorDetail: job.channel,
        // Terminal: a retry cannot conjure an adapter, and this job sits at
        // the head of its conversation blocking every later message.
        terminal: true
      }).catch(() => undefined);
      continue;
    }

    try {
      const answered = await adapter.runJob(job);
      if (answered) processed += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error("coworker-worker: job crashed", {
        jobId: job.id,
        channel: job.channel,
        error: err instanceof Error ? err.message : String(err)
      });
      await fail({
        jobId: job.id,
        errorCode: "worker_crash",
        errorDetail: err instanceof Error ? err.message : String(err),
        terminal: false
      }).catch(() => undefined);
    }
  }
  return { reclaimed, processed, failed };
}
