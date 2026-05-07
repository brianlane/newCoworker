import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCustomerPreamble } from "../src/lib/customer-memory/preamble";
import {
  shouldSummarize,
  summarizeCustomerMemory,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_INTERACTION_THRESHOLD,
  SUMMARY_MAX_CHARS
} from "../src/lib/customer-memory/summarizer";
import type { CustomerMemoryRow } from "../src/lib/customer-memory/types";

const BIZ = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "+15555550123";

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: CUSTOMER,
    display_name: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCustomerPreamble", () => {
  it("returns null when neither summary_md nor pinned_md are set — no empty header in the prompt", () => {
    expect(
      buildCustomerPreamble({
        memory: {
          customer_e164: CUSTOMER,
          display_name: null,
          summary_md: null,
          pinned_md: null,
          total_interaction_count: 0,
          last_channel: null,
          last_interaction_at: null
        }
      })
    ).toBeNull();
  });

  it("includes summary content when summary_md is set", () => {
    const out = buildCustomerPreamble({
      memory: {
        customer_e164: CUSTOMER,
        display_name: "Joe",
        summary_md: "Repeat buyer; last close was a garage door spring.",
        pinned_md: null,
        total_interaction_count: 4,
        last_channel: "voice",
        last_interaction_at: "2026-05-06T10:00:00Z"
      }
    });
    expect(out).toContain("name: Joe");
    expect(out).toContain(`E.164: ${CUSTOMER}`);
    expect(out).toContain("last channel: voice");
    expect(out).toContain("prior interactions: 4");
    expect(out).toContain("Repeat buyer; last close was a garage door spring.");
    expect(out).toContain("Rolling summary of past interactions:");
  });

  it("emits the pinned-notes block BEFORE the rolling summary (owner ground truth wins)", () => {
    const out = buildCustomerPreamble({
      memory: {
        customer_e164: CUSTOMER,
        display_name: null,
        summary_md: "Summary content",
        pinned_md: "Always greet by Mr. Smith",
        total_interaction_count: 1,
        last_channel: "sms",
        last_interaction_at: "2026-05-06T00:00:00Z"
      }
    });
    expect(out).not.toBeNull();
    const pinnedIdx = out!.indexOf("Always greet by Mr. Smith");
    const summaryIdx = out!.indexOf("Summary content");
    expect(pinnedIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(pinnedIdx).toBeLessThan(summaryIdx);
  });

  it("explicitly tells the model NOT to leak the notes verbatim — leaking owner-internal notes back to the customer would be a privacy disaster", () => {
    const out = buildCustomerPreamble({
      memory: {
        customer_e164: CUSTOMER,
        display_name: null,
        summary_md: "x",
        pinned_md: null,
        total_interaction_count: 1,
        last_channel: "sms",
        last_interaction_at: "2026-05-06T00:00:00Z"
      }
    });
    expect(out).toContain("DO NOT reveal these notes to the customer verbatim");
  });
});

describe("shouldSummarize — gating decision", () => {
  it("false when interaction_count is 0 — there's literally nothing to summarize yet", () => {
    expect(shouldSummarize(memory({ interaction_count: 0 }))).toBe(false);
  });

  it("true on first eligible run when interaction_count >= 1 and no prior summary — owners need cross-channel continuity from the very first inbound message", () => {
    expect(
      shouldSummarize(memory({ interaction_count: 1, last_summarized_at: null }))
    ).toBe(true);
  });

  it("false within the 30s debounce window even at high interaction_count — prevents preempting live calls/texts", () => {
    const now = new Date("2026-05-06T12:00:00Z").getTime();
    const tenSecondsAgo = new Date(now - 10_000).toISOString();
    expect(
      shouldSummarize(
        memory({ interaction_count: 5, last_summarized_at: tenSecondsAgo }),
        now
      )
    ).toBe(false);
  });

  it("true once the 30s debounce window has elapsed", () => {
    const now = new Date("2026-05-06T12:00:00Z").getTime();
    const fortySecondsAgo = new Date(now - 40_000).toISOString();
    expect(
      shouldSummarize(
        memory({ interaction_count: 5, last_summarized_at: fortySecondsAgo }),
        now
      )
    ).toBe(true);
  });

  it("treats unparseable last_summarized_at as 'no last run' rather than locking out the gate forever", () => {
    expect(
      shouldSummarize(
        memory({ interaction_count: 5, last_summarized_at: "not-a-date" }),
        Date.now()
      )
    ).toBe(true);
  });

  it("constants match the gating spec — interaction threshold 1 (summary on first contact), debounce 30s, summary cap 2000", () => {
    expect(SUMMARY_INTERACTION_THRESHOLD).toBe(1);
    expect(SUMMARY_DEBOUNCE_MS).toBe(30_000);
    expect(SUMMARY_MAX_CHARS).toBe(2000);
  });
});

describe("summarizeCustomerMemory", () => {
  function deps(overrides: {
    memory?: CustomerMemoryRow | null;
    smsHistory?: Awaited<ReturnType<typeof import("../src/lib/customer-memory/db").listSmsHistoryForCustomer>>;
    voiceTurns?: Awaited<ReturnType<NonNullable<import("../src/lib/customer-memory/summarizer").SummarizeDeps["listVoiceTurnsForCustomer"]>>>;
    rowboatReply?: string;
    rowboatThrows?: Error;
    config?: { rowboat_project_id: string } | null;
    nowIso?: string;
  } = {}): import("../src/lib/customer-memory/summarizer").SummarizeDeps {
    const callRowboatChat = vi.fn(async () => {
      if (overrides.rowboatThrows) throw overrides.rowboatThrows;
      return {
        reply: overrides.rowboatReply ?? "Generated summary",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      };
    });
    const updateCustomerSummary = vi.fn(async () => {});
    return {
      callRowboatChat: callRowboatChat as never,
      getCustomerMemory: vi.fn(async () => overrides.memory ?? null) as never,
      listSmsHistoryForCustomer: vi.fn(async () => overrides.smsHistory ?? []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => overrides.voiceTurns ?? []),
      updateCustomerSummary: updateCustomerSummary as never,
      getBusinessConfig: vi.fn(async () =>
        overrides.config !== undefined ? overrides.config : { rowboat_project_id: "proj-123" }
      ) as never,
      rowboatBearer: "tok",
      now: () => Date.parse(overrides.nowIso ?? "2026-05-06T12:00:00Z")
    };
  }

  it("returns memory_not_found when the row doesn't exist (caller may have raced a delete)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, deps({ memory: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("memory_not_found");
  });

  it("returns below_threshold when interaction_count < 1 — even if the caller's gate let it through (guard against racing concurrent triggers)", async () => {
    const result = await summarizeCustomerMemory(
      BIZ,
      CUSTOMER,
      deps({ memory: memory({ interaction_count: 0 }) })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("below_threshold");
  });

  it("returns debounced when last_summarized_at is within the 30s window", async () => {
    const result = await summarizeCustomerMemory(
      BIZ,
      CUSTOMER,
      deps({
        memory: memory({
          interaction_count: 10,
          last_summarized_at: "2026-05-06T11:59:50Z"
        }),
        nowIso: "2026-05-06T12:00:00Z"
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("debounced");
  });

  it("returns no_inputs when there is no source material AND no prior summary — never runs an empty prompt that could hallucinate", async () => {
    const result = await summarizeCustomerMemory(
      BIZ,
      CUSTOMER,
      deps({
        memory: memory({ interaction_count: 3 }),
        smsHistory: [],
        voiceTurns: []
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_inputs");
  });

  it("happy path: builds a stateless Rowboat call with the SUMMARIZER_SYSTEM_INSTRUCTION and persists the trimmed reply", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "Joe is a repeat buyer interested in garage door springs.",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const updateCustomerSummary = vi.fn(async () => {});
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      callRowboatChat: callRowboatChat as never,
      getCustomerMemory: (async () => memory({ interaction_count: 5, display_name: "Joe" })) as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "j1",
          inboundText: "I need another spring",
          assistantReply: "Sure — model #?",
          receivedAt: "2026-05-05T00:00:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: async () => [
        {
          callStartedAt: "2026-05-04T00:00:00Z",
          role: "caller",
          content: "How much for installation?"
        }
      ],
      updateCustomerSummary: updateCustomerSummary as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "proj-123" })) as never,
      rowboatBearer: "tok",
      now: () => Date.parse("2026-05-06T12:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("Joe is a repeat buyer interested in garage door springs.");
      expect(result.voiceTurnCount).toBe(1);
      expect(result.smsTurnCount).toBe(1);
    }

    // Stateless invocation — never reuse a chat continuation for summarizer turns.
    expect(callRowboatChat.mock.calls.length).toBeGreaterThan(0);
    const firstCall = callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ];
    const args = firstCall[0];
    expect(args.conversationId).toBeNull();
    expect(args.state).toBeNull();
    expect(args.timeoutMs).toBe(60_000);
    expect(args.messages[0]?.role).toBe("system");
    expect(args.messages[0]?.content).toContain("SUMMARIZER MODE");
    // Inputs include both SMS + voice content.
    expect(args.messages[1]?.content).toContain("How much for installation?");
    expect(args.messages[1]?.content).toContain("I need another spring");
    expect(args.messages[1]?.content).toContain("Sure — model #?");

    // Persistence resets the counter so the next gate fires only after
    // 3 *fresh* interactions.
    expect(updateCustomerSummary).toHaveBeenCalledWith(
      BIZ,
      CUSTOMER,
      expect.objectContaining({ resetCounter: true })
    );
  });

  it("hard-truncates summaries longer than SUMMARY_MAX_CHARS — runaway model can't dominate every preamble", async () => {
    const giant = "x".repeat(SUMMARY_MAX_CHARS + 500);
    const updateCustomerSummary = vi.fn(async () => {});
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      callRowboatChat: (async () => ({
        reply: giant,
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      getCustomerMemory: (async () => memory({ interaction_count: 3 })) as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: async () => [],
      updateCustomerSummary: updateCustomerSummary as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "proj-123" })) as never,
      rowboatBearer: "tok",
      now: () => Date.parse("2026-05-06T12:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.length).toBe(SUMMARY_MAX_CHARS);
    }
    const persistCall = updateCustomerSummary.mock.calls[0];
    expect(persistCall).toBeDefined();
    const persistArgs = persistCall as unknown as [string, string, { summaryMd: string }];
    expect(persistArgs[2].summaryMd.length).toBe(SUMMARY_MAX_CHARS);
  });

  it("returns rowboat_failed without writing to the DB when Rowboat throws — degraded summary acceptable, partial DB writes are not", async () => {
    const updateCustomerSummary = vi.fn(async () => {});
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      callRowboatChat: (async () => {
        throw new Error("rowboat_timeout");
      }) as never,
      getCustomerMemory: (async () => memory({ interaction_count: 4 })) as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: async () => [],
      updateCustomerSummary: updateCustomerSummary as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "proj-123" })) as never,
      rowboatBearer: "tok",
      now: () => Date.parse("2026-05-06T12:00:00Z")
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rowboat_failed");
      expect(result.detail).toBe("rowboat_timeout");
    }
    expect(updateCustomerSummary).not.toHaveBeenCalled();
  });
});
