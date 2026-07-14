import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

/**
 * Chainable + thenable PostgREST builder stub (same pattern as
 * tests/agent-tool-settings.test.ts): every chain method returns the
 * builder; awaiting it (or .single()/.maybeSingle()) resolves the
 * configured result.
 */
function makeBuilder(result: StubResult) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "gte", "order", "limit", "insert", "update", "delete"]) {
    b[m] = vi.fn(() => b);
  }
  b.single = vi.fn(async () => result);
  b.maybeSingle = vi.fn(async () => result);
  b.then = (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return b;
}

const supabaseStub = { from: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

import {
  appendWebchatMessage,
  claimWebchatJobForPlatform,
  completeWebchatJobFromPlatform,
  countWebchatUserMessagesSince,
  createWebchatSession,
  deleteWebchatMessage,
  failWebchatJobFromPlatform,
  getOrCreateWidgetSettings,
  getWebchatJobById,
  getWebchatJobForUserMessage,
  getWebchatMessageByClientId,
  getWebchatSessionById,
  getWebchatSessionByTokenHash,
  getWidgetSettingsByKeyHash,
  getWidgetSettingsForBusiness,
  insertWebchatJob,
  isWebchatUniqueViolation,
  listWebchatMessages,
  listWebchatMessagesSince,
  listWebchatSessionsForBusiness,
  regenerateWidgetKey,
  serializeWebchatMessages,
  touchWebchatSession,
  updateWebchatSessionContact,
  updateWidgetSettings,
  webchatReplyEngine,
  WEBCHAT_PLATFORM_WORKER_ID,
  type WebchatMessageRow
} from "@/lib/webchat/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

// The injected-client variant reuses the same stub so queued
// mockReturnValueOnce builders serve both call styles.
const injected = supabaseStub as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("serializeWebchatMessages", () => {
  it("projects the API envelope", () => {
    const rows: WebchatMessageRow[] = [
      {
        id: 7,
        session_id: SESSION,
        business_id: BIZ,
        role: "assistant",
        content: "hi",
        created_at: "2026-07-10T00:00:00Z"
      }
    ];
    expect(serializeWebchatMessages(rows)).toEqual([
      { id: 7, role: "assistant", content: "hi", createdAt: "2026-07-10T00:00:00Z" }
    ]);
  });
});

describe("chat_widget_settings accessors", () => {
  it("getWidgetSettingsForBusiness returns the row / null / throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { business_id: BIZ }, error: null }));
    expect(await getWidgetSettingsForBusiness(BIZ)).toEqual({ business_id: BIZ });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWidgetSettingsForBusiness(BIZ, injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWidgetSettingsForBusiness(BIZ)).rejects.toThrow(
      "getWidgetSettingsForBusiness: x"
    );
  });

  it("getWidgetSettingsByKeyHash returns the row / null / throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { business_id: BIZ }, error: null }));
    expect(await getWidgetSettingsByKeyHash("h")).toEqual({ business_id: BIZ });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWidgetSettingsByKeyHash("h", injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWidgetSettingsByKeyHash("h")).rejects.toThrow("getWidgetSettingsByKeyHash: x");
  });

  it("getOrCreateWidgetSettings returns an existing row without inserting", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { business_id: BIZ }, error: null }));
    expect(await getOrCreateWidgetSettings(BIZ)).toEqual({ business_id: BIZ });
    expect(supabaseStub.from).toHaveBeenCalledTimes(1);
  });

  it("getOrCreateWidgetSettings mints a disabled row with a fresh key on first touch", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    const insertBuilder = makeBuilder({ data: { business_id: BIZ, enabled: false }, error: null });
    supabaseStub.from.mockReturnValueOnce(insertBuilder);
    expect(await getOrCreateWidgetSettings(BIZ, injected)).toEqual({
      business_id: BIZ,
      enabled: false
    });
    const inserted = (insertBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted.enabled).toBe(false);
    expect(inserted.public_key).toMatch(/^ncw_pub_[0-9a-f]{64}$/);
    expect(inserted.public_key_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getOrCreateWidgetSettings re-reads the winner on an insert race, else surfaces the error", async () => {
    // Race: miss → insert fails → winner re-read.
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "dup" } }));
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { business_id: BIZ }, error: null }));
    expect(await getOrCreateWidgetSettings(BIZ)).toEqual({ business_id: BIZ });

    // No winner: the original insert error surfaces.
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "dup" } }));
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    await expect(getOrCreateWidgetSettings(BIZ)).rejects.toThrow("getOrCreateWidgetSettings: dup");
  });

  it("updateWidgetSettings patches + stamps updated_at, throws on error", async () => {
    const builder = makeBuilder({ data: { business_id: BIZ, enabled: true }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await updateWidgetSettings(BIZ, { enabled: true })).toEqual({
      business_id: BIZ,
      enabled: true
    });
    const patch = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch.enabled).toBe(true);
    expect(typeof patch.updated_at).toBe("string");

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(updateWidgetSettings(BIZ, { enabled: false }, injected)).rejects.toThrow(
      "updateWidgetSettings: x"
    );
  });

  it("regenerateWidgetKey rotates to a fresh key pair, throws on error", async () => {
    const builder = makeBuilder({ data: { business_id: BIZ }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await regenerateWidgetKey(BIZ);
    const patch = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch.public_key).toMatch(/^ncw_pub_[0-9a-f]{64}$/);
    expect(patch.public_key_sha256).toMatch(/^[0-9a-f]{64}$/);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(regenerateWidgetKey(BIZ, injected)).rejects.toThrow("regenerateWidgetKey: x");
  });
});

describe("webchat_sessions accessors", () => {
  it("createWebchatSession trims contact fields and coerces empties to null", async () => {
    const builder = makeBuilder({ data: { id: SESSION }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await createWebchatSession(BIZ, "hash", { name: "  Ada ", email: "", phone: undefined }))
      .toEqual({ id: SESSION });
    const inserted = (builder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted).toMatchObject({
      business_id: BIZ,
      session_token_sha256: "hash",
      visitor_name: "Ada",
      visitor_email: null,
      visitor_phone: null
    });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(createWebchatSession(BIZ, "hash", {}, injected)).rejects.toThrow(
      "createWebchatSession: x"
    );
  });

  it("getWebchatSessionByTokenHash returns row / null / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { id: SESSION }, error: null }));
    expect(await getWebchatSessionByTokenHash("h")).toEqual({ id: SESSION });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWebchatSessionByTokenHash("h", injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWebchatSessionByTokenHash("h")).rejects.toThrow(
      "getWebchatSessionByTokenHash: x"
    );
  });

  it("updateWebchatSessionContact merges only non-empty values and no-ops on an empty patch", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await updateWebchatSessionContact(SESSION, { name: " Ada ", email: "a@b.com", phone: "  " });
    const patch = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch).toEqual({ visitor_name: "Ada", visitor_email: "a@b.com" });

    // Empty patch: no DB call at all.
    supabaseStub.from.mockClear();
    await updateWebchatSessionContact(SESSION, { name: "", phone: null }, injected);
    expect(supabaseStub.from).not.toHaveBeenCalled();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(updateWebchatSessionContact(SESSION, { phone: "+1555" })).rejects.toThrow(
      "updateWebchatSessionContact: x"
    );
  });

  it("getWebchatSessionById returns row / null / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { id: SESSION }, error: null }));
    expect(await getWebchatSessionById(SESSION)).toEqual({ id: SESSION });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWebchatSessionById(SESSION, injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWebchatSessionById(SESSION)).rejects.toThrow("getWebchatSessionById: x");
  });

  it("touchWebchatSession bumps last_seen_at, throws on error", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await touchWebchatSession(SESSION);
    expect(builder.update).toHaveBeenCalled();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(touchWebchatSession(SESSION, injected)).rejects.toThrow("touchWebchatSession: x");
  });

  it("listWebchatSessionsForBusiness attaches embed counts defensively", async () => {
    const rows = [
      { id: "s1", webchat_messages: [{ count: 4 }] },
      { id: "s2", webchat_messages: null },
      { id: "s3", webchat_messages: [{ count: "garbage" }] },
      { id: "s4", webchat_messages: [] }
    ];
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: rows, error: null }));
    const out = await listWebchatSessionsForBusiness(BIZ);
    expect(out.map((s) => s.message_count)).toEqual([4, 0, 0, 0]);
    expect(out[0]).not.toHaveProperty("webchat_messages");

    // Custom limit + null data + error paths.
    const limited = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(limited);
    expect(await listWebchatSessionsForBusiness(BIZ, { limit: 5 }, injected)).toEqual([]);
    expect(limited.limit).toHaveBeenCalledWith(5);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(listWebchatSessionsForBusiness(BIZ)).rejects.toThrow(
      "listWebchatSessionsForBusiness: x"
    );
  });
});

describe("webchat_messages accessors", () => {
  it("appendWebchatMessage inserts the row (with the idempotency key when given), throws on error", async () => {
    const builder = makeBuilder({ data: { id: 1 }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await appendWebchatMessage(SESSION, BIZ, "user", "hi")).toEqual({ id: 1 });
    expect(builder.insert).toHaveBeenCalledWith({
      session_id: SESSION,
      business_id: BIZ,
      role: "user",
      content: "hi",
      client_message_id: null
    });

    const keyed = makeBuilder({ data: { id: 2 }, error: null });
    supabaseStub.from.mockReturnValueOnce(keyed);
    await appendWebchatMessage(SESSION, BIZ, "user", "hi", { clientMessageId: "cid-1" });
    expect((keyed.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      client_message_id: "cid-1"
    });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(appendWebchatMessage(SESSION, BIZ, "user", "hi", {}, injected)).rejects.toThrow(
      "appendWebchatMessage: x"
    );
  });

  it("isWebchatUniqueViolation matches 23505 / duplicate-key shapes only", () => {
    expect(isWebchatUniqueViolation(new Error("appendWebchatMessage: 23505"))).toBe(true);
    expect(isWebchatUniqueViolation(new Error("duplicate key value violates"))).toBe(true);
    expect(isWebchatUniqueViolation("Duplicate Key somewhere")).toBe(true);
    expect(isWebchatUniqueViolation(new Error("connection reset"))).toBe(false);
  });

  it("getWebchatMessageByClientId returns row / null / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { id: 3 }, error: null }));
    expect(await getWebchatMessageByClientId(SESSION, "cid")).toEqual({ id: 3 });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWebchatMessageByClientId(SESSION, "cid", injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWebchatMessageByClientId(SESSION, "cid")).rejects.toThrow(
      "getWebchatMessageByClientId: x"
    );
  });

  it("deleteWebchatMessage deletes by id, throws on error", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await deleteWebchatMessage(9);
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", 9);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(deleteWebchatMessage(9, injected)).rejects.toThrow("deleteWebchatMessage: x");
  });

  it("listWebchatMessages returns rows / [] / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: [{ id: 1 }], error: null }));
    expect(await listWebchatMessages(SESSION)).toEqual([{ id: 1 }]);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await listWebchatMessages(SESSION, injected)).toEqual([]);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(listWebchatMessages(SESSION)).rejects.toThrow("listWebchatMessages: x");
  });

  it("listWebchatMessagesSince cursors by id, throws on error", async () => {
    const builder = makeBuilder({ data: [{ id: 9 }], error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await listWebchatMessagesSince(SESSION, 8)).toEqual([{ id: 9 }]);
    expect(builder.gt).toHaveBeenCalledWith("id", 8);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await listWebchatMessagesSince(SESSION, 0, injected)).toEqual([]);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(listWebchatMessagesSince(SESSION, 0)).rejects.toThrow(
      "listWebchatMessagesSince: x"
    );
  });

  it("countWebchatUserMessagesSince returns the count / 0 / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ count: 12, error: null }));
    expect(await countWebchatUserMessagesSince(BIZ, "2026-01-01")).toBe(12);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ count: null, error: null }));
    expect(await countWebchatUserMessagesSince(BIZ, "2026-01-01", injected)).toBe(0);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ count: null, error: { message: "x" } }));
    await expect(countWebchatUserMessagesSince(BIZ, "2026-01-01")).rejects.toThrow(
      "countWebchatUserMessagesSince: x"
    );
  });
});

describe("webchat_jobs accessors", () => {
  const jobInput = {
    businessId: BIZ,
    sessionId: SESSION,
    userMessageId: 5,
    inputMessages: [{ role: "user" as const, content: "hi" }],
    statelessInputMessages: null,
    rowboatConversationId: null
  };

  it("insertWebchatJob maps camelCase → columns, throws on error", async () => {
    const builder = makeBuilder({ data: { id: JOB }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await insertWebchatJob(jobInput)).toEqual({ id: JOB });
    expect(builder.insert).toHaveBeenCalledWith({
      business_id: BIZ,
      session_id: SESSION,
      user_message_id: 5,
      input_messages: jobInput.inputMessages,
      stateless_input_messages: null,
      rowboat_conversation_id: null
    });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(insertWebchatJob(jobInput, injected)).rejects.toThrow("insertWebchatJob: x");
  });

  it("getWebchatJobForUserMessage returns the newest job / null / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { id: JOB }, error: null }));
    expect(await getWebchatJobForUserMessage(5)).toEqual({ id: JOB });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWebchatJobForUserMessage(5, injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWebchatJobForUserMessage(5)).rejects.toThrow("getWebchatJobForUserMessage: x");
  });

  it("getWebchatJobById returns row / null / throws", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: { id: JOB }, error: null }));
    expect(await getWebchatJobById(JOB)).toEqual({ id: JOB });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getWebchatJobById(JOB, injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getWebchatJobById(JOB)).rejects.toThrow("getWebchatJobById: x");
  });

  it("getWebchatJobById selects the pre-built turn inputs for the Gemini engine", async () => {
    const builder = makeBuilder({ data: { id: JOB }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await getWebchatJobById(JOB);
    const selected = (builder.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(selected).toContain("input_messages");
    expect(selected).toContain("stateless_input_messages");
  });
});

describe("webchatReplyEngine", () => {
  it("reads 'gemini' only when stored exactly, defaulting everything else to 'vps'", () => {
    expect(webchatReplyEngine({ reply_engine: "gemini" })).toBe("gemini");
    expect(webchatReplyEngine({ reply_engine: "vps" })).toBe("vps");
    expect(webchatReplyEngine({})).toBe("vps");
    expect(webchatReplyEngine({ reply_engine: undefined })).toBe("vps");
  });
});

describe("platform-engine job lifecycle", () => {
  const jobRow = { id: JOB, session_id: SESSION, business_id: BIZ };

  it("claimWebchatJobForPlatform claims a queued job with the conditional update", async () => {
    const builder = makeBuilder({ data: { id: JOB, status: "processing" }, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    expect(await claimWebchatJobForPlatform(JOB)).toEqual({ id: JOB, status: "processing" });
    const patch = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch).toMatchObject({
      status: "processing",
      claimed_by: WEBCHAT_PLATFORM_WORKER_ID
    });
    expect(typeof patch.claimed_at).toBe("string");
    // The queued-only filter IS the race lock against a live worker.
    expect(builder.eq).toHaveBeenCalledWith("id", JOB);
    expect(builder.eq).toHaveBeenCalledWith("status", "queued");
  });

  it("claimWebchatJobForPlatform returns null on a lost race, throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await claimWebchatJobForPlatform(JOB, injected)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(claimWebchatJobForPlatform(JOB)).rejects.toThrow(
      "claimWebchatJobForPlatform: x"
    );
  });

  it("completeWebchatJobFromPlatform persists the reply, bumps the session, flips the job", async () => {
    const msgBuilder = makeBuilder({ data: { id: 42 }, error: null });
    const sessionBuilder = makeBuilder({ data: null, error: null });
    const jobBuilder = makeBuilder({ data: null, error: null });
    supabaseStub.from
      .mockReturnValueOnce(msgBuilder)
      .mockReturnValueOnce(sessionBuilder)
      .mockReturnValueOnce(jobBuilder);

    expect(await completeWebchatJobFromPlatform(jobRow, "Reply text")).toBe(42);
    expect((msgBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      session_id: SESSION,
      business_id: BIZ,
      role: "assistant",
      content: "Reply text"
    });
    expect((jobBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: "done",
      assistant_message_id: 42,
      error_code: null,
      error_detail: null
    });
  });

  it("completeWebchatJobFromPlatform tolerates session-bump and job-flip failures (reply already persisted)", async () => {
    supabaseStub.from
      .mockReturnValueOnce(makeBuilder({ data: { id: 43 }, error: null }))
      .mockReturnValueOnce(makeBuilder({ data: null, error: { message: "session down" } }))
      .mockReturnValueOnce(makeBuilder({ data: null, error: { message: "job down" } }));
    expect(await completeWebchatJobFromPlatform(jobRow, "Reply", injected)).toBe(43);
  });

  it("completeWebchatJobFromPlatform surfaces a failed message insert", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(completeWebchatJobFromPlatform(jobRow, "Reply")).rejects.toThrow(
      "appendWebchatMessage: x"
    );
  });

  it("failWebchatJobFromPlatform bounds the stored taxonomy, throws on error", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await failWebchatJobFromPlatform(JOB, "c".repeat(200), "d".repeat(600));
    const patch = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch.status).toBe("error");
    expect((patch.error_code as string).length).toBe(100);
    expect((patch.error_detail as string).length).toBe(500);

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(failWebchatJobFromPlatform(JOB, "code", "detail", injected)).rejects.toThrow(
      "failWebchatJobFromPlatform: x"
    );
  });
});
