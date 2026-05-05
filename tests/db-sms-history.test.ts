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

function makeDb(c: Chain) {
  return { from: vi.fn(() => c) };
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
    expect(result[0]?.messageCount).toBe(1);
    expect(result[1]?.messageCount).toBe(2);
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
});

describe("listMessagesForCustomer", () => {
  it("expands each row into inbound + outbound messages, in order", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: [
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
        },
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

  it("respects the limit slice (keeps the most-recent expanded messages)", async () => {
    const c = chain();
    c.limit.mockResolvedValue({
      data: Array.from({ length: 6 }, (_, i) => ({
        id: `j${i}`,
        business_id: "biz",
        payload: envelope({
          from: { phone_number: "+15551111111" },
          text: `t${i}`
        }),
        status: "done" as const,
        rowboat_reply_cached: `r${i}`,
        telnyx_outbound_message_id: null,
        last_error: null,
        created_at: `2026-05-05T00:0${i}:00Z`,
        updated_at: `2026-05-05T00:0${i}:01Z`
      })),
      error: null
    });
    const result = await listMessagesForCustomer(
      "biz",
      "+15551111111",
      { limit: 3 },
      makeDb(c) as never
    );
    expect(result).toHaveLength(3);
    // Last 3 of the expanded sequence (each row → 2 messages).
    // After expansion the 12-message list ends with t5,r5,t4,... no, in
    // chronological order: t0,r0,t1,r1,...,t5,r5. Slice(-3) → r4,t5,r5.
    expect(result.map((m) => m.content)).toEqual(["r4", "t5", "r5"]);
  });
});
