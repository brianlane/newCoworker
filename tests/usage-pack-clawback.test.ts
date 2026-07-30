import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ rpc: rpcMock }))
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  clawbackUsagePackGrantBySourceId,
  computeUsagePackClawbackAmount
} from "@/lib/billing/usage-pack-clawback";

describe("usage-pack-clawback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it("prorates partial refunds and full-voids on full refund", () => {
    expect(computeUsagePackClawbackAmount(1000, 500, 1800)).toBe(900);
    expect(computeUsagePackClawbackAmount(1000, 1000, 1800)).toBeNull();
    expect(computeUsagePackClawbackAmount(null, 500, 1800)).toBeNull();
    expect(computeUsagePackClawbackAmount(1000, 0, 1800)).toBeNull();
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
