import { describe, it, expect, vi, beforeEach } from "vitest";

const { checkLimitReached, incrementUsage, createSupabaseServiceClient } = vi.hoisted(() => {
  return {
    checkLimitReached: vi.fn(),
    incrementUsage: vi.fn(),
    createSupabaseServiceClient: vi.fn()
  };
});

vi.mock("@/lib/db/usage", () => ({
  checkLimitReached,
  incrementUsage
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import { sendTelnyxSms } from "@/lib/telnyx/messaging";

describe("sendTelnyxSms meterBusinessId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkLimitReached.mockResolvedValue({ allowed: true });
    incrementUsage.mockResolvedValue(undefined);
    createSupabaseServiceClient.mockResolvedValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { tier: "starter", enterprise_limits: null },
        error: null
      })
    } as never);
  });

  it("checks limit and increments after successful send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m1" } })
    });
    const id = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "Hi",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    expect(id).toBe("m1");
    expect(checkLimitReached).toHaveBeenCalled();
    expect(incrementUsage).toHaveBeenCalledWith("biz-1", "sms_sent", 1, expect.anything());
  });

  it("throws when monthly cap blocks send", async () => {
    checkLimitReached.mockResolvedValue({ allowed: false, reason: "Monthly SMS limit reached (750 SMS/month)" });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("Monthly SMS limit reached");
    expect(incrementUsage).not.toHaveBeenCalled();
  });
});
