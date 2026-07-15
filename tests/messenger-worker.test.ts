/**
 * Tests for the Messenger reply worker loop (src/lib/messenger/worker.ts):
 * claim/drain batching, the 24h-window gate, display-name backfill,
 * send-then-commit ordering, transient requeue vs terminal error, and the
 * never-throw contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  MESSENGER_WORKER_BATCH_LIMIT,
  MESSENGER_WORKER_ID,
  processMessengerJobs,
  type MessengerWorkerDeps
} from "@/lib/messenger/worker";
import type {
  MessengerConversationRow,
  MessengerJobRow,
  MessengerMessageRow
} from "@/lib/messenger/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-15T20:05:00Z");

const CONVERSATION: MessengerConversationRow = {
  id: CONV_ID,
  business_id: BIZ,
  page_id: "p1",
  platform: "messenger",
  psid: "psid-1",
  display_name: "Jane",
  contact_phone: null,
  status: "active",
  last_user_message_at: "2026-07-15T20:00:00Z",
  created_at: "2026-07-15T19:00:00Z",
  updated_at: "2026-07-15T20:00:00Z"
};

function job(overrides: Partial<MessengerJobRow> = {}): MessengerJobRow {
  return {
    id: "job-1",
    business_id: BIZ,
    conversation_id: CONV_ID,
    user_message_id: 7,
    status: "processing",
    attempts: 1,
    claimed_by: MESSENGER_WORKER_ID,
    claimed_at: "2026-07-15T20:05:00Z",
    started_at: "2026-07-15T20:05:00Z",
    completed_at: null,
    assistant_message_id: null,
    error_code: null,
    error_detail: null,
    created_at: "2026-07-15T20:04:00Z",
    ...overrides
  };
}

const HISTORY: MessengerMessageRow[] = [
  {
    id: 7,
    conversation_id: CONV_ID,
    business_id: BIZ,
    role: "user",
    content: "Hi!",
    mid: "m-7",
    created_at: "2026-07-15T20:00:00Z"
  },
  {
    id: 9,
    conversation_id: CONV_ID,
    business_id: BIZ,
    role: "user",
    content: "Anyone there?",
    mid: "m-9",
    created_at: "2026-07-15T20:01:00Z"
  }
];

const CONNECTION = {
  business_id: BIZ,
  page_id: "p1",
  pageToken: "page-tok"
} as never;

function makeDeps(
  overrides: Partial<MessengerWorkerDeps> = {}
): Required<Omit<MessengerWorkerDeps, "now">> & { now: () => Date } {
  return {
    reclaimStale: vi.fn(async () => 0),
    claimJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(null),
    getConversation: vi.fn(async () => CONVERSATION),
    listMessages: vi.fn(async () => HISTORY),
    getConnection: vi.fn(async () => CONNECTION),
    fetchTier: vi.fn(async () => "standard" as const),
    fetchProfileName: vi.fn(async () => ({ name: "Jane Profile" })),
    updateContact: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => ({
      reply: "Happy to help!",
      refusedOverCap: false,
      toolRounds: 0
    })),
    send: vi.fn(async () => ({ messageId: "mid-out" })),
    complete: vi.fn(async () => 11),
    fail: vi.fn(async () => undefined),
    requeue: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processMessengerJobs", () => {
  it("claims, runs the turn, sends, and commits with the history max id", async () => {
    const deps = makeDeps();
    const summary = await processMessengerJobs({}, deps);
    expect(summary).toEqual({ requeued: 0, claimed: 1, replied: 1, failed: 0 });

    expect(deps.claimJob).toHaveBeenCalledWith(MESSENGER_WORKER_ID);
    expect(deps.runTurn).toHaveBeenCalledWith({
      businessId: BIZ,
      conversation: CONVERSATION,
      history: HISTORY,
      tier: "standard"
    });
    expect(deps.send).toHaveBeenCalledWith("p1", "page-tok", "psid-1", "Happy to help!");
    // Send happens BEFORE commit; commit covers the newest history row (9).
    expect(vi.mocked(deps.send).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.complete).mock.invocationCallOrder[0]
    );
    expect(deps.complete).toHaveBeenCalledWith("job-1", "Happy to help!", 9);
    // Known display name → no profile lookup.
    expect(deps.fetchProfileName).not.toHaveBeenCalled();
  });

  it("drains until the claim returns null, bounded by the batch limit", async () => {
    const jobs = Array.from({ length: MESSENGER_WORKER_BATCH_LIMIT + 2 }, (_, i) =>
      job({ id: `job-${i}` })
    );
    const claimJob = vi.fn(async () => jobs.shift() ?? null);
    const deps = makeDeps({ claimJob });
    const summary = await processMessengerJobs({}, deps);
    expect(summary.claimed).toBe(MESSENGER_WORKER_BATCH_LIMIT);
    expect(claimJob).toHaveBeenCalledTimes(MESSENGER_WORKER_BATCH_LIMIT);
  });

  it("backfills the display name (and tolerates the merge failing)", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () => ({ ...CONVERSATION, display_name: null }))
    });
    await processMessengerJobs({}, deps);
    expect(deps.fetchProfileName).toHaveBeenCalledWith("page-tok", "psid-1", "messenger");
    expect(deps.updateContact).toHaveBeenCalledWith(CONV_ID, { name: "Jane Profile" });
    const turnArg = vi.mocked(deps.runTurn).mock.calls[0][0];
    expect(turnArg.conversation.display_name).toBe("Jane Profile");

    // Merge failure: the turn still runs with the original row.
    const deps2 = makeDeps({
      getConversation: vi.fn(async () => ({ ...CONVERSATION, display_name: null })),
      updateContact: vi.fn(async () => {
        throw new Error("merge fail");
      })
    });
    const summary2 = await processMessengerJobs({}, deps2);
    expect(summary2.replied).toBe(1);
    expect(vi.mocked(deps2.runTurn).mock.calls[0][0].conversation.display_name).toBeNull();

    // No profile name found: no merge attempted.
    const deps3 = makeDeps({
      getConversation: vi.fn(async () => ({ ...CONVERSATION, display_name: null })),
      fetchProfileName: vi.fn(async () => ({ name: null }))
    });
    await processMessengerJobs({}, deps3);
    expect(deps3.updateContact).not.toHaveBeenCalled();
  });

  it("errors terminal conditions: missing conversation, closed window, no connection", async () => {
    const missing = makeDeps({ getConversation: vi.fn(async () => null) });
    expect(await processMessengerJobs({}, missing)).toMatchObject({ failed: 1, replied: 0 });
    expect(missing.fail).toHaveBeenCalledWith(
      "job-1",
      "conversation_missing",
      CONV_ID,
      "2026-07-15T20:05:00Z"
    );

    const stale = makeDeps({
      getConversation: vi.fn(async () => ({
        ...CONVERSATION,
        last_user_message_at: "2026-07-10T00:00:00Z"
      }))
    });
    await processMessengerJobs({}, stale);
    expect(stale.fail).toHaveBeenCalledWith(
      "job-1",
      "window_expired",
      "2026-07-10T00:00:00Z",
      "2026-07-15T20:05:00Z"
    );
    expect(stale.send).not.toHaveBeenCalled();

    const disconnected = makeDeps({ getConnection: vi.fn(async () => null) });
    await processMessengerJobs({}, disconnected);
    expect(disconnected.fail).toHaveBeenCalledWith(
      "job-1",
      "not_connected",
      "p1",
      "2026-07-15T20:05:00Z"
    );
  });

  it("requeues transient turn/send failures while attempts remain; errors at the cap", async () => {
    const deps = makeDeps({
      runTurn: vi.fn(async () => {
        throw new Error("gemini 500");
      })
    });
    const summary = await processMessengerJobs({}, deps);
    expect(summary).toMatchObject({ failed: 1, replied: 0 });
    expect(deps.requeue).toHaveBeenCalledWith("job-1", "2026-07-15T20:05:00Z");
    expect(deps.fail).not.toHaveBeenCalled();

    // Final attempt: sticks as an error.
    const final = makeDeps({
      claimJob: vi.fn().mockResolvedValueOnce(job({ attempts: 3 })).mockResolvedValue(null),
      send: vi.fn(async () => {
        throw "send string failure";
      })
    });
    await processMessengerJobs({}, final);
    expect(final.fail).toHaveBeenCalledWith(
      "job-1",
      "turn_failed",
      "send string failure",
      "2026-07-15T20:05:00Z"
    );

    // Requeue itself failing is logged, not thrown.
    const requeueBroken = makeDeps({
      runTurn: vi.fn(async () => {
        throw new Error("gemini 500");
      }),
      requeue: vi.fn(async () => {
        throw new Error("requeue fail");
      })
    });
    await expect(processMessengerJobs({}, requeueBroken)).resolves.toBeTruthy();
  });

  it("flips the job to a terminal error when the commit fails AFTER the send", async () => {
    // The reply already reached the lead — leaving the job 'processing'
    // would let the stale reclaim retry the turn and double-send.
    const deps = makeDeps({
      complete: vi.fn(async () => {
        throw new Error("commit fail");
      })
    });
    const summary = await processMessengerJobs({}, deps);
    expect(summary).toMatchObject({ claimed: 1, replied: 0, failed: 1 });
    expect(deps.fail).toHaveBeenCalledWith(
      "job-1",
      "commit_failed_after_send",
      "commit fail",
      "2026-07-15T20:05:00Z"
    );
    expect(deps.requeue).not.toHaveBeenCalled();

    // Non-Error commit failures flip the same way.
    const stringy = makeDeps({
      complete: vi.fn(async () => {
        throw "commit string fail";
      })
    });
    await processMessengerJobs({}, stringy);
    expect(stringy.fail).toHaveBeenCalledWith(
      "job-1",
      "commit_failed_after_send",
      "commit string fail",
      "2026-07-15T20:05:00Z"
    );
  });

  it("fails no-input and no-key turns terminally instead of burning retries", async () => {
    const noInput = makeDeps({
      runTurn: vi.fn(async () => {
        throw new Error("messenger_engine_no_input");
      })
    });
    const summary = await processMessengerJobs({}, noInput);
    expect(summary).toMatchObject({ failed: 1, replied: 0 });
    expect(noInput.fail).toHaveBeenCalledWith(
      "job-1",
      "no_input",
      "messenger_engine_no_input",
      "2026-07-15T20:05:00Z"
    );
    expect(noInput.requeue).not.toHaveBeenCalled();
    expect(noInput.send).not.toHaveBeenCalled();

    const noKey = makeDeps({
      runTurn: vi.fn(async () => {
        throw new Error("messenger_engine_no_key");
      })
    });
    await processMessengerJobs({}, noKey);
    expect(noKey.fail).toHaveBeenCalledWith(
      "job-1",
      "no_api_key",
      "messenger_engine_no_key",
      "2026-07-15T20:05:00Z"
    );
    expect(noKey.requeue).not.toHaveBeenCalled();
  });

  it("tolerates a failing error-flip and a failing stale reclaim", async () => {
    const deps = makeDeps({
      reclaimStale: vi.fn(async () => {
        throw new Error("reclaim down");
      }),
      getConversation: vi.fn(async () => null),
      fail: vi.fn(async () => {
        throw "flip string failure";
      })
    });
    const summary = await processMessengerJobs({}, deps);
    expect(summary.failed).toBe(1);

    // Non-Error reclaim failures too.
    const deps2 = makeDeps({
      reclaimStale: vi.fn(async () => {
        throw "reclaim string failure";
      })
    });
    expect((await processMessengerJobs({}, deps2)).replied).toBe(1);
  });

  it("stops the batch when the claim itself fails, and honors a custom limit", async () => {
    const deps = makeDeps({
      claimJob: vi.fn(async () => {
        throw new Error("claim down");
      })
    });
    const summary = await processMessengerJobs({}, deps);
    expect(summary).toEqual({ requeued: 0, claimed: 0, replied: 0, failed: 0 });

    const limited = makeDeps({
      claimJob: vi.fn(async () => job())
    });
    const summary2 = await processMessengerJobs({ limit: 2 }, limited);
    expect(summary2.claimed).toBe(2);
  });

  it("logs non-Error throw shapes in every degradation path", async () => {
    // Display-name merge failing with a string.
    const merge = makeDeps({
      getConversation: vi.fn(async () => ({ ...CONVERSATION, display_name: null })),
      updateContact: vi.fn(async () => {
        throw "merge string failure";
      })
    });
    expect((await processMessengerJobs({}, merge)).replied).toBe(1);

    // Requeue failing with a string.
    const requeue = makeDeps({
      runTurn: vi.fn(async () => {
        throw new Error("gemini 500");
      }),
      requeue: vi.fn(async () => {
        throw "requeue string failure";
      })
    });
    expect((await processMessengerJobs({}, requeue)).failed).toBe(1);

    // Error-flip failing with an Error on a terminal condition.
    const flip = makeDeps({
      getConversation: vi.fn(async () => null),
      fail: vi.fn(async () => {
        throw new Error("flip fail");
      })
    });
    expect((await processMessengerJobs({}, flip)).failed).toBe(1);

    // Claim failing with a non-Error stops the batch safely.
    const claim = makeDeps({
      claimJob: vi.fn(async () => {
        throw "claim string failure";
      })
    });
    expect((await processMessengerJobs({}, claim)).claimed).toBe(0);
  });

  it("uses now() when the claimed job carries no claimed_at, and reports requeued count", async () => {
    const deps = makeDeps({
      reclaimStale: vi.fn(async () => 4),
      claimJob: vi
        .fn()
        .mockResolvedValueOnce(job({ claimed_at: null }))
        .mockResolvedValue(null),
      getConversation: vi.fn(async () => null)
    });
    const summary = await processMessengerJobs({}, deps);
    expect(summary.requeued).toBe(4);
    expect(deps.fail).toHaveBeenCalledWith(
      "job-1",
      "conversation_missing",
      CONV_ID,
      NOW.toISOString()
    );
  });
});
