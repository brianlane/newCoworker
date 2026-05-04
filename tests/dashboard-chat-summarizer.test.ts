import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  shouldSummarize,
  SUMMARY_INTERVAL,
  SUMMARY_MAX_CHARS,
  SUMMARY_TAIL_KEEP,
  summarizeThread,
  summarizeThreadAndLog
} from "@/lib/dashboard-chat/summarizer";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";

const THREAD = {
  id: THREAD_ID,
  business_id: BIZ,
  rowboat_conversation_id: null,
  rowboat_state: null,
  title: "old chat",
  is_active: false,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-30T00:00:00Z",
  summary_md: null,
  summary_message_count: 0
};

function makeMessages(count: number): Array<{
  id: number;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}> {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    thread_id: THREAD_ID,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i + 1}`,
    created_at: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`
  }));
}

type Deps = NonNullable<Parameters<typeof summarizeThread>[2]>;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    callRowboatChat: vi.fn().mockResolvedValue({
      reply: "compact summary text",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }),
    getThreadById: vi.fn().mockResolvedValue(THREAD),
    listMessages: vi.fn().mockResolvedValue(makeMessages(50)),
    updateThreadSummary: vi.fn().mockResolvedValue(undefined),
    getBusinessConfig: vi.fn().mockResolvedValue({
      rowboat_project_id: "proj-1"
    }),
    rowboatBearer: "bearer-xyz",
    ...overrides
  } as Deps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ROWBOAT_VPS_CHAT_BEARER;
  delete process.env.ROWBOAT_GATEWAY_TOKEN;
  delete process.env.ROWBOAT_DEFAULT_PROJECT_ID;
});

describe("dashboard-chat summarizer — shouldSummarize gate", () => {
  it("fires once 20+ new messages have accrued since the last summary", () => {
    expect(shouldSummarize({ summary_message_count: 0 }, SUMMARY_INTERVAL)).toBe(true);
    expect(shouldSummarize({ summary_message_count: 0 }, SUMMARY_INTERVAL - 1)).toBe(false);
    expect(shouldSummarize({ summary_message_count: 30 }, 50)).toBe(true);
    expect(shouldSummarize({ summary_message_count: 30 }, 49)).toBe(false);
  });

  it("treats summary_message_count: null/undefined as 0 (fresh thread, no summary yet)", () => {
    // A thread that's never been summarized has summary_message_count
    // = 0 by the migration default; the helper should still fire as
    // soon as the message count crosses the interval. Defending against
    // null defensively in case a future migration nullable-ifies it.
    expect(
      shouldSummarize(
        { summary_message_count: null as unknown as number },
        20
      )
    ).toBe(true);
  });
});

describe("dashboard-chat summarizer — summarizeThread happy path", () => {
  it("calls Rowboat with a stateless system+user message pair, persists the trimmed reply, and reports the message count it covered", async () => {
    const deps = makeDeps();
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({
      ok: true,
      summary: "compact summary text",
      messageCount: 50,
      projectId: "proj-1"
    });
    // Stateless invocation — must NOT pass conversationId/state, or
    // the model's chat-mode rolling state would taint the summary.
    expect(deps.callRowboatChat).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        projectId: "proj-1",
        bearer: "bearer-xyz",
        conversationId: null,
        state: null
      })
    );
    // Persists with the OVERALL message count, not just the summarized
    // slice — the trigger gate compares against total messages.
    expect(deps.updateThreadSummary).toHaveBeenCalledWith(
      THREAD_ID,
      "compact summary text",
      50
    );
  });

  it("only summarizes messages OLDER than the live tail (last SUMMARY_TAIL_KEEP messages stay raw on the next chat call)", async () => {
    const deps = makeDeps();
    await summarizeThread(BIZ, THREAD_ID, deps);
    const sentMessages = (deps.callRowboatChat as ReturnType<typeof vi.fn>).mock
      .calls[0][0].messages as Array<{ role: string; content: string }>;
    // First message is the SUMMARIZER MODE system instruction.
    expect(sentMessages[0].role).toBe("system");
    expect(sentMessages[0].content).toMatch(/SUMMARIZER MODE/);
    // Second is the user message containing the transcript. The
    // transcript MUST exclude the most recent SUMMARY_TAIL_KEEP=20.
    // A 50-message thread → summarize messages 1..30, leave 31..50
    // for the live tail.
    const transcript = sentMessages[1].content;
    expect(transcript).toContain("msg 1");
    expect(transcript).toContain("msg 30");
    expect(transcript).not.toContain("msg 31");
    expect(transcript).not.toContain("msg 50");
  });

  it("renders messages with [Owner]/[Coworker]/[System] labels — model-friendly format", async () => {
    // Mix in a system-role message so all three label branches are
    // exercised (real conversations occasionally accrue them via
    // tool/agent transitions).
    const mixed = [
      ...makeMessages(SUMMARY_TAIL_KEEP + 1),
      {
        id: 999,
        thread_id: THREAD_ID,
        role: "system" as const,
        content: "system event",
        created_at: "2026-04-30T00:00:00Z"
      },
      ...makeMessages(SUMMARY_TAIL_KEEP)
    ];
    const deps = makeDeps({ listMessages: vi.fn().mockResolvedValue(mixed) });
    await summarizeThread(BIZ, THREAD_ID, deps);
    const sentMessages = (deps.callRowboatChat as ReturnType<typeof vi.fn>).mock
      .calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(sentMessages[1].content).toContain("[Owner]:");
    expect(sentMessages[1].content).toContain("[Coworker]:");
    expect(sentMessages[1].content).toContain("[System]: system event");
  });

  it("falls back to env bearer when none is supplied via deps", async () => {
    process.env.ROWBOAT_VPS_CHAT_BEARER = "env-bearer";
    const deps = makeDeps({ rowboatBearer: undefined });
    await summarizeThread(BIZ, THREAD_ID, deps);
    expect(deps.callRowboatChat).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: "env-bearer" })
    );
  });

  it("falls back to ROWBOAT_GATEWAY_TOKEN when ROWBOAT_VPS_CHAT_BEARER is unset", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-token";
    const deps = makeDeps({ rowboatBearer: undefined });
    await summarizeThread(BIZ, THREAD_ID, deps);
    expect(deps.callRowboatChat).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: "gw-token" })
    );
  });

  it("hard-truncates to SUMMARY_MAX_CHARS so a runaway model can't dominate the prompt", async () => {
    const huge = "x".repeat(SUMMARY_MAX_CHARS + 500);
    const deps = makeDeps({
      callRowboatChat: vi.fn().mockResolvedValue({
        reply: huge,
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.length).toBe(SUMMARY_MAX_CHARS);
    }
    expect(deps.updateThreadSummary).toHaveBeenCalledWith(
      THREAD_ID,
      expect.stringMatching(/^x{2000}$/),
      50
    );
  });
});

describe("dashboard-chat summarizer — failure modes (never throws)", () => {
  it("returns thread_not_found and SKIPS Rowboat when the thread row vanished", async () => {
    const deps = makeDeps({
      getThreadById: vi.fn().mockResolvedValue(null)
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({ ok: false, reason: "thread_not_found" });
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
    expect(deps.updateThreadSummary).not.toHaveBeenCalled();
  });

  it("returns db_failed when getThreadById throws (caller must not crash on a transient DB blip)", async () => {
    const deps = makeDeps({
      getThreadById: vi.fn().mockRejectedValue(new Error("conn refused"))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "db_failed" });
    if (!result.ok) expect(result.detail).toMatch(/conn refused/);
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
  });

  it("returns db_failed when getBusinessConfig throws — preserves the never-throw contract direct callers depend on", async () => {
    const deps = makeDeps({
      getBusinessConfig: vi.fn().mockRejectedValue(new Error("rls denied"))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "db_failed" });
    if (!result.ok) expect(result.detail).toMatch(/rls denied/);
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
  });

  it("returns no_project_id when the business has no rowboat project (chat itself 409s here too)", async () => {
    const deps = makeDeps({
      getBusinessConfig: vi.fn().mockResolvedValue({ rowboat_project_id: null })
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({ ok: false, reason: "no_project_id" });
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
  });

  it("returns no_bearer when neither dep nor env supplies a bearer (config bug, not an outage)", async () => {
    const deps = makeDeps({ rowboatBearer: undefined });
    // No env vars set in beforeEach — afterEach guarantees a clean slate.
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({ ok: false, reason: "no_bearer" });
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
  });

  it("returns db_failed when listMessages throws", async () => {
    const deps = makeDeps({
      listMessages: vi.fn().mockRejectedValue(new Error("rls denied"))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "db_failed" });
    if (!result.ok) expect(result.detail).toMatch(/rls denied/);
  });

  it("returns below_threshold when the thread has fewer than SUMMARY_TAIL_KEEP messages (nothing to summarize that isn't already in the live tail)", async () => {
    const deps = makeDeps({
      listMessages: vi.fn().mockResolvedValue(makeMessages(SUMMARY_TAIL_KEEP))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({ ok: false, reason: "below_threshold" });
    expect(deps.callRowboatChat).not.toHaveBeenCalled();
    expect(deps.updateThreadSummary).not.toHaveBeenCalled();
  });

  it("returns rowboat_failed when callRowboatChat rejects (timeout, 5xx, etc.) — caller's POST stays alive", async () => {
    const deps = makeDeps({
      callRowboatChat: vi.fn().mockRejectedValue(new Error("rowboat_timeout"))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "rowboat_failed" });
    if (!result.ok) expect(result.detail).toMatch(/rowboat_timeout/);
    // Rowboat failed → must not write a stale/empty summary.
    expect(deps.updateThreadSummary).not.toHaveBeenCalled();
  });

  it("returns empty_summary when the model replies with whitespace only", async () => {
    const deps = makeDeps({
      callRowboatChat: vi.fn().mockResolvedValue({
        reply: "   \n   ",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toEqual({ ok: false, reason: "empty_summary" });
    // Empty summary → don't poison the thread row with garbage.
    expect(deps.updateThreadSummary).not.toHaveBeenCalled();
  });

  it("returns db_failed when updateThreadSummary throws after a successful Rowboat call", async () => {
    const deps = makeDeps({
      updateThreadSummary: vi.fn().mockRejectedValue(new Error("write fail"))
    });
    const result = await summarizeThread(BIZ, THREAD_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "db_failed" });
    if (!result.ok) expect(result.detail).toMatch(/write fail/);
  });
});

describe("dashboard-chat summarizer — summarizeThreadAndLog wrapper", () => {
  it("logs structured success — projectId + messageCount + summaryChars for observability", async () => {
    const deps = makeDeps();
    await summarizeThreadAndLog(BIZ, THREAD_ID, deps);
    expect(logger.info).toHaveBeenCalledWith(
      "dashboard-chat summarizer ok",
      expect.objectContaining({
        businessId: BIZ,
        threadId: THREAD_ID,
        projectId: "proj-1",
        messageCount: 50,
        summaryChars: "compact summary text".length
      })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs structured failure WITHOUT throwing so the fire-and-forget chat POST never breaks", async () => {
    const deps = makeDeps({
      callRowboatChat: vi.fn().mockRejectedValue(new Error("rowboat_http_500"))
    });
    await expect(summarizeThreadAndLog(BIZ, THREAD_ID, deps)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "dashboard-chat summarizer failed",
      expect.objectContaining({
        businessId: BIZ,
        threadId: THREAD_ID,
        reason: "rowboat_failed"
      })
    );
  });

  it("never rejects — even when summarizeThread isn't called via the deps surface (no-op env)", async () => {
    // Belt-and-suspenders: invoke with default deps and no env. The
    // wrapper's job is to be safe regardless of caller hygiene.
    await expect(summarizeThreadAndLog(BIZ, THREAD_ID, makeDeps({
      rowboatBearer: undefined
    }))).resolves.toBeUndefined();
  });
});
