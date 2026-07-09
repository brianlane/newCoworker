import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Targeted coverage for the "default `listEmailLogForAddress`" fallback in
 * src/lib/customer-memory/summarizer.ts (the
 * `deps.listEmailLogForAddress ?? defaultListEmailLogForAddress` line).
 *
 * Why a separate file: the rest of the summarizer suite always injects a
 * `listEmailLogForAddress` dep for hermeticity, so the imported default never
 * runs there. A dedicated mini-suite fills that one branch without disturbing
 * the other tests (mirrors the default-voice-turns coverage file).
 */

vi.mock("@/lib/db/email-log", () => ({
  listEmailLogForAddress: vi.fn(async () => [
    {
      id: "e1",
      business_id: "00000000-0000-0000-0000-000000000001",
      direction: "inbound" as const,
      to_email: "biz@example.com",
      from_email: "joe@acme.com",
      subject: "Quote?",
      body_preview: "Can you send a quote?",
      cc_email: null,
      bcc_email: null,
      source: "tenant_mailbox_inbound" as const,
      run_id: null,
      flow_id: null,
      provider_message_id: null,
      created_at: "2026-05-04T00:00:00Z"
    }
  ])
}));

import { summarizeCustomerMemory } from "../src/lib/customer-memory/summarizer";
import { listEmailLogForAddress } from "../src/lib/db/email-log";
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
    type: "customer",
    name_source: "auto",
    sms_reply_mode: "auto",
    display_name: null,
    email: "joe@acme.com",
    summary_md: null,
    pinned_md: null,
    interaction_count: 4,
    total_interaction_count: 4,
    last_interaction_at: "2026-05-05T09:00:00Z",
    last_summarized_at: null,
    last_channel: "voice",
    alias_e164s: [],
    tags: [],
    owner_employee_id: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-05T09:00:00Z",
    ...overrides
  };
}

describe("summarizeCustomerMemory — default listEmailLogForAddress path", () => {
  it("uses the imported listEmailLogForAddress when no dep override is supplied", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "Joe emailed asking for a quote.",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory()) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p-123" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      // INTENTIONALLY OMIT listEmailLogForAddress — exercises the ?? fallback.
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    expect(listEmailLogForAddress).toHaveBeenCalledWith(
      BIZ,
      "joe@acme.com",
      expect.objectContaining({ limit: expect.any(Number) })
    );
  });
});
