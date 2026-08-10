/**
 * Tests for the Slack chat store (src/lib/db/slack-chat.ts). What matters:
 * the event-id dedupe returns null (redelivery ≠ error), the conversation
 * find-or-create survives its unique-scope race, and job failure is
 * terminal vs retryable exactly as asked.
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  claimSlackJob,
  completeSlackJob,
  failSlackJob,
  getOrCreateSlackConversation,
  getSlackConversationById,
  insertSlackUserMessage,
  listSlackMessages,
  markSlackHelloSent,
  reclaimStaleSlackJobs,
  updateSlackConversationIdentity
} from "@/lib/db/slack-chat";

const BIZ = "11111111-1111-4111-8111-111111111111";

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

function chain(terminal: QueryResult) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "is", "order", "limit"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn(async () => terminal);
  c.maybeSingle = vi.fn(async () => terminal);
  c.then = (resolve: (v: QueryResult) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as never;
}

function makeDb(chains: unknown[], rpcResults: QueryResult[] = []) {
  const from = vi.fn();
  for (const c of chains) from.mockReturnValueOnce(c);
  const rpc = vi.fn();
  for (const r of rpcResults) rpc.mockResolvedValueOnce(r);
  return { from, rpc } as never;
}

const CONV = {
  id: "conv-1",
  business_id: BIZ,
  team_id: "T-1",
  channel_id: "D-1",
  thread_ts: null,
  slack_user_id: "U-1"
};

const INPUT = {
  businessId: BIZ,
  teamId: "T-1",
  channelId: "D-1",
  threadTs: null as string | null,
  slackUserId: "U-1"
};

describe("getOrCreateSlackConversation", () => {
  it("returns an existing conversation without inserting", async () => {
    const db = makeDb([chain({ data: CONV, error: null })]);
    expect((await getOrCreateSlackConversation(INPUT, db)).id).toBe("conv-1");
  });

  it("creates when absent (null-thread and threaded variants)", async () => {
    const db = makeDb([chain({ data: null, error: null }), chain({ data: CONV, error: null })]);
    expect((await getOrCreateSlackConversation(INPUT, db)).id).toBe("conv-1");

    const threaded = makeDb([
      chain({ data: null, error: null }),
      chain({ data: { ...CONV, thread_ts: "9.9" }, error: null })
    ]);
    expect(
      (await getOrCreateSlackConversation({ ...INPUT, threadTs: "9.9" }, threaded)).id
    ).toBe("conv-1");
  });

  it("re-reads on the unique-scope race, for both thread shapes", async () => {
    const db = makeDb([
      chain({ data: null, error: null }),
      chain({ data: null, error: { message: "dup", code: "23505" } }),
      chain({ data: CONV, error: null })
    ]);
    expect((await getOrCreateSlackConversation(INPUT, db)).id).toBe("conv-1");

    const threaded = makeDb([
      chain({ data: null, error: null }),
      chain({ data: null, error: { message: "dup", code: "23505" } }),
      chain({ data: { ...CONV, thread_ts: "9.9" }, error: null })
    ]);
    expect(
      (await getOrCreateSlackConversation({ ...INPUT, threadTs: "9.9" }, threaded)).id
    ).toBe("conv-1");
  });

  it("throws on read errors, insert errors, and a race re-read that finds nothing", async () => {
    await expect(
      getOrCreateSlackConversation(INPUT, makeDb([chain({ data: null, error: { message: "r" } })]))
    ).rejects.toThrow(/getOrCreateSlackConversation: r/);
    await expect(
      getOrCreateSlackConversation(
        INPUT,
        makeDb([chain({ data: null, error: null }), chain({ data: null, error: { message: "i" } })])
      )
    ).rejects.toThrow(/getOrCreateSlackConversation: i/);
    await expect(
      getOrCreateSlackConversation(
        INPUT,
        makeDb([
          chain({ data: null, error: null }),
          chain({ data: null, error: { message: "dup", code: "23505" } }),
          chain({ data: null, error: null })
        ])
      )
    ).rejects.toThrow(/race re-read found nothing/);
  });

  it("falls back to the default service client", async () => {
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: CONV, error: null })]));
    expect((await getOrCreateSlackConversation(INPUT)).id).toBe("conv-1");
  });
});

describe("updateSlackConversationIdentity", () => {
  it("caches the verdict and throws on errors", async () => {
    const c = chain({ data: null, error: null });
    await updateSlackConversationIdentity(
      "conv-1",
      { displayName: "Amy", email: "a@x.co", isOwner: true },
      makeDb([c])
    );
    expect((c as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ user_email: "a@x.co", is_owner: true })
    );
    await expect(
      updateSlackConversationIdentity(
        "conv-1",
        { displayName: null, email: null, isOwner: false },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/updateSlackConversationIdentity: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    await updateSlackConversationIdentity("conv-1", {
      displayName: null,
      email: null,
      isOwner: false
    });
  });
});

describe("insertSlackUserMessage", () => {
  const MSG_INPUT = {
    conversationId: "conv-1",
    businessId: BIZ,
    content: "hi",
    slackEventId: "Ev-1",
    slackTs: "1.1"
  };

  it("stores message + job + bumps the conversation", async () => {
    const db = makeDb([
      chain({ data: { id: 7 }, error: null }),
      chain({ data: { id: "job-1" }, error: null }),
      chain({ data: null, error: null })
    ]);
    expect(await insertSlackUserMessage(MSG_INPUT, db)).toEqual({ messageId: 7, jobId: "job-1" });
  });

  it("returns null on the event-id dedupe and throws on real failures", async () => {
    expect(
      await insertSlackUserMessage(
        MSG_INPUT,
        makeDb([chain({ data: null, error: { message: "dup", code: "23505" } })])
      )
    ).toBeNull();

    await expect(
      insertSlackUserMessage(MSG_INPUT, makeDb([chain({ data: null, error: { message: "m" } })]))
    ).rejects.toThrow(/insertSlackUserMessage: m/);
    await expect(
      insertSlackUserMessage(
        MSG_INPUT,
        makeDb([
          chain({ data: { id: 7 }, error: null }),
          chain({ data: null, error: { message: "j" } })
        ])
      )
    ).rejects.toThrow(/insertSlackUserMessage: j/);
    await expect(
      insertSlackUserMessage(
        MSG_INPUT,
        makeDb([
          chain({ data: { id: 7 }, error: null }),
          chain({ data: { id: "job-1" }, error: null }),
          chain({ data: null, error: { message: "b" } })
        ])
      )
    ).rejects.toThrow(/insertSlackUserMessage: b/);
    defaultClientSpy.mockReturnValueOnce(
      makeDb([
        chain({ data: { id: 7 }, error: null }),
        chain({ data: { id: "job-1" }, error: null }),
        chain({ data: null, error: null })
      ])
    );
    expect(await insertSlackUserMessage(MSG_INPUT)).toEqual({ messageId: 7, jobId: "job-1" });
  });
});

describe("job primitives", () => {
  it("claims 0 or 1 rows via RPC and throws on errors", async () => {
    expect(
      await claimSlackJob("w1", makeDb([], [{ data: [{ id: "job-1" }], error: null }]))
    ).toMatchObject({ id: "job-1" });
    expect(await claimSlackJob("w1", makeDb([], [{ data: [], error: null }]))).toBeNull();
    expect(await claimSlackJob("w1", makeDb([], [{ data: null, error: null }]))).toBeNull();
    await expect(
      claimSlackJob("w1", makeDb([], [{ data: null, error: { message: "c" } }]))
    ).rejects.toThrow(/claimSlackJob: c/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: [], error: null }]));
    expect(await claimSlackJob("w1")).toBeNull();
  });

  it("completes via RPC and throws on errors", async () => {
    const db = makeDb([], [{ data: 9, error: null }]);
    await completeSlackJob(
      { jobId: "job-1", content: "done", historyMaxMessageId: 7, slackTs: "2.2" },
      db
    );
    expect((db as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "slack_job_complete",
      expect.objectContaining({ p_job_id: "job-1", p_history_max_message_id: 7 })
    );
    await expect(
      completeSlackJob(
        { jobId: "job-1", content: "x", historyMaxMessageId: 0, slackTs: null },
        makeDb([], [{ data: null, error: { message: "e" } }])
      )
    ).rejects.toThrow(/completeSlackJob: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: 9, error: null }]));
    await completeSlackJob({ jobId: "j", content: "x", historyMaxMessageId: 0, slackTs: null });
  });

  it("fails terminal vs retryable and throws on errors", async () => {
    const terminal = chain({ data: null, error: null });
    await failSlackJob(
      { jobId: "job-1", errorCode: "tier_blocked", terminal: true },
      makeDb([terminal])
    );
    expect((terminal as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", error_code: "tier_blocked" })
    );

    const retry = chain({ data: null, error: null });
    await failSlackJob(
      { jobId: "job-1", errorCode: "post_failed", errorDetail: "d", terminal: false },
      makeDb([retry])
    );
    expect((retry as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", error_detail: "d" })
    );

    await expect(
      failSlackJob(
        { jobId: "j", errorCode: "x", terminal: false },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/failSlackJob: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    await failSlackJob({ jobId: "j", errorCode: "x", terminal: true });
  });

  it("reclaims via RPC with a numeric result and throws on errors", async () => {
    expect(await reclaimStaleSlackJobs(makeDb([], [{ data: 3, error: null }]))).toBe(3);
    expect(await reclaimStaleSlackJobs(makeDb([], [{ data: null, error: null }]))).toBe(0);
    await expect(
      reclaimStaleSlackJobs(makeDb([], [{ data: null, error: { message: "e" } }]))
    ).rejects.toThrow(/reclaimStaleSlackJobs: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: 1, error: null }]));
    expect(await reclaimStaleSlackJobs()).toBe(1);
  });
});

describe("reads", () => {
  it("fetches a conversation by id (found, missing, error, default client)", async () => {
    expect(
      (await getSlackConversationById("conv-1", makeDb([chain({ data: CONV, error: null })])))?.id
    ).toBe("conv-1");
    expect(
      await getSlackConversationById("conv-x", makeDb([chain({ data: null, error: null })]))
    ).toBeNull();
    await expect(
      getSlackConversationById("conv-1", makeDb([chain({ data: null, error: { message: "e" } })]))
    ).rejects.toThrow(/getSlackConversationById: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    expect(await getSlackConversationById("conv-1")).toBeNull();
  });

  it("lists the bounded window oldest-first (and errors honestly)", async () => {
    const rows = [
      { id: 9, role: "assistant", content: "b" },
      { id: 7, role: "user", content: "a" }
    ];
    expect(
      (await listSlackMessages("conv-1", 12, makeDb([chain({ data: rows, error: null })]))).map(
        (m) => m.id
      )
    ).toEqual([7, 9]);
    expect(
      await listSlackMessages("conv-1", 12, makeDb([chain({ data: null, error: null })]))
    ).toEqual([]);
    await expect(
      listSlackMessages("conv-1", 12, makeDb([chain({ data: null, error: { message: "e" } })]))
    ).rejects.toThrow(/listSlackMessages: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: [], error: null })]));
    expect(await listSlackMessages("conv-1", 12)).toEqual([]);
  });
});

describe("markSlackHelloSent", () => {
  it("claims once, yields to the racing winner, throws on real failures", async () => {
    const c = chain({ data: null, error: null });
    expect(
      await markSlackHelloSent(
        { conversationId: "conv-1", businessId: BIZ, content: "hi" },
        makeDb([c])
      )
    ).toBe(true);
    expect((c as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalledWith(
      expect.objectContaining({ slack_event_id: "hello:conv-1", role: "assistant" })
    );

    expect(
      await markSlackHelloSent(
        { conversationId: "conv-1", businessId: BIZ, content: "hi" },
        makeDb([chain({ data: null, error: { message: "dup", code: "23505" } })])
      )
    ).toBe(false);

    await expect(
      markSlackHelloSent(
        { conversationId: "conv-1", businessId: BIZ, content: "hi" },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/markSlackHelloSent: e/);

    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    expect(
      await markSlackHelloSent({ conversationId: "conv-1", businessId: BIZ, content: "hi" })
    ).toBe(true);
  });
});
