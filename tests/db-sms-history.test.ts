import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import {
  customerE164FromPayload,
  inboundTextFromPayload,
  listConversationsForBusiness,
  listMessagesForCustomer
} from "@/lib/db/sms-history";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn()
  };
  return c;
}

/**
 * Fake Supabase client routing `sms_inbound_jobs` to `c` and
 * `sms_outbound_log` to `outbound` (default: an empty result, so the many
 * inbound-focused tests don't need to care about the merge).
 */
function makeDb(c: Chain, outbound?: Chain) {
  let oc = outbound;
  if (!oc) {
    oc = chain();
    oc.limit.mockResolvedValue({ data: [], error: null });
  }
  return {
    from: vi.fn((table: string) => (table === "sms_outbound_log" ? oc : c))
  };
}

function outboundLogRow(args: {
  id?: string;
  to?: string;
  body?: string;
  source?: string;
  created_at?: string;
}) {
  return {
    id: args.id ?? "ob1",
    business_id: "biz",
    to_e164: args.to ?? "+15551111111",
    from_e164: "+16025550000",
    body: args.body ?? "flow message",
    source: args.source ?? "ai_flow",
    run_id: "run-1",
    flow_id: "flow-1",
    telnyx_message_id: "tm-1",
    created_at: args.created_at ?? "2026-05-05T03:00:00Z"
  };
}

function envelope(args: {
  from?: string | { phone_number?: string } | null;
  text?: string | null;
  body?: string | null;
}): Record<string, unknown> {
  return {
    data: {
      payload: {
        from: args.from === undefined ? { phone_number: "+15551111111" } : args.from,
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.body !== undefined ? { body: args.body } : {})
      }
    }
  };
}

beforeEach(() => {
  defaultClientSpy.mockReset();
});

describe("customerE164FromPayload", () => {
  it("extracts from {phone_number}", () => {
    expect(customerE164FromPayload(envelope({}))).toBe("+15551111111");
  });

  it("extracts when from is a bare E.164 string (legacy webhook shape)", () => {
    expect(
      customerE164FromPayload(envelope({ from: "+15552222222" }))
    ).toBe("+15552222222");
  });

  it("returns null for non-E.164 strings", () => {
    expect(customerE164FromPayload(envelope({ from: "5551234567" }))).toBeNull();
  });

  it("returns null when from object lacks phone_number", () => {
    expect(
      customerE164FromPayload(envelope({ from: { phone_number: "+15551111111" } }))
    ).toBe("+15551111111");
    expect(
      customerE164FromPayload(envelope({ from: {} }))
    ).toBeNull();
  });

  it("returns null on bad / non-object payloads", () => {
    expect(customerE164FromPayload(null)).toBeNull();
    expect(customerE164FromPayload(undefined)).toBeNull();
    expect(customerE164FromPayload({})).toBeNull();
    expect(customerE164FromPayload({ data: {} })).toBeNull();
    expect(customerE164FromPayload({ data: { payload: null } } as never)).toBeNull();
  });

  it("rejects a phone_number that doesn't start with +", () => {
    expect(
      customerE164FromPayload(envelope({ from: { phone_number: "15551234567" } }))
    ).toBeNull();
  });

  it("accepts SHORT CODE senders (ReferralExchange texts from 73339)", () => {
    expect(customerE164FromPayload(envelope({ from: "73339" }))).toBe("73339");
    expect(
      customerE164FromPayload(envelope({ from: { phone_number: "73339" } }))
    ).toBe("73339");
  });

  it("still rejects bare 10/11-digit numbers (full phones must be E.164, not guessed)", () => {
    expect(customerE164FromPayload(envelope({ from: "5551234567" }))).toBeNull();
    expect(customerE164FromPayload(envelope({ from: "15551234567" }))).toBeNull();
  });
});

describe("inboundTextFromPayload", () => {
  it("prefers `text`", () => {
    expect(inboundTextFromPayload(envelope({ text: "hi" }))).toBe("hi");
  });

  it("falls back to `body`", () => {
    expect(inboundTextFromPayload(envelope({ text: undefined, body: "hello" }))).toBe(
      "hello"
    );
  });

  it("returns empty string for missing/non-string text", () => {
    expect(inboundTextFromPayload(envelope({}))).toBe("");
    expect(inboundTextFromPayload(null)).toBe("");
    expect(inboundTextFromPayload(undefined)).toBe("");
    // Defensively reject numeric body — Telnyx never returns this, but
    // a future schema drift shouldn't crash the dashboard.
    expect(
      inboundTextFromPayload({
        data: { payload: { text: 1, body: 2 } }
      } as never)
    ).toBe("");
  });

  it("hits the `data?.payload ?? {}` fallback when data exists but payload is missing", () => {
    // Branch coverage: {data:{}} (payload undefined) must yield "" rather
    // than throw on indexing into undefined.
    expect(inboundTextFromPayload({ data: {} } as never)).toBe("");
    expect(
      inboundTextFromPayload({ data: { payload: undefined } } as never)
    ).toBe("");
  });

  it("reads RCS nested body.text and tapped-suggestion labels", () => {
    expect(
      inboundTextFromPayload({
        data: { payload: { type: "RCS", body: { text: "hello rcs" } } }
      } as never)
    ).toBe("hello rcs");
    expect(
      inboundTextFromPayload({
        data: {
          payload: {
            type: "RCS",
            body: { suggestion_response: { text: "Yes, confirm", postback_data: "c1" } }
          }
        }
      } as never)
    ).toBe("Yes, confirm");
  });

  it("returns empty for RCS bodies without text (file/location) and odd shapes", () => {
    expect(
      inboundTextFromPayload({
        data: { payload: { type: "RCS", body: { user_file: { payload: {} } } } }
      } as never)
    ).toBe("");
    expect(
      inboundTextFromPayload({
        data: { payload: { type: "RCS", body: { suggestion_response: { postback_data: "x" } } } }
      } as never)
    ).toBe("");
    expect(
      inboundTextFromPayload({
        data: { payload: { type: "RCS", body: { suggestion_response: "nope" } } }
      } as never)
    ).toBe("");
    expect(
      inboundTextFromPayload({ data: { payload: { type: "RCS", body: [] } } } as never)
    ).toBe("");
  });
});

describe("listConversationsForBusiness", () => {
  it("groups rows by sender, sorted by most-recent activity", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j2",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15552222222" }, text: "newer" }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T01:00:00Z",
          updated_at: "2026-05-05T01:00:00Z"
        },
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "older1" }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        },
        {
          id: "j0",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "older0" }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-04T22:00:00Z",
          updated_at: "2026-05-04T22:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c) as never);
    expect(result.map((r) => r.customerE164)).toEqual([
      "+15552222222",
      "+15551111111"
    ]);
    // Counts are now EXPANDED (matches listMessagesForCustomer):
    // each job with both inbound + outbound expands to 2 messages.
    // +15552222222: 1 job × 2 = 2; +15551111111: 2 jobs × 2 = 4.
    expect(result[0]?.messageCount).toBe(2);
    expect(result[1]?.messageCount).toBe(4);
    expect(result[0]?.lastMessage).toBe("newer");
    expect(result[1]?.lastMessage).toBe("older1");
  });

  it("sorts conversations DESC by lastMessageAt across 3+ customers (exercises both comparator branches)", async () => {
    const c = chain();
    // Insertion order is intentionally NOT pre-sorted so the comparator
    // must take both `<` and `>=` branches across multiple sort steps.
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15551111111" },
            text: "older"
          }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        },
        {
          id: "j2",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15552222222" },
            text: "newest"
          }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T02:00:00Z",
          updated_at: "2026-05-05T02:00:00Z"
        },
        {
          id: "j3",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15553333333" },
            text: "middle"
          }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T01:00:00Z",
          updated_at: "2026-05-05T01:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c) as never);
    expect(result.map((r) => r.customerE164)).toEqual([
      "+15552222222",
      "+15553333333",
      "+15551111111"
    ]);
  });

  it("falls back to messageCount=1 when neither side parses (defensive: never let the row vanish from the index)", async () => {
    // Two rows from the same customer with NEITHER inbound text NOR
    // outbound reply (pathological — Telnyx schema drift, partial
    // failure mid-write). Index must still surface the conversation
    // with a stable count rather than dropping it.
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j-empty-1",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15555555555" },
            text: undefined
          }),
          status: "pending",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:01:00Z",
          updated_at: "2026-05-05T00:01:00Z"
        },
        {
          id: "j-empty-2",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15555555555" },
            text: undefined
          }),
          status: "pending",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness(
      "biz",
      {},
      makeDb(c) as never
    );
    expect(result[0]?.customerE164).toBe("+15555555555");
    // Two un-parseable rows = two defensive +1 increments.
    expect(result[0]?.messageCount).toBe(2);
    expect(result[0]?.lastMessage).toBe("(no text)");
  });

  it("messageCount matches what listMessagesForCustomer would expand the same rows to (bugbot regression)", async () => {
    // PR #69 bugbot: index page showed `3 msgs` while the thread page
    // rendered `5 messages`. Pin the contract: per-job message count
    // === inbound-text? + outbound-reply? expanded count.
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        // Inbound only, no reply → 1 message
        {
          id: "j-in",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15554444444" },
            text: "hi"
          }),
          status: "pending",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:02:00Z",
          updated_at: "2026-05-05T00:02:00Z"
        },
        // Inbound + reply → 2 messages
        {
          id: "j-pair",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15554444444" },
            text: "hello"
          }),
          status: "done",
          rowboat_reply_cached: "hi back",
          telnyx_outbound_message_id: "out-1",
          last_error: null,
          created_at: "2026-05-05T00:01:00Z",
          updated_at: "2026-05-05T00:01:01Z"
        },
        // Reply only (rare — admin-replied with no inbound text) → 1 message
        {
          id: "j-out",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15554444444" },
            text: undefined
          }),
          status: "done",
          rowboat_reply_cached: "ping",
          telnyx_outbound_message_id: "out-2",
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness(
      "biz",
      {},
      makeDb(c) as never
    );
    // 1 (inbound-only) + 2 (paired) + 1 (outbound-only) = 4 expanded.
    expect(result[0]?.messageCount).toBe(4);
  });

  it("uses the assistant reply as the preview when no inbound text is parseable", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" } }),
          status: "done",
          rowboat_reply_cached: "Hello from the assistant",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c) as never);
    expect(result[0]?.lastMessage).toBe("Hello from the assistant");
  });

  it('falls back to "(no text)" when nothing is recoverable', async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" } }),
          status: "dead_letter",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: "boom",
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c) as never);
    expect(result[0]?.lastMessage).toBe("(no text)");
  });

  it("skips rows whose envelope is unparseable", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "junk",
          business_id: "biz",
          // No `from` at all — must be filtered.
          payload: { data: { payload: { text: "stray" } } },
          status: "done",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c) as never);
    expect(result).toEqual([]);
  });

  it("clamps caller-supplied limit and slices after grouping", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listConversationsForBusiness(
      "biz",
      { limit: 99999 },
      makeDb(c) as never
    );
    // 200 max * 4x over-fetch = 800.
    expect(c.limit).toHaveBeenCalledWith(800);
  });

  it("clamps tiny / non-numeric limits", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listConversationsForBusiness("biz", { limit: 0 }, makeDb(c) as never);
    // 1 * 4 = 4.
    expect(c.limit).toHaveBeenCalledWith(4);
  });

  it("surfaces query errors", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: { message: "db boom" } });
    await expect(
      listConversationsForBusiness("biz", {}, makeDb(c) as never)
    ).rejects.toThrow(/db boom/);
  });

  it("handles null data (Supabase returns null when nothing matches)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listConversationsForBusiness("biz", {}, makeDb(c) as never)
    ).resolves.toEqual([]);
  });

  it("uses the default service client when none is injected", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockResolvedValueOnce(makeDb(c));
    await expect(listConversationsForBusiness("biz")).resolves.toEqual([]);
  });

  it("creates a conversation from worker-initiated sends alone (AiFlow lead with no inbound yet)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    const oc = chain();
    oc.limit.mockResolvedValue({
      data: [
        outboundLogRow({ id: "ob1", to: "+14695555555", body: "Hi, I'd love to help you sell." })
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c, oc) as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      customerE164: "+14695555555",
      lastMessage: "Hi, I'd love to help you sell.",
      lastStatus: "done",
      messageCount: 1
    });
  });

  it("merges worker sends into an existing conversation: newer send takes the preview, older only counts", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "inbound hi" }),
          status: "done",
          rowboat_reply_cached: "reply",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T01:00:00Z",
          updated_at: "2026-05-05T01:00:00Z"
        }
      ],
      error: null
    });
    const oc = chain();
    oc.limit.mockResolvedValue({
      data: [
        outboundLogRow({
          id: "ob-new",
          body: "newer flow send",
          created_at: "2026-05-05T02:00:00Z"
        }),
        outboundLogRow({
          id: "ob-old",
          body: "older flow send",
          created_at: "2026-05-05T00:00:00Z"
        })
      ],
      error: null
    });
    const result = await listConversationsForBusiness("biz", {}, makeDb(c, oc) as never);
    expect(result).toHaveLength(1);
    // 2 expanded inbound-job messages + 2 log rows.
    expect(result[0]?.messageCount).toBe(4);
    expect(result[0]?.lastMessage).toBe("newer flow send");
    expect(result[0]?.lastMessageAt).toBe("2026-05-05T02:00:00Z");
  });

  it("surfaces outbound-log query errors", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    const oc = chain();
    oc.limit.mockResolvedValue({ data: null, error: { message: "log boom" } });
    await expect(
      listConversationsForBusiness("biz", {}, makeDb(c, oc) as never)
    ).rejects.toThrow(/log boom/);
  });

  it("handles null outbound-log data", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    const oc = chain();
    oc.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listConversationsForBusiness("biz", {}, makeDb(c, oc) as never)
    ).resolves.toEqual([]);
  });
});

describe("listMessagesForCustomer", () => {
  it("expands each row into inbound + outbound messages, in chronological order", async () => {
    const c = chain();
    // Supabase returns DESC (newest first) per the query — the helper
    // must reverse internally so the UI sees oldest→newest.
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j2",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15551111111" },
            text: "anyone home?"
          }),
          status: "done",
          rowboat_reply_cached: "yes",
          telnyx_outbound_message_id: "out-2",
          last_error: null,
          created_at: "2026-05-05T00:01:00Z",
          updated_at: "2026-05-05T00:01:01Z"
        },
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15551111111" },
            text: "hi"
          }),
          status: "done",
          rowboat_reply_cached: "hello back",
          telnyx_outbound_message_id: "out-1",
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    expect(result).toHaveLength(4);
    expect(result.map((m) => `${m.direction}:${m.content}`)).toEqual([
      "inbound:hi",
      "outbound:hello back",
      "inbound:anyone home?",
      "outbound:yes"
    ]);
  });

  it("tags messages with the channel from the job row / outbound log row", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j-rcs",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "done",
          assistant_reply_text: "hello back",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: "out-1",
          last_error: null,
          channel: "rcs",
          reply_channel: "rcs",
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        },
        {
          id: "j-rcs-sms-fallback",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi again" }),
          status: "done",
          assistant_reply_text: "fallback reply",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: "out-2",
          last_error: null,
          // RCS inbound whose reply went out over plain SMS (RCS rejected):
          // the outbound bubble must badge sms, not inherit the inbound rcs.
          channel: "rcs",
          reply_channel: "sms",
          created_at: "2026-05-05T00:30:00Z",
          updated_at: "2026-05-05T00:30:01Z"
        },
        {
          id: "j-sms",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "legacy" }),
          status: "done",
          assistant_reply_text: null,
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          // No channel/reply_channel column values (legacy row) → sms.
          created_at: "2026-05-04T00:00:00Z",
          updated_at: "2026-05-04T00:00:01Z"
        }
      ],
      error: null
    });
    const oc = chain();
    oc.limit.mockResolvedValue({
      data: [
        { ...outboundLogRow({ id: "ob-rcs", created_at: "2026-05-05T01:00:00Z" }), channel: "rcs" },
        outboundLogRow({ id: "ob-sms", created_at: "2026-05-05T02:00:00Z" })
      ],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c, oc) as never);
    const byId = new Map(result.map((m) => [m.id, m.channel]));
    expect(byId.get("j-rcs:inbound")).toBe("rcs");
    expect(byId.get("j-rcs:outbound")).toBe("rcs");
    // Inbound badge follows the inbound channel; the outbound badge follows
    // the reply's OWN delivery channel (SMS fallback after RCS rejection).
    expect(byId.get("j-rcs-sms-fallback:inbound")).toBe("rcs");
    expect(byId.get("j-rcs-sms-fallback:outbound")).toBe("sms");
    expect(byId.get("j-sms:inbound")).toBe("sms");
    expect(byId.get("ob-rcs:flow-outbound")).toBe("rcs");
    expect(byId.get("ob-sms:flow-outbound")).toBe("sms");
  });

  it("surfaces a delivered reply from assistant_reply_text even after the retry cache was cleared", async () => {
    // The core bug: after a successful Telnyx send the worker nulls
    // rowboat_reply_cached, so reading only that column dropped every
    // delivered reply. assistant_reply_text is the durable copy.
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "done",
          assistant_reply_text: "hello back",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: "out-1",
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c) as never);
    expect(result.map((m) => `${m.direction}:${m.content}`)).toEqual([
      "inbound:hi",
      "outbound:hello back"
    ]);
  });

  it("prefers assistant_reply_text over a stale rowboat_reply_cached", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "done",
          assistant_reply_text: "durable reply",
          rowboat_reply_cached: "stale cache",
          telnyx_outbound_message_id: "out-1",
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c) as never);
    const outbound = result.find((m) => m.direction === "outbound");
    expect(outbound?.content).toBe("durable reply");
  });

  it("falls back to rowboat_reply_cached for legacy rows lacking assistant_reply_text", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "pending",
          assistant_reply_text: null,
          rowboat_reply_cached: "in-flight reply",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:01Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c) as never);
    const outbound = result.find((m) => m.direction === "outbound");
    expect(outbound?.content).toBe("in-flight reply");
  });

  it("queries with ascending=false so a business with >limit rows still surfaces RECENT messages (bugbot regression)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    // Order assertion: must request newest-first. If this flips back to
    // ascending=true, every business with >200 SMS jobs starts showing
    // empty threads for new customers.
    expect(c.order).toHaveBeenCalledWith(
      "created_at",
      expect.objectContaining({ ascending: false })
    );
  });

  it("filters out messages from other customers", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "mine" }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        },
        {
          id: "j2",
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15552222222" },
            text: "not mine"
          }),
          status: "done",
          rowboat_reply_cached: "ok2",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:01:00Z",
          updated_at: "2026-05-05T00:01:00Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.content !== "not mine")).toBe(true);
  });

  it("emits only inbound when the assistant reply is null", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "pending",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.direction).toBe("inbound");
  });

  it("emits only outbound when the inbound text is missing (delivery-receipt-only rows)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" } }),
          status: "done",
          rowboat_reply_cached: "system msg",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.direction).toBe("outbound");
  });

  it("propagates last_error onto the outbound message", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "dead_letter",
          rowboat_reply_cached: "tried to send",
          telnyx_outbound_message_id: null,
          last_error: "Not 10DLC registered",
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    const outbound = result.find((m) => m.direction === "outbound");
    expect(outbound?.lastError).toBe("Not 10DLC registered");
    expect(outbound?.status).toBe("dead_letter");
  });

  it("falls back to created_at when updated_at is empty (legacy rows)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "done",
          rowboat_reply_cached: "ok",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: ""
        }
      ],
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      {},
      makeDb(c) as never
    );
    expect(result.find((m) => m.direction === "outbound")?.timestamp).toBe(
      "2026-05-05T00:00:00Z"
    );
  });

  it("surfaces query errors", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: { message: "thread boom" } });
    await expect(
      listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c) as never)
    ).rejects.toThrow(/thread boom/);
  });

  it("handles null data", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c) as never)
    ).resolves.toEqual([]);
  });

  it("uses the default service client when none is injected", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    defaultClientSpy.mockResolvedValueOnce(makeDb(c));
    await expect(listMessagesForCustomer("biz", "+15551111111")).resolves.toEqual([]);
  });

  it("interleaves worker-initiated sends chronologically with the conversation, tagged with their source", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "got your text!" }),
          status: "done",
          rowboat_reply_cached: "great, talk soon",
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T02:00:00Z",
          updated_at: "2026-05-05T02:00:01Z"
        }
      ],
      error: null
    });
    const oc = chain();
    oc.limit.mockResolvedValue({
      data: [
        // Newest-first like the real query; the intro PREDATES the inbound.
        outboundLogRow({
          id: "ob-intro",
          body: "Hi, this is Amy's coworker.",
          created_at: "2026-05-05T01:00:00Z"
        })
      ],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c, oc) as never);
    expect(result.map((m) => `${m.direction}:${m.content}`)).toEqual([
      "outbound:Hi, this is Amy's coworker.",
      "inbound:got your text!",
      "outbound:great, talk soon"
    ]);
    expect(result[0]?.source).toBe("ai_flow");
    expect(result[0]?.id).toBe("ob-intro:flow-outbound");
    expect(result[1]?.source).toBeUndefined();
  });

  it("keeps stable order for identical timestamps (comparator equality branch)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
        {
          id: "j1",
          business_id: "biz",
          payload: envelope({ from: { phone_number: "+15551111111" }, text: "hi" }),
          status: "done",
          rowboat_reply_cached: null,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: "2026-05-05T00:00:00Z",
          updated_at: "2026-05-05T00:00:00Z"
        }
      ],
      error: null
    });
    const oc = chain();
    oc.limit.mockResolvedValue({
      data: [outboundLogRow({ id: "ob1", body: "same instant", created_at: "2026-05-05T00:00:00Z" })],
      error: null
    });
    const result = await listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c, oc) as never);
    expect(result.map((m) => m.content)).toEqual(["hi", "same instant"]);
  });

  it("surfaces outbound-log query errors", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    const oc = chain();
    oc.limit.mockResolvedValue({ data: null, error: { message: "log thread boom" } });
    await expect(
      listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c, oc) as never)
    ).rejects.toThrow(/log thread boom/);
  });

  it("handles null outbound-log data", async () => {
    const c = chain();
    c.limit.mockResolvedValue({ data: [], error: null });
    const oc = chain();
    oc.limit.mockResolvedValue({ data: null, error: null });
    await expect(
      listMessagesForCustomer("biz", "+15551111111", {}, makeDb(c, oc) as never)
    ).resolves.toEqual([]);
  });

  it("respects the limit slice (keeps the most-recent expanded messages)", async () => {
    const c = chain();
    // Supabase returns DESC (newest first) given our `ascending: false`
    // query, so we feed mock data in that order. Helper reverses inside.
    c.limit.mockResolvedValue({
      data: Array.from({ length: 6 }, (_, i) => {
        const idx = 5 - i; // newest first → indices 5,4,3,2,1,0
        return {
          id: `j${idx}`,
          business_id: "biz",
          payload: envelope({
            from: { phone_number: "+15551111111" },
            text: `t${idx}`
          }),
          status: "done" as const,
          rowboat_reply_cached: `r${idx}`,
          telnyx_outbound_message_id: null,
          last_error: null,
          created_at: `2026-05-05T00:0${idx}:00Z`,
          updated_at: `2026-05-05T00:0${idx}:01Z`
        };
      }),
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      { limit: 3 },
      makeDb(c) as never
    );
    expect(result).toHaveLength(3);
    // After expansion the 12-message chronological list ends with
    // t0,r0,t1,r1,...,t5,r5. Slice(-3) → r4, t5, r5.
    expect(result.map((m) => m.content)).toEqual(["r4", "t5", "r5"]);
  });
});
