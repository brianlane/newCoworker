import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  insertChatJob,
  getChatJobById,
  getInFlightChatJobForThread,
  IN_FLIGHT_CHAT_JOB_MAX_AGE_MS,
  serializeChatJobStatus,
  type DashboardChatJobRow
} from "@/lib/db/dashboard-chat-jobs";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
    gte: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn()
  };
  return c;
}

function makeDb(c: Chain) {
  return { from: vi.fn(() => c) };
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const THREAD = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const USER_MSG_ID = 42;

const FAKE_INPUT = [
  { role: "system" as const, content: "OWNER MODE..." },
  { role: "user" as const, content: "[Dashboard] hi" }
];

const FAKE_STATELESS = [
  ...FAKE_INPUT.slice(0, 1),
  { role: "system" as const, content: "Recent conversation context: ..." },
  FAKE_INPUT[1]
];

const FAKE_STATE = { agentId: "rep-1", lastTool: "search" };

const ROW_FIXTURE: DashboardChatJobRow = {
  id: JOB_ID,
  business_id: BIZ,
  thread_id: THREAD,
  user_message_id: USER_MSG_ID,
  status: "queued",
  attempts: 0,
  claimed_by: null,
  claimed_at: null,
  assistant_message_id: null,
  input_messages: FAKE_INPUT,
  stateless_input_messages: FAKE_STATELESS,
  rowboat_conversation_id: "rb-conv",
  rowboat_state: FAKE_STATE,
  start_agent: null,
  error_code: null,
  error_detail: null,
  created_at: "2026-05-08T16:00:00Z",
  started_at: null,
  completed_at: null
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insertChatJob", () => {
  it("forwards every required column to the insert payload", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ROW_FIXTURE, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    const row = await insertChatJob({
      businessId: BIZ,
      threadId: THREAD,
      userMessageId: USER_MSG_ID,
      inputMessages: FAKE_INPUT,
      statelessInputMessages: FAKE_STATELESS,
      rowboatConversationId: "rb-conv",
      rowboatState: FAKE_STATE,
      startAgent: "OwnerCoworker"
    });

    expect(row).toEqual(ROW_FIXTURE);
    expect(c.insert).toHaveBeenCalledWith({
      business_id: BIZ,
      thread_id: THREAD,
      user_message_id: USER_MSG_ID,
      input_messages: FAKE_INPUT,
      stateless_input_messages: FAKE_STATELESS,
      rowboat_conversation_id: "rb-conv",
      rowboat_state: FAKE_STATE,
      start_agent: "OwnerCoworker"
    });
  });

  it("passes statelessInputMessages = null through to the row (fresh-thread case has no fallback)", async () => {
    const c = chain();
    c.single.mockResolvedValue({
      data: { ...ROW_FIXTURE, stateless_input_messages: null },
      error: null
    });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await insertChatJob({
      businessId: BIZ,
      threadId: THREAD,
      userMessageId: USER_MSG_ID,
      inputMessages: FAKE_INPUT,
      statelessInputMessages: null,
      rowboatConversationId: null,
      rowboatState: null
    });

    const insertedPayload = c.insert.mock.calls[0][0];
    expect(insertedPayload.stateless_input_messages).toBeNull();
    expect(insertedPayload.rowboat_conversation_id).toBeNull();
    expect(insertedPayload.rowboat_state).toBeNull();
  });

  it("throws when supabase returns an error — caller can rely on a thrown Error to surface as a 500", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "boom" } });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await expect(
      insertChatJob({
        businessId: BIZ,
        threadId: THREAD,
        userMessageId: USER_MSG_ID,
        inputMessages: FAKE_INPUT,
        statelessInputMessages: null,
        rowboatConversationId: null,
        rowboatState: null
      })
    ).rejects.toThrow(/insertChatJob.*boom/);
  });
});

describe("getChatJobById", () => {
  it("returns null when the row doesn't exist (idempotent on stale id)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    const row = await getChatJobById(JOB_ID);
    expect(row).toBeNull();
  });

  it("returns the row when present", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ROW_FIXTURE, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    const row = await getChatJobById(JOB_ID);
    expect(row).toEqual(ROW_FIXTURE);
  });

  it("throws on supabase error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "rls denied" } });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await expect(getChatJobById(JOB_ID)).rejects.toThrow(/getChatJobById.*rls denied/);
  });
});

describe("getInFlightChatJobForThread", () => {
  it("returns the newest still-running job for the thread (default service client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ROW_FIXTURE, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    const row = await getInFlightChatJobForThread(THREAD);

    expect(row).toEqual(ROW_FIXTURE);
    // Only queued/processing rows for THIS thread, freshest first, capped at 1.
    expect(c.eq).toHaveBeenCalledWith("thread_id", THREAD);
    expect(c.in).toHaveBeenCalledWith("status", ["queued", "processing"]);
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(1);
    // The freshness floor is "now minus the max-age window".
    const gteArg = c.gte.mock.calls[0];
    expect(gteArg[0]).toBe("created_at");
    const floorMs = Date.parse(gteArg[1] as string);
    expect(Date.now() - floorMs).toBeGreaterThanOrEqual(IN_FLIGHT_CHAT_JOB_MAX_AGE_MS - 5000);
    expect(Date.now() - floorMs).toBeLessThanOrEqual(IN_FLIGHT_CHAT_JOB_MAX_AGE_MS + 5000);
  });

  it("uses the explicit client when one is passed (no default service client created)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });

    const row = await getInFlightChatJobForThread(THREAD, makeDb(c) as never);

    expect(row).toBeNull();
    expect(defaultClientSpy).not.toHaveBeenCalled();
  });

  it("throws on supabase error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "rls denied" } });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await expect(getInFlightChatJobForThread(THREAD)).rejects.toThrow(
      /getInFlightChatJobForThread.*rls denied/
    );
  });
});

describe("serializeChatJobStatus", () => {
  it("drops worker-internal fields the browser MUST NOT see", async () => {
    const out = serializeChatJobStatus(ROW_FIXTURE);
    // input_messages and stateless_input_messages contain system
    // preambles (OWNER_PREAMBLE, customer memories) the user shouldn't
    // see in raw form. claimed_by/claimed_at and attempts are
    // worker-internal accounting. rowboat_conversation_id is opaque.
    expect(out).not.toHaveProperty("input_messages");
    expect(out).not.toHaveProperty("stateless_input_messages");
    expect(out).not.toHaveProperty("claimed_by");
    expect(out).not.toHaveProperty("claimed_at");
    expect(out).not.toHaveProperty("attempts");
    expect(out).not.toHaveProperty("rowboat_conversation_id");
    expect(out).not.toHaveProperty("rowboat_state");
    expect(out).not.toHaveProperty("business_id");
  });

  it("exposes exactly the fields the client renders against", async () => {
    const out = serializeChatJobStatus(ROW_FIXTURE);
    expect(out).toEqual({
      id: JOB_ID,
      threadId: THREAD,
      userMessageId: USER_MSG_ID,
      status: "queued",
      assistantMessageId: null,
      errorCode: null,
      errorDetail: null,
      createdAt: ROW_FIXTURE.created_at,
      startedAt: null,
      completedAt: null
    });
  });

  it("surfaces error_code + error_detail when the worker reports a failure", async () => {
    const out = serializeChatJobStatus({
      ...ROW_FIXTURE,
      status: "error",
      error_code: "rowboat_http_500",
      error_detail: "upstream sad"
    });
    expect(out.status).toBe("error");
    expect(out.errorCode).toBe("rowboat_http_500");
    expect(out.errorDetail).toBe("upstream sad");
  });
});
