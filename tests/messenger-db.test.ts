/**
 * Tests for the Messenger channel data layer (src/lib/messenger/db.ts):
 * conversation upsert (race-safe), mid-deduped message appends, the job
 * lifecycle RPC wrappers, the 24h-window predicate, and list projections.
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  appendMessengerMessage,
  claimMessengerJob,
  completeMessengerJob,
  failMessengerJob,
  getMessengerConversationById,
  insertMessengerJob,
  listMessengerConversationsForBusiness,
  listMessengerMessages,
  MESSENGER_WINDOW_MS,
  messengerWindowOpen,
  reclaimStaleMessengerJobs,
  requeueMessengerJob,
  updateMessengerConversationContact,
  upsertMessengerConversation
} from "@/lib/messenger/db";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown, rpc?: ReturnType<typeof vi.fn>) {
  return { from: vi.fn(() => c), rpc: rpc ?? vi.fn() } as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";

const IDENTITY = {
  businessId: BIZ,
  pageId: "p1",
  platform: "messenger" as const,
  psid: "psid-1"
};

const CONVERSATION = {
  id: CONV_ID,
  business_id: BIZ,
  page_id: "p1",
  platform: "messenger",
  psid: "psid-1",
  display_name: null,
  contact_phone: null,
  status: "active",
  last_user_message_at: "2026-07-15T20:00:00Z",
  created_at: "2026-07-15T19:00:00Z",
  updated_at: "2026-07-15T20:00:00Z"
};

describe("messengerWindowOpen", () => {
  it("is open inside 24h, closed after, and closed on garbage timestamps", () => {
    const now = new Date("2026-07-15T20:00:00Z");
    expect(
      messengerWindowOpen({ last_user_message_at: "2026-07-15T19:00:00Z" }, now)
    ).toBe(true);
    expect(
      messengerWindowOpen(
        {
          last_user_message_at: new Date(
            now.getTime() - MESSENGER_WINDOW_MS - 1
          ).toISOString()
        },
        now
      )
    ).toBe(false);
    expect(messengerWindowOpen({ last_user_message_at: "not-a-date" }, now)).toBe(false);
  });
});

describe("upsertMessengerConversation", () => {
  it("bumps the window clock on an existing conversation (no display-name overwrite)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({
      data: { ...CONVERSATION, display_name: "Jane" },
      error: null
    });
    c.single.mockResolvedValue({
      data: { ...CONVERSATION, display_name: "Jane" },
      error: null
    });
    const { conversation, isNew } = await upsertMessengerConversation(
      { ...IDENTITY, displayName: "Other Name" },
      makeDb(c)
    );
    expect(isNew).toBe(false);
    expect(conversation.display_name).toBe("Jane");
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.last_user_message_at).toBeTruthy();
    expect(patch.status).toBe("active");
    expect(patch).not.toHaveProperty("display_name");
  });

  it("fills a missing display name on update", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: CONVERSATION, error: null });
    c.single.mockResolvedValue({
      data: { ...CONVERSATION, display_name: "Jane" },
      error: null
    });
    await upsertMessengerConversation({ ...IDENTITY, displayName: "Jane" }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.display_name).toBe("Jane");
  });

  it("surfaces an update error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: CONVERSATION, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "bump fail" } });
    await expect(upsertMessengerConversation(IDENTITY, makeDb(c))).rejects.toThrow(
      /bump fail/
    );
  });

  it("inserts a new conversation (isNew) when none exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: CONVERSATION, error: null });
    const { conversation, isNew } = await upsertMessengerConversation(
      IDENTITY,
      makeDb(c)
    );
    expect(isNew).toBe(true);
    expect(conversation.id).toBe(CONV_ID);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.business_id).toBe(BIZ);
    expect(inserted.platform).toBe("messenger");
    expect(inserted.display_name).toBeNull();
  });

  it("re-reads the winner when the insert loses the identity race", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: CONVERSATION, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "duplicate key 23505" } });
    const { conversation, isNew } = await upsertMessengerConversation(
      IDENTITY,
      makeDb(c)
    );
    expect(isNew).toBe(false);
    expect(conversation.id).toBe(CONV_ID);
  });

  it("throws when both the insert and the winner re-read fail", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(upsertMessengerConversation(IDENTITY, makeDb(c))).rejects.toThrow(
      /insert fail/
    );
  });

  it("throws on an identity-read error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(upsertMessengerConversation(IDENTITY, makeDb(c))).rejects.toThrow(
      /read fail/
    );
  });
});

describe("getMessengerConversationById", () => {
  it("returns the row / null / throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: CONVERSATION, error: null });
    expect((await getMessengerConversationById(CONV_ID, makeDb(c)))?.id).toBe(CONV_ID);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMessengerConversationById(CONV_ID, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getMessengerConversationById(CONV_ID, makeDb(c3))).rejects.toThrow(/boom/);
  });
});

describe("updateMessengerConversationContact", () => {
  it("merges non-empty values only; empty patch is a no-op", async () => {
    const c = chain();
    const terminal = chain({ error: null });
    void terminal;
    const cc = chain();
    (cc as unknown as { then: unknown }).then = undefined;
    const db = makeDb(c);
    c.eq.mockReturnValue(Promise.resolve({ error: null }));
    await updateMessengerConversationContact(CONV_ID, { name: "Jane", phone: " " }, db);
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.display_name).toBe("Jane");
    expect(patch).not.toHaveProperty("contact_phone");
    expect(patch.updated_at).toBeTruthy();

    const c2 = chain();
    await updateMessengerConversationContact(CONV_ID, { name: "  " }, makeDb(c2));
    expect(c2.update).not.toHaveBeenCalled();
  });

  it("throws on an update error", async () => {
    const c = chain();
    c.eq.mockReturnValue(Promise.resolve({ error: { message: "merge fail" } }));
    await expect(
      updateMessengerConversationContact(CONV_ID, { phone: "+15551234567" }, makeDb(c))
    ).rejects.toThrow(/merge fail/);
  });
});

describe("listMessengerConversationsForBusiness", () => {
  it("maps embedded message counts and tolerates malformed embeds", async () => {
    const c = chain({
      data: [
        { ...CONVERSATION, messenger_messages: [{ count: 4 }] },
        { ...CONVERSATION, id: "x", messenger_messages: null },
        { ...CONVERSATION, id: "y", messenger_messages: [{ count: Number.NaN }] },
        { ...CONVERSATION, id: "z", messenger_messages: [] }
      ],
      error: null
    });
    const rows = await listMessengerConversationsForBusiness(BIZ, {}, makeDb(c));
    expect(rows.map((r) => r.message_count)).toEqual([4, 0, 0, 0]);
    expect(rows[0]).not.toHaveProperty("messenger_messages");
  });

  it("returns [] when the read produces no data at all", async () => {
    const c = chain({ data: null, error: null });
    expect(await listMessengerConversationsForBusiness(BIZ, {}, makeDb(c))).toEqual([]);
  });

  it("honors the limit and throws on error", async () => {
    const c = chain({ data: [], error: null });
    await listMessengerConversationsForBusiness(BIZ, { limit: 5 }, makeDb(c));
    expect(c.limit).toHaveBeenCalledWith(5);

    const c2 = chain({ data: null, error: { message: "list fail" } });
    await expect(
      listMessengerConversationsForBusiness(BIZ, {}, makeDb(c2))
    ).rejects.toThrow(/list fail/);
  });
});

describe("appendMessengerMessage", () => {
  const INPUT = {
    conversationId: CONV_ID,
    businessId: BIZ,
    role: "user" as const,
    content: "Hi",
    mid: "m1"
  };

  it("inserts and returns the row", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: 7, ...INPUT }, error: null });
    const row = await appendMessengerMessage(INPUT, makeDb(c));
    expect(row?.id).toBe(7);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.mid).toBe("m1");
  });

  it("returns null on the mid unique violation (duplicate redelivery)", async () => {
    const c = chain();
    c.single.mockResolvedValue({
      data: null,
      error: { message: 'duplicate key value violates unique constraint (23505)' }
    });
    expect(await appendMessengerMessage(INPUT, makeDb(c))).toBeNull();
  });

  it("null mid default for assistant sends; other errors throw", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: 8 }, error: null });
    await appendMessengerMessage(
      { conversationId: CONV_ID, businessId: BIZ, role: "assistant", content: "Hello" },
      makeDb(c)
    );
    expect((c.insert.mock.calls[0][0] as Record<string, unknown>).mid).toBeNull();

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(appendMessengerMessage(INPUT, makeDb(c2))).rejects.toThrow(/insert fail/);

    // A message-less error object still throws (not treated as a dup).
    const c3 = chain();
    c3.single.mockResolvedValue({ data: null, error: {} });
    await expect(appendMessengerMessage(INPUT, makeDb(c3))).rejects.toThrow(
      /appendMessengerMessage/
    );
  });
});

describe("listMessengerMessages", () => {
  it("fetches newest-first bounded, presents oldest-first; throws on error", async () => {
    const c = chain({ data: [{ id: 3 }, { id: 2 }, { id: 1 }], error: null });
    const rows = await listMessengerMessages(CONV_ID, {}, makeDb(c));
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(c.order).toHaveBeenCalledWith("id", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(200);

    const empty = chain({ data: null, error: null });
    expect(await listMessengerMessages(CONV_ID, {}, makeDb(empty))).toEqual([]);

    const c2 = chain({ data: null, error: { message: "msg fail" } });
    await expect(listMessengerMessages(CONV_ID, {}, makeDb(c2))).rejects.toThrow(
      /msg fail/
    );
  });
});

describe("insertMessengerJob", () => {
  it("inserts and returns the job; throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: "job-1" }, error: null });
    const job = await insertMessengerJob(
      { businessId: BIZ, conversationId: CONV_ID, userMessageId: 7 },
      makeDb(c)
    );
    expect(job.id).toBe("job-1");

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "job fail" } });
    await expect(
      insertMessengerJob(
        { businessId: BIZ, conversationId: CONV_ID, userMessageId: 7 },
        makeDb(c2)
      )
    ).rejects.toThrow(/job fail/);
  });
});

describe("job lifecycle RPC wrappers", () => {
  it("claims via claim_messenger_job (row / empty / error)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: "job-1" }], error: null });
    expect((await claimMessengerJob("w1", makeDb(chain(), rpc)))?.id).toBe("job-1");
    expect(rpc).toHaveBeenCalledWith("claim_messenger_job", { p_worker_id: "w1" });

    const rpcEmpty = vi.fn().mockResolvedValue({ data: [], error: null });
    expect(await claimMessengerJob("w1", makeDb(chain(), rpcEmpty))).toBeNull();

    const rpcNull = vi.fn().mockResolvedValue({ data: null, error: null });
    expect(await claimMessengerJob("w1", makeDb(chain(), rpcNull))).toBeNull();

    const rpcErr = vi.fn().mockResolvedValue({ data: null, error: { message: "rpc down" } });
    await expect(claimMessengerJob("w1", makeDb(chain(), rpcErr))).rejects.toThrow(
      /rpc down/
    );
  });

  it("completes via messenger_job_complete and validates the returned id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 42, error: null });
    expect(await completeMessengerJob("job-1", "Reply!", 7, makeDb(chain(), rpc))).toBe(42);
    expect(rpc).toHaveBeenCalledWith("messenger_job_complete", {
      p_job_id: "job-1",
      p_content: "Reply!",
      p_history_max_message_id: 7
    });

    const rpcBad = vi.fn().mockResolvedValue({ data: "not-a-number", error: null });
    await expect(
      completeMessengerJob("job-1", "Reply!", 7, makeDb(chain(), rpcBad))
    ).rejects.toThrow(/non-numeric/);

    const rpcErr = vi.fn().mockResolvedValue({ data: null, error: { message: "commit fail" } });
    await expect(
      completeMessengerJob("job-1", "Reply!", 7, makeDb(chain(), rpcErr))
    ).rejects.toThrow(/commit fail/);
  });

  it("fails a job guarded to its claim generation", async () => {
    const c = chain();
    c.eq.mockImplementation(() => c);
    // The final eq in the chain resolves the promise.
    let resolved = false;
    (c as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      resolved = true;
      return Promise.resolve({ error: null }).then(resolve);
    };
    await failMessengerJob("job-1", "turn_failed", "boom", "2026-07-15T20:00:00Z", makeDb(c));
    expect(resolved).toBe(true);
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("error");
    expect(c.eq).toHaveBeenCalledWith("claimed_at", "2026-07-15T20:00:00Z");

    const c2 = chain({ error: { message: "flip fail" } });
    await expect(
      failMessengerJob("job-1", "x", "y", "2026-07-15T20:00:00Z", makeDb(c2))
    ).rejects.toThrow(/flip fail/);
  });

  it("requeues a claimed job (same guard) and surfaces errors", async () => {
    const c = chain({ error: null });
    await requeueMessengerJob("job-1", "2026-07-15T20:00:00Z", makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.claimed_by).toBeNull();

    const c2 = chain({ error: { message: "requeue fail" } });
    await expect(
      requeueMessengerJob("job-1", "2026-07-15T20:00:00Z", makeDb(c2))
    ).rejects.toThrow(/requeue fail/);
  });

  it("reclaims stale jobs and coerces the count", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
    expect(await reclaimStaleMessengerJobs(makeDb(chain(), rpc))).toBe(3);

    const rpcNaN = vi.fn().mockResolvedValue({ data: "weird", error: null });
    expect(await reclaimStaleMessengerJobs(makeDb(chain(), rpcNaN))).toBe(0);

    const rpcErr = vi.fn().mockResolvedValue({ data: null, error: { message: "sweep fail" } });
    await expect(reclaimStaleMessengerJobs(makeDb(chain(), rpcErr))).rejects.toThrow(
      /sweep fail/
    );
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    const c = chain({ data: [], error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: CONVERSATION, error: null });
    const rpc = vi.fn(async (name: string) => {
      if (name === "messenger_job_complete") return { data: 5, error: null };
      if (name === "messenger_jobs_reclaim_stale") return { data: 2, error: null };
      return { data: [], error: null };
    });
    defaultClientSpy.mockReturnValue(makeDb(c, rpc));

    expect(await getMessengerConversationById(CONV_ID)).toBeNull();
    await upsertMessengerConversation(IDENTITY);
    await updateMessengerConversationContact(CONV_ID, {});
    await listMessengerConversationsForBusiness(BIZ);
    await listMessengerMessages(CONV_ID);
    await appendMessengerMessage({
      conversationId: CONV_ID,
      businessId: BIZ,
      role: "user",
      content: "hi"
    });
    await insertMessengerJob({ businessId: BIZ, conversationId: CONV_ID, userMessageId: 1 });
    await claimMessengerJob("w1");
    expect(await completeMessengerJob("job-1", "Reply", 5)).toBe(5);
    await failMessengerJob("job-1", "x", "y", "2026-07-15T20:00:00Z");
    await requeueMessengerJob("job-1", "2026-07-15T20:00:00Z");
    expect(await reclaimStaleMessengerJobs()).toBe(2);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
