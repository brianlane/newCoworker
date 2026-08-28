import { describe, expect, it, vi } from "vitest";

/**
 * The shared coworker reply worker.
 *
 * One queue drains every channel, so this file owns the queue mechanics
 * that each channel used to carry its own copy of: the stale reclaim, the
 * bounded batch, and what happens when a job or the infrastructure under it
 * misbehaves. Channel behaviour lives in that channel's suite.
 *
 * The properties here are all about NOT LOSING WORK and NOT WEDGING THE
 * QUEUE. Both failure directions are real: a job that vanishes leaves
 * somebody's question unanswered forever, and a job that retries forever
 * sits at the head of its conversation blocking every later message in that
 * thread behind it.
 */

import { processCoworkerJobs } from "@/lib/coworker-channels/worker";
import type { CoworkerJobRow } from "@/lib/db/coworker-chat";
import type { CoworkerChannelAdapter } from "@/lib/coworker-channels/types";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

const BIZ = "11111111-1111-4111-8111-111111111111";

function job(overrides: Partial<CoworkerJobRow> = {}): CoworkerJobRow {
  return {
    id: "job-1",
    business_id: BIZ,
    channel: "slack",
    conversation_id: "conv-1",
    user_message_id: 7,
    status: "processing",
    attempts: 1,
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    completed_at: null,
    assistant_message_id: null,
    error_code: null,
    error_detail: null,
    created_at: "2026-08-28T00:00:00Z",
    ...overrides
  };
}

/** Claims the given jobs in order, then reports an empty queue. */
function claims(...queued: CoworkerJobRow[]) {
  const remaining = [...queued];
  return vi.fn(async () => remaining.shift() ?? null);
}

function adapter(
  runJob: CoworkerChannelAdapter["runJob"] = vi.fn(async () => true)
): CoworkerChannelAdapter {
  return { channel: "slack", runJob };
}

function deps(overrides: Parameters<typeof processCoworkerJobs>[0] = {}) {
  return {
    reclaim: vi.fn(async () => 0),
    claim: claims(),
    fail: vi.fn(async () => undefined),
    adapterFor: vi.fn(() => adapter()),
    ...overrides
  };
}

describe("draining the queue", () => {
  it("reclaims first, then drains, and reports the batch", async () => {
    const d = deps({
      reclaim: vi.fn(async () => 2),
      claim: claims(job({ id: "a" }), job({ id: "b" }))
    });
    expect(await processCoworkerJobs(d)).toEqual({ reclaimed: 2, processed: 2, failed: 0 });
  });

  it("counts a job that ended without answering as failed, not processed", async () => {
    // Both are normal terminal outcomes (switched-off surface, over the
    // cap), but only one of them means somebody got a reply.
    const d = deps({
      claim: claims(job()),
      adapterFor: vi.fn(() => adapter(vi.fn(async () => false)))
    });
    expect(await processCoworkerJobs(d)).toMatchObject({ processed: 0, failed: 1 });
  });

  it("stops at the batch ceiling instead of draining forever", async () => {
    // An unbounded loop on a busy queue runs past the route's maxDuration
    // and gets killed mid-turn, which is how a claimed job goes stale.
    const runJob = vi.fn(async () => true);
    const d = deps({
      claim: vi.fn(async () => job()),
      adapterFor: vi.fn(() => adapter(runJob))
    });
    const result = await processCoworkerJobs(d);
    expect(result.processed).toBe(8);
    expect(runJob).toHaveBeenCalledTimes(8);
  });

  it("serves each job to the adapter for ITS channel, not the first one", async () => {
    const adapterFor = vi.fn(() => adapter());
    await processCoworkerJobs(
      deps({
        claim: claims(job({ channel: "slack" }), job({ channel: "slack" })),
        adapterFor
      })
    );
    expect(adapterFor).toHaveBeenCalledTimes(2);
    expect(adapterFor).toHaveBeenCalledWith("slack");
  });
});

describe("nothing is lost and nothing wedges", () => {
  it("still drains when the stale reclaim is down", async () => {
    // A failed reclaim costs us wedged jobs a minute later; refusing to
    // drain over it costs every waiting reply right now.
    const d = deps({
      reclaim: vi.fn(async () => {
        throw new Error("rpc down");
      }),
      claim: claims(job())
    });
    expect(await processCoworkerJobs(d)).toEqual({ reclaimed: 0, processed: 1, failed: 0 });
  });

  it("stops the pass when claiming itself is down, rather than spinning", async () => {
    const d = deps({
      claim: vi.fn(async () => {
        throw new Error("claim down");
      })
    });
    expect(await processCoworkerJobs(d)).toEqual({ reclaimed: 0, processed: 0, failed: 0 });
  });

  it("turns a crashing job into a RETRYABLE failure", async () => {
    const fail = vi.fn(async () => undefined);
    const d = deps({
      claim: claims(job()),
      fail,
      adapterFor: vi.fn(() =>
        adapter(async () => {
          throw new Error("boom");
        })
      )
    });
    expect(await processCoworkerJobs(d)).toMatchObject({ failed: 1 });
    expect(fail).toHaveBeenCalledWith({
      jobId: "job-1",
      errorCode: "worker_crash",
      errorDetail: "boom",
      terminal: false
    });
  });

  it("stringifies a crash that was not an Error", async () => {
    const fail = vi.fn(async () => undefined);
    await processCoworkerJobs(
      deps({
        claim: claims(job()),
        fail,
        adapterFor: vi.fn(() =>
          adapter(async () => {
            throw "string blowup";
          })
        )
      })
    );
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorDetail: "string blowup" })
    );
  });

  it("keeps draining when the error-flip itself fails", async () => {
    // Otherwise one unwritable row takes the whole pass down with it.
    const d = deps({
      claim: claims(job({ id: "a" }), job({ id: "b" })),
      fail: vi.fn(async () => {
        throw new Error("also down");
      }),
      adapterFor: vi.fn(() =>
        adapter(async () => {
          throw new Error("boom");
        })
      )
    });
    expect(await processCoworkerJobs(d)).toMatchObject({ failed: 2 });
  });

  it("fails a job with no adapter TERMINALLY, and keeps going", async () => {
    // A row written by code that has since been removed, or a half-rolled
    // deploy. Retrying cannot conjure an adapter, and the claim RPC
    // serialises per conversation, so leaving it queued would block every
    // later message in that thread behind a job that can never run.
    const fail = vi.fn(async () => undefined);
    const runJob = vi.fn(async () => true);
    const d = deps({
      claim: claims(job({ id: "orphan", channel: "telegram" as never }), job({ id: "ok" })),
      fail,
      adapterFor: vi.fn((channel: string) => (channel === "slack" ? adapter(runJob) : null))
    });

    expect(await processCoworkerJobs(d)).toMatchObject({ processed: 1, failed: 1 });
    expect(fail).toHaveBeenCalledWith({
      jobId: "orphan",
      errorCode: "unknown_channel",
      errorDetail: "telegram",
      terminal: true
    });
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("survives the error-flip failing on an unknown channel too", async () => {
    const d = deps({
      claim: claims(job({ channel: "telegram" as never })),
      fail: vi.fn(async () => {
        throw new Error("down");
      }),
      adapterFor: vi.fn(() => null)
    });
    expect(await processCoworkerJobs(d)).toMatchObject({ failed: 1 });
  });
});

describe("stringifying failures that were not Errors", () => {
  it("logs a non-Error reclaim and a non-Error claim without crashing the pass", async () => {
    const d = deps({
      reclaim: vi.fn(async () => {
        throw "reclaim string";
      }),
      claim: vi.fn(async () => {
        throw "claim string";
      })
    });
    expect(await processCoworkerJobs(d)).toEqual({ reclaimed: 0, processed: 0, failed: 0 });
  });
});
