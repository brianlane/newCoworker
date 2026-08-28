/**
 * Tests for the Slack chat store (src/lib/db/coworker-chat.ts). What matters:
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
  claimCoworkerJob,
  completeCoworkerJob,
  failCoworkerJob,
  getOrCreateCoworkerConversation,
  getCoworkerConversationById,
  insertCoworkerUserMessage,
  listCoworkerMessages,
  markCoworkerHelloSent,
  reclaimStaleCoworkerJobs,
  updateCoworkerConversationIdentity
} from "@/lib/db/coworker-chat";

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
  external_workspace_id: "T-1",
  external_conversation_id: "D-1",
  thread_key: null,
  external_user_id: "U-1"
};

const INPUT = {
  businessId: BIZ,
  channel: "slack" as const,
  externalWorkspaceId: "T-1",
  externalConversationId: "D-1",
  threadKey: null as string | null,
  externalUserId: "U-1"
};

describe("getOrCreateCoworkerConversation", () => {
  it("returns an existing conversation without inserting", async () => {
    const db = makeDb([chain({ data: CONV, error: null })]);
    expect((await getOrCreateCoworkerConversation(INPUT, db)).id).toBe("conv-1");
  });

  it("creates when absent (null-thread and threaded variants)", async () => {
    const db = makeDb([chain({ data: null, error: null }), chain({ data: CONV, error: null })]);
    expect((await getOrCreateCoworkerConversation(INPUT, db)).id).toBe("conv-1");

    const threaded = makeDb([
      chain({ data: null, error: null }),
      chain({ data: { ...CONV, thread_key: "9.9" }, error: null })
    ]);
    expect(
      (await getOrCreateCoworkerConversation({ ...INPUT, threadKey: "9.9" }, threaded)).id
    ).toBe("conv-1");
  });

  it("re-reads on the unique-scope race, for both thread shapes", async () => {
    const db = makeDb([
      chain({ data: null, error: null }),
      chain({ data: null, error: { message: "dup", code: "23505" } }),
      chain({ data: CONV, error: null })
    ]);
    expect((await getOrCreateCoworkerConversation(INPUT, db)).id).toBe("conv-1");

    const threaded = makeDb([
      chain({ data: null, error: null }),
      chain({ data: null, error: { message: "dup", code: "23505" } }),
      chain({ data: { ...CONV, thread_key: "9.9" }, error: null })
    ]);
    expect(
      (await getOrCreateCoworkerConversation({ ...INPUT, threadKey: "9.9" }, threaded)).id
    ).toBe("conv-1");
  });

  it("throws on read errors, insert errors, and a race re-read that finds nothing", async () => {
    await expect(
      getOrCreateCoworkerConversation(INPUT, makeDb([chain({ data: null, error: { message: "r" } })]))
    ).rejects.toThrow(/getOrCreateCoworkerConversation: r/);
    await expect(
      getOrCreateCoworkerConversation(
        INPUT,
        makeDb([chain({ data: null, error: null }), chain({ data: null, error: { message: "i" } })])
      )
    ).rejects.toThrow(/getOrCreateCoworkerConversation: i/);
    await expect(
      getOrCreateCoworkerConversation(
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
    expect((await getOrCreateCoworkerConversation(INPUT)).id).toBe("conv-1");
  });
});

describe("updateCoworkerConversationIdentity", () => {
  it("leaves a phone alone unless the caller says something about it", async () => {
    // Slack and Google Chat resolve an EMAIL and know nothing about a
    // phone; Telegram establishes a phone through a shared contact card and
    // has no email. Writing null for the field a channel cannot speak to
    // would have each one wipe the other's identity on every message.
    const emailOnly = chain({ data: null, error: null });
    await updateCoworkerConversationIdentity(
      "conv-1",
      { displayName: "Amy", email: "a@x.co", isOwner: true },
      makeDb([emailOnly])
    );
    expect(
      (emailOnly as { update: ReturnType<typeof vi.fn> }).update.mock.calls[0][0]
    ).not.toHaveProperty("user_phone_e164");

    const withPhone = chain({ data: null, error: null });
    await updateCoworkerConversationIdentity(
      "conv-1",
      { displayName: "Sam", email: null, phoneE164: "+15145188192", isOwner: false },
      makeDb([withPhone])
    );
    expect((withPhone as { update: ReturnType<typeof vi.fn> }).update.mock.calls[0][0]).toMatchObject(
      { user_phone_e164: "+15145188192" }
    );

    // And an explicit null still clears it, for an unlink.
    const cleared = chain({ data: null, error: null });
    await updateCoworkerConversationIdentity(
      "conv-1",
      { displayName: null, email: null, phoneE164: null, isOwner: false },
      makeDb([cleared])
    );
    expect((cleared as { update: ReturnType<typeof vi.fn> }).update.mock.calls[0][0]).toMatchObject(
      { user_phone_e164: null }
    );
  });

  it("caches the verdict and throws on errors", async () => {
    const c = chain({ data: null, error: null });
    await updateCoworkerConversationIdentity(
      "conv-1",
      { displayName: "Amy", email: "a@x.co", isOwner: true },
      makeDb([c])
    );
    expect((c as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ user_email: "a@x.co", is_owner: true })
    );
    await expect(
      updateCoworkerConversationIdentity(
        "conv-1",
        { displayName: null, email: null, isOwner: false },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/updateCoworkerConversationIdentity: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    await updateCoworkerConversationIdentity("conv-1", {
      displayName: null,
      email: null,
      isOwner: false
    });
  });
});

describe("insertCoworkerUserMessage", () => {
  const MSG_INPUT = {
    conversationId: "conv-1",
    businessId: BIZ,
    channel: "slack" as const,
    content: "hi",
    externalEventId: "Ev-1",
    externalTs: "1.1"
  };

  it("stores message + job + bumps the conversation", async () => {
    const db = makeDb([
      chain({ data: { id: 7 }, error: null }),
      chain({ data: { id: "job-1" }, error: null }),
      chain({ data: null, error: null })
    ]);
    expect(await insertCoworkerUserMessage(MSG_INPUT, db)).toEqual({ messageId: 7, jobId: "job-1" });
  });

  it("returns null on the event-id dedupe and throws on real failures", async () => {
    expect(
      await insertCoworkerUserMessage(
        MSG_INPUT,
        makeDb([chain({ data: null, error: { message: "dup", code: "23505" } })])
      )
    ).toBeNull();

    await expect(
      insertCoworkerUserMessage(MSG_INPUT, makeDb([chain({ data: null, error: { message: "m" } })]))
    ).rejects.toThrow(/insertCoworkerUserMessage: m/);
    await expect(
      insertCoworkerUserMessage(
        MSG_INPUT,
        makeDb([
          chain({ data: { id: 7 }, error: null }),
          chain({ data: null, error: { message: "j" } })
        ])
      )
    ).rejects.toThrow(/insertCoworkerUserMessage: j/);
    await expect(
      insertCoworkerUserMessage(
        MSG_INPUT,
        makeDb([
          chain({ data: { id: 7 }, error: null }),
          chain({ data: { id: "job-1" }, error: null }),
          chain({ data: null, error: { message: "b" } })
        ])
      )
    ).rejects.toThrow(/insertCoworkerUserMessage: b/);
    defaultClientSpy.mockReturnValueOnce(
      makeDb([
        chain({ data: { id: 7 }, error: null }),
        chain({ data: { id: "job-1" }, error: null }),
        chain({ data: null, error: null })
      ])
    );
    expect(await insertCoworkerUserMessage(MSG_INPUT)).toEqual({ messageId: 7, jobId: "job-1" });
  });
});

describe("job primitives", () => {
  it("claims 0 or 1 rows via RPC and throws on errors", async () => {
    expect(
      await claimCoworkerJob("w1", makeDb([], [{ data: [{ id: "job-1" }], error: null }]))
    ).toMatchObject({ id: "job-1" });
    expect(await claimCoworkerJob("w1", makeDb([], [{ data: [], error: null }]))).toBeNull();
    expect(await claimCoworkerJob("w1", makeDb([], [{ data: null, error: null }]))).toBeNull();
    await expect(
      claimCoworkerJob("w1", makeDb([], [{ data: null, error: { message: "c" } }]))
    ).rejects.toThrow(/claimCoworkerJob: c/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: [], error: null }]));
    expect(await claimCoworkerJob("w1")).toBeNull();
  });

  it("completes via RPC and throws on errors", async () => {
    const db = makeDb([], [{ data: 9, error: null }]);
    await completeCoworkerJob(
      { jobId: "job-1", content: "done", historyMaxMessageId: 7, externalTs: "2.2" },
      db
    );
    expect((db as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "coworker_job_complete",
      expect.objectContaining({ p_job_id: "job-1", p_history_max_message_id: 7 })
    );
    await expect(
      completeCoworkerJob(
        { jobId: "job-1", content: "x", historyMaxMessageId: 0, externalTs: null },
        makeDb([], [{ data: null, error: { message: "e" } }])
      )
    ).rejects.toThrow(/completeCoworkerJob: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: 9, error: null }]));
    await completeCoworkerJob({ jobId: "j", content: "x", historyMaxMessageId: 0, externalTs: null });
  });

  it("fails terminal vs retryable and throws on errors", async () => {
    const terminal = chain({ data: null, error: null });
    await failCoworkerJob(
      { jobId: "job-1", errorCode: "tier_blocked", terminal: true },
      makeDb([terminal])
    );
    expect((terminal as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", error_code: "tier_blocked" })
    );

    const retry = chain({ data: null, error: null });
    await failCoworkerJob(
      { jobId: "job-1", errorCode: "post_failed", errorDetail: "d", terminal: false },
      makeDb([retry])
    );
    expect((retry as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", error_detail: "d" })
    );

    await expect(
      failCoworkerJob(
        { jobId: "j", errorCode: "x", terminal: false },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/failCoworkerJob: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    await failCoworkerJob({ jobId: "j", errorCode: "x", terminal: true });
  });

  it("reclaims via RPC with a numeric result and throws on errors", async () => {
    expect(await reclaimStaleCoworkerJobs(makeDb([], [{ data: 3, error: null }]))).toBe(3);
    expect(await reclaimStaleCoworkerJobs(makeDb([], [{ data: null, error: null }]))).toBe(0);
    await expect(
      reclaimStaleCoworkerJobs(makeDb([], [{ data: null, error: { message: "e" } }]))
    ).rejects.toThrow(/reclaimStaleCoworkerJobs: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([], [{ data: 1, error: null }]));
    expect(await reclaimStaleCoworkerJobs()).toBe(1);
  });
});

describe("reads", () => {
  it("fetches a conversation by id (found, missing, error, default client)", async () => {
    expect(
      (await getCoworkerConversationById("conv-1", makeDb([chain({ data: CONV, error: null })])))?.id
    ).toBe("conv-1");
    expect(
      await getCoworkerConversationById("conv-x", makeDb([chain({ data: null, error: null })]))
    ).toBeNull();
    await expect(
      getCoworkerConversationById("conv-1", makeDb([chain({ data: null, error: { message: "e" } })]))
    ).rejects.toThrow(/getCoworkerConversationById: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    expect(await getCoworkerConversationById("conv-1")).toBeNull();
  });

  it("lists the bounded window oldest-first (and errors honestly)", async () => {
    const rows = [
      { id: 9, role: "assistant", content: "b" },
      { id: 7, role: "user", content: "a" }
    ];
    expect(
      (await listCoworkerMessages("conv-1", 12, makeDb([chain({ data: rows, error: null })]))).map(
        (m) => m.id
      )
    ).toEqual([7, 9]);
    expect(
      await listCoworkerMessages("conv-1", 12, makeDb([chain({ data: null, error: null })]))
    ).toEqual([]);
    await expect(
      listCoworkerMessages("conv-1", 12, makeDb([chain({ data: null, error: { message: "e" } })]))
    ).rejects.toThrow(/listCoworkerMessages: e/);
    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: [], error: null })]));
    expect(await listCoworkerMessages("conv-1", 12)).toEqual([]);
  });
});

describe("markCoworkerHelloSent", () => {
  it("claims once, yields to the racing winner, throws on real failures", async () => {
    const c = chain({ data: null, error: null });
    expect(
      await markCoworkerHelloSent(
        { conversationId: "conv-1", businessId: BIZ, channel: "slack", content: "hi" },
        makeDb([c])
      )
    ).toBe(true);
    expect((c as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalledWith(
      expect.objectContaining({ external_event_id: "hello:conv-1", role: "assistant" })
    );

    expect(
      await markCoworkerHelloSent(
        { conversationId: "conv-1", businessId: BIZ, channel: "slack", content: "hi" },
        makeDb([chain({ data: null, error: { message: "dup", code: "23505" } })])
      )
    ).toBe(false);

    await expect(
      markCoworkerHelloSent(
        { conversationId: "conv-1", businessId: BIZ, channel: "slack", content: "hi" },
        makeDb([chain({ data: null, error: { message: "e" } })])
      )
    ).rejects.toThrow(/markCoworkerHelloSent: e/);

    defaultClientSpy.mockReturnValueOnce(makeDb([chain({ data: null, error: null })]));
    expect(
      await markCoworkerHelloSent({ conversationId: "conv-1", businessId: BIZ, channel: "slack", content: "hi" })
    ).toBe(true);
  });
});
