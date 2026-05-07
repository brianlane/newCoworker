import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Targeted coverage for the "default `listVoiceTurnsForCustomer`"
 * fallback in src/lib/customer-memory/summarizer.ts (lines ~222-223
 * in the source, the inline async wrapper that calls
 * defaultListVoiceTurns).
 *
 * Why a separate file: the rest of the summarizer test suite always
 * provides a `listVoiceTurnsForCustomer` dep so the helper code under
 * test never runs. Filling that gap inline would mean refactoring
 * the existing tests to drop the dep, which changes their meaning.
 * A dedicated mini-suite keeps the rest of the coverage stable.
 */

vi.mock("@/lib/db/voice-transcripts", () => ({
  listVoiceTurnsForCustomer: vi.fn(async () => [
    {
      callStartedAt: "2026-05-05T09:00:00Z",
      role: "caller" as const,
      content: "Hello",
      transcriptId: "t-1"
    },
    // Drop callStartedAt to exercise the `?? "1970-01-01T00:00:00Z"`
    // fallback inside the wrapper — the summarizer must never let
    // a literal "null" reach the model.
    {
      callStartedAt: null,
      role: "assistant" as const,
      content: "Hi",
      transcriptId: "t-1"
    }
  ])
}));

import { summarizeCustomerMemory } from "../src/lib/customer-memory/summarizer";
import { listVoiceTurnsForCustomer } from "../src/lib/db/voice-transcripts";
import type { CustomerMemoryRow } from "../src/lib/customer-memory/types";

const BIZ = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "+15555550123";

afterEach(() => {
  vi.clearAllMocks();
});

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: CUSTOMER,
    display_name: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 4,
    total_interaction_count: 4,
    last_interaction_at: "2026-05-05T09:00:00Z",
    last_summarized_at: null,
    last_channel: "voice",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-05T09:00:00Z",
    ...overrides
  };
}

describe("summarizeCustomerMemory — default listVoiceTurnsForCustomer path", () => {
  it("uses the imported listVoiceTurnsForCustomer when no dep override is supplied AND maps null callStartedAt to ISO epoch (no literal 'null' in the prompt)", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "Joe called once and asked about garage doors.",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory()) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p-123" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      // INTENTIONALLY OMIT listVoiceTurnsForCustomer — exercises the
      // ?? fallback in summarizer.ts.
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    expect(listVoiceTurnsForCustomer).toHaveBeenCalledWith(
      BIZ,
      CUSTOMER,
      expect.objectContaining({ maxCalls: expect.any(Number) })
    );
    // The fallback inlines `?? "1970-01-01T00:00:00Z"` for missing
    // timestamps — verify by inspecting the user message Rowboat saw.
    const args = (callRowboatChat.mock.calls as unknown as Array<[{
      messages: Array<{ role: string; content: string }>;
    }]>)[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = args.messages[1]?.content ?? "";
    expect(user).toContain("Recent voice call transcripts");
    // The "null" timestamp turn rendered with the epoch fallback —
    // the literal string "null" must NEVER appear inside a turn
    // header or the model will echo it back into its summary.
    expect(user).toContain("[1970-01-01T00:00:00Z VOICE AI assistant]");
    expect(user).not.toMatch(/\[null VOICE/);
  });
});
