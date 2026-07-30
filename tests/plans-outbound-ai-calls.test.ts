import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  OUTBOUND_AI_CALLS_UPGRADE_MESSAGE,
  outboundAiCallsAllowedForBusiness,
  outboundAiCallsAllowedForTier
} from "@/lib/plans/outbound-ai-calls";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function makeDb(result: { data: unknown; error: { message: string } | null }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("outbound AI calls tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(outboundAiCallsAllowedForTier("standard")).toBe(true);
    expect(outboundAiCallsAllowedForTier("enterprise")).toBe(true);
    expect(outboundAiCallsAllowedForTier("starter")).toBe(false);
    expect(outboundAiCallsAllowedForTier(null)).toBe(false);
    expect(outboundAiCallsAllowedForTier(undefined)).toBe(false);
  });

  it("exposes an upgrade message naming the Standard plan", () => {
    expect(OUTBOUND_AI_CALLS_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business via the provided client", async () => {
    const db = makeDb({ data: { tier: "standard" }, error: null });
    expect(await outboundAiCallsAllowedForBusiness("biz-1", db)).toBe(true);

    const starter = makeDb({ data: { tier: "starter" }, error: null });
    expect(await outboundAiCallsAllowedForBusiness("biz-1", starter)).toBe(false);

    const missing = makeDb({ data: null, error: null });
    expect(await outboundAiCallsAllowedForBusiness("biz-1", missing)).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await outboundAiCallsAllowedForBusiness("biz-1")).toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on lookup errors", async () => {
    const db = makeDb({ data: null, error: { message: "db down" } });
    await expect(outboundAiCallsAllowedForBusiness("biz-1", db)).rejects.toThrow(
      "outboundAiCallsAllowedForBusiness: db down"
    );
  });
});
