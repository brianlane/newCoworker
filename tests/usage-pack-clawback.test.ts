import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ rpc: rpcMock, from: fromMock }))
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  clawbackMembershipPackGrantsForInvoice,
  clawbackReasonForNewcoworkerRefund,
  clawbackUsagePackGrantBySourceId,
  computeUsagePackClawbackAmount,
  membershipPackGrantSourceId
} from "@/lib/billing/usage-pack-clawback";

function grantListChain(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "like", "is"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe("usage-pack-clawback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
    fromMock.mockImplementation(() => grantListChain({ data: [], error: null }));
  });

  it("maps New Coworker refund reasons and builds invoice source ids", () => {
    expect(clawbackReasonForNewcoworkerRefund("thirty_day_money_back")).toBe("refund");
    expect(clawbackReasonForNewcoworkerRefund("admin_force")).toBe("admin");
    expect(clawbackReasonForNewcoworkerRefund("other")).toBeNull();
    expect(membershipPackGrantSourceId("in_1", "voice", "min_30")).toBe(
      "inv_in_1:voice:min_30"
    );
  });

  it("claws back invoice grants from subscription metadata when DB list is empty", async () => {
    const result = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_abc",
      reason: "refund",
      subscriptionMetadata: {
        addonVoice: "min_30:1:1800",
        addonSms: "texts_500:1:500"
      }
    });
    expect(result.attempted).toBe(2);
    expect(result.failed).toBe(0);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_abc:voice:min_30" })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "void_sms_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_abc:sms:texts_500" })
    );
  });

  it("claws back open grants discovered in the DB and counts RPC failures", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "voice_bonus_grants") {
        return grantListChain({
          data: [
            { stripe_checkout_session_id: "inv_in_db:voice:min_30" },
            { stripe_checkout_session_id: "   " },
            { stripe_checkout_session_id: 12 }
          ],
          error: null
        });
      }
      if (table === "sms_bonus_grants") {
        return grantListChain({ data: null, error: { message: "sms list fail" } });
      }
      if (table === "chat_spend_credit_grants") {
        return {
          select: () => {
            throw new Error("chat list boom");
          }
        };
      }
      return grantListChain({ data: [], error: null });
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "void fail" } });

    const result = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_db",
      reason: "admin",
      subscriptionMetadata: { addonChat: "usd_5:1:5000000" }
    });
    // Only the open voice grant is targeted (metadata fallback is skipped when DB finds rows).
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_db:voice:min_30" })
    );
  });

  it("lists chat grants from chat_spend_credit_grants and voids all three kinds", async () => {
    // Regression: the chat leg used to query a nonexistent "chat_credit_grants"
    // table; PostgREST's error was swallowed by the warn-and-continue branch,
    // and the metadata fallback only fires when EVERY list is empty, so chat
    // grants silently survived mixed-pack refunds.
    const tablesQueried: string[] = [];
    fromMock.mockImplementation((table: string) => {
      tablesQueried.push(table);
      if (table === "voice_bonus_grants") {
        return grantListChain({
          data: [{ stripe_checkout_session_id: "inv_in_mix:voice:min_30" }],
          error: null
        });
      }
      if (table === "sms_bonus_grants") {
        return grantListChain({
          data: [{ stripe_checkout_session_id: "inv_in_mix:sms:texts_500" }],
          error: null
        });
      }
      if (table === "chat_spend_credit_grants") {
        return grantListChain({
          data: [{ stripe_checkout_session_id: "inv_in_mix:chat:usd_5" }],
          error: null
        });
      }
      return grantListChain({ data: [], error: null });
    });

    const result = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_mix",
      reason: "refund"
    });

    expect(tablesQueried).toContain("chat_spend_credit_grants");
    expect(tablesQueried).not.toContain("chat_credit_grants");
    expect(result.attempted).toBe(3);
    expect(result.failed).toBe(0);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_mix:voice:min_30" })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "void_sms_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_mix:sms:texts_500" })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "void_chat_credit_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_mix:chat:usd_5" })
    );
  });

  it("no-ops on blank invoice ids and still voids chat metadata when listed", async () => {
    expect(await clawbackMembershipPackGrantsForInvoice({ invoiceId: "  ", reason: "refund" })).toEqual(
      { attempted: 0, failed: 0 }
    );

    fromMock.mockImplementation(() => grantListChain({ data: [], error: null }));
    const withChat = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_chat",
      reason: "refund",
      subscriptionMetadata: { addonChat: "usd_5:1:5000000" }
    });
    expect(withChat.attempted).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_chat_credit_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_chat:chat:usd_5" })
    );
  });

  it("falls back to the table kind when the source id has an unknown category", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "voice_bonus_grants") {
        return grantListChain({
          data: [
            { stripe_checkout_session_id: "inv_in_x:other:pack" },
            { stripe_checkout_session_id: "inv_in_x:bad" },
            { stripe_checkout_session_id: "inv_OTHER:voice:min_30" }
          ],
          error: null
        });
      }
      if (table === "sms_bonus_grants") {
        return grantListChain({ data: null, error: null });
      }
      if (table === "chat_spend_credit_grants") {
        return {
          select: () => ({
            like: () => ({
              is: () => {
                throw "list string boom";
              }
            })
          })
        };
      }
      return grantListChain({ data: [], error: null });
    });
    const result = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_x",
      reason: "refund"
    });
    expect(result.attempted).toBe(3);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_checkout_session_id: "inv_in_x:other:pack" })
    );
  });

  it("skips the DB grant list when the client has no from()", async () => {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({ rpc: rpcMock } as never);
    const result = await clawbackMembershipPackGrantsForInvoice({
      invoiceId: "in_nofrom",
      reason: "refund",
      subscriptionMetadata: { addonVoice: "min_30:1:1800" }
    });
    expect(result.attempted).toBe(1);
  });

  it("prorates partial refunds and full-voids on full refund", () => {
    expect(computeUsagePackClawbackAmount(1000, 500, 1800)).toBe(900);
    expect(computeUsagePackClawbackAmount(1000, 1000, 1800)).toBeNull();
    expect(computeUsagePackClawbackAmount(null, 500, 1800)).toBeNull();
    // Zero refunded is an explicit no-op, never the full-void sentinel: a
    // malformed $0 charge.refunded must not erase the whole grant.
    expect(computeUsagePackClawbackAmount(1000, 0, 1800)).toBe(0);
    expect(computeUsagePackClawbackAmount(1000, -50, 1800)).toBe(0);
    expect(computeUsagePackClawbackAmount(1000, 500, null)).toBeNull();
    expect(computeUsagePackClawbackAmount(1000, 500, 0)).toBeNull();
    // tiny refund rounds to 0
    expect(computeUsagePackClawbackAmount(1_000_000, 1, 1)).toBe(0);
    // clawback would meet/exceed purchased → full void sentinel
    expect(computeUsagePackClawbackAmount(100, 99, 1)).toBeNull();
  });

  it("voids a grant by source id for admin refunds", async () => {
    const result = await clawbackUsagePackGrantBySourceId({
      sourceId: "inv_in_1:voice:min_30",
      kind: "voice",
      reason: "admin",
      clawbackAmount: null
    });
    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_1:voice:min_30",
        p_reason: "admin",
        p_clawback_seconds: null
      })
    );
  });

  it("returns error when RPC fails", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "nope" } });
    const result = await clawbackUsagePackGrantBySourceId({
      sourceId: "cs_1",
      kind: "sms",
      reason: "admin"
    });
    expect(result).toEqual({ ok: false, error: "nope" });
  });

  it("rejects empty source id", async () => {
    const result = await clawbackUsagePackGrantBySourceId({
      sourceId: "  ",
      kind: "chat",
      reason: "admin"
    });
    expect(result.ok).toBe(false);
  });

  it("voids sms and chat kinds and passes an explicit clawback amount", async () => {
    await clawbackUsagePackGrantBySourceId({
      sourceId: "cs_sms",
      kind: "sms",
      reason: "refund",
      clawbackAmount: 10
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "void_sms_bonus_grant_by_checkout_session",
      expect.objectContaining({ p_clawback_texts: 10 })
    );

    await clawbackUsagePackGrantBySourceId({
      sourceId: "cs_chat",
      kind: "chat",
      reason: "dispute"
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "void_chat_credit_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "cs_chat",
        p_reason: "dispute",
        p_clawback_micros: null
      })
    );
  });
});
