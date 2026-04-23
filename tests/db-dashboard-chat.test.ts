import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  appendMessage,
  createThread,
  deactivateActiveThread,
  getActiveThread,
  getOrCreateActiveThread,
  listMessages,
  touchChatActivity,
  updateThreadConversation
} from "@/lib/db/dashboard-chat";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    upsert: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn()
  };
  return c;
}

function makeDb(c: Chain | Record<string, Chain>) {
  if (typeof (c as Chain).select === "function") {
    return { from: vi.fn(() => c as Chain) };
  }
  const map = c as Record<string, Chain>;
  return {
    from: vi.fn((name: string) => {
      const next = map[name];
      if (!next) throw new Error(`unexpected from(${name})`);
      return next;
    })
  };
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const THREAD = {
  id: "thread-1",
  business_id: BIZ,
  rowboat_conversation_id: null,
  rowboat_state: null,
  title: "hello",
  is_active: true,
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("db/dashboard-chat — threads", () => {
  it("getActiveThread filters by business_id + is_active and returns the row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
    const db = makeDb(c);
    await expect(getActiveThread(BIZ, db as never)).resolves.toEqual(THREAD);
    expect(db.from).toHaveBeenCalledWith("dashboard_chat_threads");
    expect(c.eq).toHaveBeenNthCalledWith(1, "business_id", BIZ);
    expect(c.eq).toHaveBeenNthCalledWith(2, "is_active", true);
  });

  it("getActiveThread returns null when absent, throws on db error", async () => {
    const c1 = chain();
    c1.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getActiveThread(BIZ, makeDb(c1) as never)).resolves.toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getActiveThread(BIZ, makeDb(c2) as never)).rejects.toThrow(/getActiveThread: boom/);
  });

  it("createThread inserts with is_active=true and truncates title to 140 chars", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: THREAD, error: null });
    const db = makeDb(c);
    const longTitle = "x".repeat(500);
    await createThread(BIZ, longTitle, db as never);
    const [row] = c.insert.mock.calls[0] as [Record<string, unknown>];
    expect(row.business_id).toBe(BIZ);
    expect(row.is_active).toBe(true);
    expect((row.title as string).length).toBe(140);
  });

  it("createThread allows null title and surfaces db errors", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: THREAD, error: null });
    await createThread(BIZ, null, makeDb(c) as never);
    const [row] = c.insert.mock.calls[0] as [Record<string, unknown>];
    expect(row.title).toBeNull();

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "dup" } });
    await expect(createThread(BIZ, "t", makeDb(c2) as never)).rejects.toThrow(/createThread: dup/);
  });

  it("getOrCreateActiveThread returns the existing row when present", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
    await expect(getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)).resolves.toEqual(THREAD);
    expect(c.insert).not.toHaveBeenCalled();
  });

  it("getOrCreateActiveThread creates a fresh thread when none exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: THREAD, error: null });
    await expect(getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)).resolves.toEqual(THREAD);
    expect(c.insert).toHaveBeenCalled();
  });

  it("getOrCreateActiveThread recovers from a 23505 race and returns the winner's thread", async () => {
    // Two concurrent first-message POSTs both saw "no active thread" and
    // raced the insert — one wins, the other gets a unique-violation from
    // the dashboard_chat_threads_one_active partial index. The loser must
    // re-read instead of bubbling a spurious 500 to the owner.
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: THREAD, error: null });
    c.single.mockResolvedValue({
      data: null,
      error: { message: "duplicate key value violates unique constraint (23505)" }
    });
    await expect(getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)).resolves.toEqual(THREAD);
    expect(c.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("getOrCreateActiveThread recovers using the 'one_active' message variant", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: THREAD, error: null });
    c.single.mockResolvedValue({
      data: null,
      error: { message: "conflict on dashboard_chat_threads_one_active" }
    });
    await expect(getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)).resolves.toEqual(THREAD);
  });

  it("getOrCreateActiveThread rethrows non-unique errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "network failure" } });
    await expect(
      getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)
    ).rejects.toThrow(/network failure/);
  });

  it("getOrCreateActiveThread rethrows the original error when the winner lookup is empty", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    c.single.mockResolvedValue({
      data: null,
      error: { message: "duplicate key value violates unique constraint (23505)" }
    });
    await expect(
      getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)
    ).rejects.toThrow(/23505/);
  });

  it("deactivateActiveThread flips is_active=false and surfaces errors", async () => {
    const c = chain();
    c.eq.mockReturnValue(c);
    // The .update(...).eq(...).eq(...) chain resolves on the final eq.
    // Make the second eq return a promise.
    c.eq = vi
      .fn()
      .mockReturnValueOnce(c)
      .mockResolvedValueOnce({ error: null });
    await deactivateActiveThread(BIZ, makeDb(c) as never);
    expect(c.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));

    const c2 = chain();
    c2.eq = vi
      .fn()
      .mockReturnValueOnce(c2)
      .mockResolvedValueOnce({ error: { message: "bad" } });
    await expect(deactivateActiveThread(BIZ, makeDb(c2) as never)).rejects.toThrow(
      /deactivateActiveThread: bad/
    );
  });
});

describe("db/dashboard-chat — messages", () => {
  it("appendMessage inserts the message and touches the thread updated_at", async () => {
    const msgChain = chain();
    msgChain.single.mockResolvedValue({
      data: { id: 1, thread_id: "thread-1", role: "user", content: "hi", created_at: "t" },
      error: null
    });
    const threadChain = chain();
    threadChain.eq.mockResolvedValue({ error: null });
    const db = makeDb({
      dashboard_chat_messages: msgChain,
      dashboard_chat_threads: threadChain
    });

    const row = await appendMessage("thread-1", "user", "hi", db as never);
    expect(row.content).toBe("hi");
    expect(msgChain.insert).toHaveBeenCalledWith({
      thread_id: "thread-1",
      role: "user",
      content: "hi"
    });
    expect(threadChain.update).toHaveBeenCalled();
  });

  it("appendMessage throws on insert error", async () => {
    const msgChain = chain();
    msgChain.single.mockResolvedValue({ data: null, error: { message: "insfail" } });
    const db = makeDb({ dashboard_chat_messages: msgChain });
    await expect(appendMessage("thread-1", "user", "hi", db as never)).rejects.toThrow(
      /appendMessage: insfail/
    );
  });

  it("listMessages orders by created_at ascending and returns [] when no rows", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: [], error: null });
    const db = makeDb(c);
    await expect(listMessages("thread-1", db as never)).resolves.toEqual([]);
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("listMessages returns an empty array when Supabase hands back null data", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: null });
    await expect(listMessages("thread-1", makeDb(c) as never)).resolves.toEqual([]);
  });

  it("listMessages throws on query error", async () => {
    const c = chain();
    c.order.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listMessages("thread-1", makeDb(c) as never)).rejects.toThrow(
      /listMessages: boom/
    );
  });

  it("updateThreadConversation writes conversationId + state when both provided", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: null });
    await updateThreadConversation("thread-1", "conv-1", { foo: 1 }, makeDb(c) as never);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({
        rowboat_conversation_id: "conv-1",
        rowboat_state: { foo: 1 }
      })
    );
  });

  it("updateThreadConversation omits state when undefined (preserves prior value)", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: null });
    await updateThreadConversation("thread-1", "conv-1", undefined, makeDb(c) as never);
    const update = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(update).not.toHaveProperty("rowboat_state");
    expect(update.rowboat_conversation_id).toBe("conv-1");
  });

  it("updateThreadConversation omits conversationId when null", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: null });
    await updateThreadConversation("thread-1", null, { x: 2 }, makeDb(c) as never);
    const update = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(update).not.toHaveProperty("rowboat_conversation_id");
    expect(update.rowboat_state).toEqual({ x: 2 });
  });

  it("updateThreadConversation throws on db error", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: { message: "bad" } });
    await expect(
      updateThreadConversation("thread-1", "c", undefined, makeDb(c) as never)
    ).rejects.toThrow(/updateThreadConversation: bad/);
  });
});

describe("db/dashboard-chat — activity heartbeat", () => {
  it("touchChatActivity upserts last_user_chat_at keyed by business_id", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: null });
    await touchChatActivity(BIZ, makeDb(c) as never);
    const [row, opts] = c.upsert.mock.calls[0];
    expect(row as Record<string, unknown>).toMatchObject({ business_id: BIZ });
    expect((row as Record<string, string>).last_user_chat_at).toBeTypeOf("string");
    expect(opts).toEqual({ onConflict: "business_id" });
  });

  it("touchChatActivity throws on db error", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: { message: "fail" } });
    await expect(touchChatActivity(BIZ, makeDb(c) as never)).rejects.toThrow(
      /touchChatActivity: fail/
    );
  });
});

describe("db/dashboard-chat — default service client fallback", () => {
  it("each helper uses createSupabaseServiceClient when no client is passed", async () => {
    // getActiveThread
    {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(getActiveThread(BIZ)).resolves.toEqual(THREAD);
      expect(createSupabaseServiceClient).toHaveBeenCalled();
    }
    // createThread
    {
      const c = chain();
      c.single.mockResolvedValue({ data: THREAD, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(createThread(BIZ, null)).resolves.toEqual(THREAD);
    }
    // getOrCreateActiveThread — existing branch
    {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(getOrCreateActiveThread(BIZ, "t")).resolves.toEqual(THREAD);
    }
    // appendMessage
    {
      const msgChain = chain();
      msgChain.single.mockResolvedValue({
        data: { id: 2, thread_id: "t", role: "user", content: "x", created_at: "t" },
        error: null
      });
      const threadChain = chain();
      threadChain.eq.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(
        makeDb({
          dashboard_chat_messages: msgChain,
          dashboard_chat_threads: threadChain
        })
      );
      await expect(appendMessage("t", "user", "x")).resolves.toMatchObject({ content: "x" });
    }
    // listMessages
    {
      const c = chain();
      c.order.mockResolvedValue({ data: [], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(listMessages("t")).resolves.toEqual([]);
    }
    // updateThreadConversation
    {
      const c = chain();
      c.eq.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(updateThreadConversation("t", "c", undefined)).resolves.toBeUndefined();
    }
    // deactivateActiveThread
    {
      const c = chain();
      c.eq = vi
        .fn()
        .mockReturnValueOnce(c)
        .mockResolvedValueOnce({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(deactivateActiveThread(BIZ)).resolves.toBeUndefined();
    }
    // touchChatActivity
    {
      const c = chain();
      c.upsert.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(touchChatActivity(BIZ)).resolves.toBeUndefined();
    }
  });
});
