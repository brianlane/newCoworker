import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  MESSENGER_TIER_MESSAGE,
  MessengerTierValidationError,
  assertMessengerAllowed,
  messengerAllowedForTier
} from "@/lib/messenger/tier-gate";
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

describe("messenger tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(messengerAllowedForTier("standard")).toBe(true);
    expect(messengerAllowedForTier("enterprise")).toBe(true);
    expect(messengerAllowedForTier("starter")).toBe(false);
    expect(messengerAllowedForTier(null)).toBe(false);
    expect(messengerAllowedForTier(undefined)).toBe(false);
  });

  it("exposes an upgrade message naming Standard", () => {
    expect(MESSENGER_TIER_MESSAGE).toContain("Standard");
  });

  it("assertMessengerAllowed passes for Standard+", async () => {
    const db = makeDb({ data: { tier: "standard" }, error: null });
    await expect(assertMessengerAllowed("biz-1", db)).resolves.toBeUndefined();
  });

  it("assertMessengerAllowed throws for Starter", async () => {
    const db = makeDb({ data: { tier: "starter" }, error: null });
    await expect(assertMessengerAllowed("biz-1", db)).rejects.toBeInstanceOf(
      MessengerTierValidationError
    );
    await expect(assertMessengerAllowed("biz-1", db)).rejects.toThrow(MESSENGER_TIER_MESSAGE);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    await assertMessengerAllowed("biz-1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on lookup errors", async () => {
    const db = makeDb({ data: null, error: { message: "db down" } });
    await expect(assertMessengerAllowed("biz-1", db)).rejects.toThrow(
      "assertMessengerAllowed: db down"
    );
  });
});
