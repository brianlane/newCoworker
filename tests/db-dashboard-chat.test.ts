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
  getThreadById,
  listMessages,
  listThreadsForBusiness,
  reactivateThread,
  serializeChatMessages,
  touchChatActivity,
  updateThreadConversation,
  updateThreadSummary
} from "@/lib/db/dashboard-chat";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  lte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
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
    neq: vi.fn(() => c),
    lte: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
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
  updated_at: "2026-04-23T00:00:00Z",
  summary_md: null,
  summary_message_count: 0
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

  it("getOrCreateActiveThread rethrows non-Error rejections that aren't unique violations", async () => {
    // Guard against the rare case where the driver rejects with a bare string
    // (not an Error instance). `isUniqueViolation` must coerce safely and the
    // caller must still see the original throw.
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockRejectedValue("network flaked");
    await expect(
      getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)
    ).rejects.toBe("network flaked");
  });

  it("getOrCreateActiveThread treats non-Error 23505 rejections as race recoveries", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: THREAD, error: null });
    c.single.mockRejectedValue("duplicate key (23505)");
    await expect(
      getOrCreateActiveThread(BIZ, "t", makeDb(c) as never)
    ).resolves.toEqual(THREAD);
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

  it("updateThreadConversation writes only updated_at when conversationId is null and state is undefined", async () => {
    // Defense-in-depth: the route layer shouldn't call us in this shape, but
    // if it does we must not clobber the stored conversationId / state with
    // nulls — only bump updated_at.
    const c = chain();
    c.eq.mockResolvedValue({ error: null });
    await updateThreadConversation("thread-1", null, undefined, makeDb(c) as never);
    const update = c.update.mock.calls[0][0];
    expect(update).toHaveProperty("updated_at");
    expect(update).not.toHaveProperty("rowboat_conversation_id");
    expect(update).not.toHaveProperty("rowboat_state");
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

describe("db/dashboard-chat — getThreadById", () => {
  it("filters by id and returns the row when present", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
    const db = makeDb(c);
    await expect(getThreadById("thread-1", db as never)).resolves.toEqual(THREAD);
    expect(db.from).toHaveBeenCalledWith("dashboard_chat_threads");
    expect(c.eq).toHaveBeenCalledWith("id", "thread-1");
  });

  it("returns null when the thread doesn't exist (used for IDOR-safe 404 in the read-only history route)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getThreadById("thread-1", makeDb(c) as never)).resolves.toBeNull();
  });

  it("throws on db error so the route layer can surface a 500 instead of a misleading 404", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getThreadById("thread-1", makeDb(c) as never)).rejects.toThrow(
      /getThreadById: boom/
    );
  });
});

describe("db/dashboard-chat — listThreadsForBusiness", () => {
  function makeRow(overrides: Partial<typeof THREAD> & { count?: number } = {}) {
    const { count, ...rest } = overrides;
    return {
      ...THREAD,
      ...rest,
      dashboard_chat_messages: [{ count: count ?? 0 }]
    };
  }

  it("orders by updated_at desc and exposes message_count flattened off the embedded aggregate", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        makeRow({ id: "t1", updated_at: "2026-04-25T00:00:00Z", count: 7 }),
        makeRow({ id: "t2", updated_at: "2026-04-24T00:00:00Z", is_active: false, count: 2 })
      ],
      error: null
    });
    const db = makeDb(c);
    const rows = await listThreadsForBusiness(BIZ, {}, db as never);
    expect(db.from).toHaveBeenCalledWith("dashboard_chat_threads");
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "t1", message_count: 7 });
    expect(rows[1]).toMatchObject({ id: "t2", message_count: 2, is_active: false });
    // The embedded aggregate field must be stripped — leaking PostgREST
    // shape into the API surface would couple every consumer to it.
    expect(rows[0]).not.toHaveProperty("dashboard_chat_messages");
  });

  it("defaults limit to 50 and forwards an explicit override", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listThreadsForBusiness(BIZ, {}, makeDb(c) as never);
    expect(c.limit).toHaveBeenLastCalledWith(50);
    c.limit.mockClear();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listThreadsForBusiness(BIZ, { limit: 5 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenLastCalledWith(5);
  });

  it("returns an empty array when PostgREST resolves with no rows (data: null)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: null });
    await expect(listThreadsForBusiness(BIZ, {}, makeDb(c) as never)).resolves.toEqual([]);
  });

  it("coerces a missing/non-array embed to message_count: 0 (defends against future PostgREST shape drift)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        // explicit-array, count missing entirely
        { ...THREAD, id: "t-no-count", dashboard_chat_messages: [{}] },
        // explicit-array, count is non-numeric
        { ...THREAD, id: "t-bad", dashboard_chat_messages: [{ count: "nope" as unknown as number }] },
        // null embed
        { ...THREAD, id: "t-null", dashboard_chat_messages: null },
        // missing embed key
        { ...THREAD, id: "t-missing" }
      ],
      error: null
    });
    const rows = await listThreadsForBusiness(BIZ, {}, makeDb(c) as never);
    expect(rows.map((r) => [r.id, r.message_count])).toEqual([
      ["t-no-count", 0],
      ["t-bad", 0],
      ["t-null", 0],
      ["t-missing", 0]
    ]);
  });

  it("throws on db error", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: { message: "rls" } });
    await expect(listThreadsForBusiness(BIZ, {}, makeDb(c) as never)).rejects.toThrow(
      /listThreadsForBusiness: rls/
    );
  });
});

describe("db/dashboard-chat — serializeChatMessages", () => {
  it("renames created_at to createdAt and drops the thread_id column — matches API envelope shape", () => {
    expect(
      serializeChatMessages([
        {
          id: 1,
          thread_id: "t",
          role: "user",
          content: "hi",
          created_at: "2026-04-23T00:00:00Z"
        },
        {
          id: 2,
          thread_id: "t",
          role: "assistant",
          content: "hello",
          created_at: "2026-04-23T00:00:01Z"
        }
      ])
    ).toEqual([
      { id: 1, role: "user", content: "hi", createdAt: "2026-04-23T00:00:00Z" },
      { id: 2, role: "assistant", content: "hello", createdAt: "2026-04-23T00:00:01Z" }
    ]);
  });
});

describe("db/dashboard-chat — reactivateThread", () => {
  // The helper issues TWO update statements:
  //   Step 1 (deactivate-others): .update(...).eq("business_id", ...)
  //                                .eq("is_active", true).neq("id", target)
  //   Step 2 (activate-target):   .update(...).eq("id", target)
  //                                .eq("business_id", ...)
  // Step 1 terminates on `.neq`, step 2 terminates on the SECOND `.eq`.
  // The mock chain has to honor both sequences without breaking the
  // proxy contract (every non-terminal call must return the chain).

  function makeReactivateChain(opts: {
    deactivateError?: { message: string } | null;
    activateError?: { message: string } | null;
  }): Chain {
    const c = chain();
    // .neq is terminal for the deactivate statement.
    c.neq = vi.fn(() =>
      Promise.resolve({ error: opts.deactivateError ?? null })
    ) as Chain["neq"];
    // The activate statement's terminal is its SECOND .eq call. We
    // count eq invocations and resolve when call #4 lands (eq #1 + #2
    // are step 1's chain prefix → returns chain; #3 + #4 are step 2 →
    // #4 is the terminal). All non-terminal calls return the chain.
    let eqCount = 0;
    c.eq = vi.fn(() => {
      eqCount += 1;
      if (eqCount === 4) {
        return Promise.resolve({
          error: opts.activateError ?? null
        }) as unknown as Chain;
      }
      return c;
    }) as Chain["eq"];
    return c;
  }

  it("issues deactivate-others-then-activate as two scoped UPDATEs", async () => {
    const c = makeReactivateChain({});
    const db = makeDb(c);
    await reactivateThread(BIZ, "thread-target", db as never);
    // First UPDATE: archives anything currently active for the business
    // *except* the target. This is the partial-unique-index-friendly
    // way to flip the "active" pointer atomically — without this
    // ordering we'd briefly violate dashboard_chat_threads_one_active.
    expect(c.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ is_active: false })
    );
    expect(c.neq).toHaveBeenCalledWith("id", "thread-target");
    // Second UPDATE: activates the target, scoped to (id, business_id)
    // so a forged threadId can't be reactivated under the wrong tenant.
    expect(c.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ is_active: true })
    );
    // Step 2 must scope the activation by both id AND business_id.
    const eqCalls = (c.eq as ReturnType<typeof vi.fn>).mock.calls;
    expect(eqCalls).toContainEqual(["id", "thread-target"]);
    expect(eqCalls).toContainEqual(["business_id", BIZ]);
  });

  it("throws when the deactivate UPDATE fails — second UPDATE never runs", async () => {
    const c = makeReactivateChain({ deactivateError: { message: "deact bad" } });
    await expect(
      reactivateThread(BIZ, "t", makeDb(c) as never)
    ).rejects.toThrow(/reactivateThread\/deactivate: deact bad/);
    // Critical: when the deactivate fails we MUST NOT proceed to the
    // activate — that would risk two active rows once the partial
    // unique index is restored.
    expect(c.update).toHaveBeenCalledTimes(1);
  });

  it("throws when the activate UPDATE fails (deactivate already ran — caller may need recovery)", async () => {
    const c = makeReactivateChain({ activateError: { message: "act bad" } });
    await expect(
      reactivateThread(BIZ, "t", makeDb(c) as never)
    ).rejects.toThrow(/reactivateThread\/activate: act bad/);
    expect(c.update).toHaveBeenCalledTimes(2);
  });
});

describe("db/dashboard-chat — updateThreadSummary", () => {
  it("writes summary_md + summary_message_count on the thread row", async () => {
    const c = chain();
    c.lte.mockResolvedValue({ error: null });
    await updateThreadSummary("thread-1", "compact summary", 42, makeDb(c) as never);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({
        summary_md: "compact summary",
        summary_message_count: 42
      })
    );
    expect(c.eq).toHaveBeenCalledWith("id", "thread-1");
  });

  it("guards against older-snapshot overwrites with .lte('summary_message_count', messageCount) — concurrent summarizer runs only land if their snapshot is fresher than what's stored", async () => {
    // Two summarizer runs can overlap (fire-and-forget). If the slow
    // run lands second with a STALER snapshot, an unguarded UPDATE
    // would regress summary_message_count and re-open the summarize
    // gate prematurely. The .lte predicate makes the UPDATE a no-op
    // when the stored count is already higher.
    const c = chain();
    c.lte.mockResolvedValue({ error: null });
    await updateThreadSummary("thread-1", "x", 42, makeDb(c) as never);
    expect(c.lte).toHaveBeenCalledWith("summary_message_count", 42);
  });

  it("bumps updated_at on the thread row so the sidebar's order-by-updated_at-desc surfaces freshly-summarized threads", async () => {
    const c = chain();
    c.lte.mockResolvedValue({ error: null });
    await updateThreadSummary("thread-1", "x", 1, makeDb(c) as never);
    const update = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(update.updated_at).toBeTypeOf("string");
  });

  it("throws on db error", async () => {
    const c = chain();
    c.lte.mockResolvedValue({ error: { message: "rls fail" } });
    await expect(
      updateThreadSummary("thread-1", "x", 1, makeDb(c) as never)
    ).rejects.toThrow(/updateThreadSummary: rls fail/);
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
    // getThreadById
    {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: THREAD, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(getThreadById("thread-1")).resolves.toEqual(THREAD);
    }
    // listThreadsForBusiness
    {
      const c = chain();
      c.limit.mockResolvedValue({ data: [], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(listThreadsForBusiness(BIZ)).resolves.toEqual([]);
    }
    // reactivateThread — minimal happy-path stub so the default-client
    // import path is exercised. .neq terminates step 1; the 4th .eq
    // call terminates step 2.
    {
      const c = chain();
      c.neq = vi.fn(() => Promise.resolve({ error: null })) as Chain["neq"];
      let eqCount = 0;
      c.eq = vi.fn(() => {
        eqCount += 1;
        if (eqCount === 4) {
          return Promise.resolve({ error: null }) as unknown as Chain;
        }
        return c;
      }) as Chain["eq"];
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(reactivateThread(BIZ, "t")).resolves.toBeUndefined();
    }
    // updateThreadSummary
    {
      const c = chain();
      c.lte.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(c));
      await expect(updateThreadSummary("t", "s", 5)).resolves.toBeUndefined();
    }
  });
});
