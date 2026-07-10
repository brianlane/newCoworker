import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data: unknown; error: { message: string } | null };

function makeBuilder(result: StubResult) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    maybeSingle: vi.fn(async () => result)
  };
  return b;
}

const supabaseStub = { from: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

import {
  WEBCHAT_TIER_MESSAGE,
  WebchatTierValidationError,
  assertWebchatAllowed,
  webchatAllowedForTier
} from "@/lib/webchat/tier-gate";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webchatAllowedForTier", () => {
  it("allows standard and enterprise only", () => {
    expect(webchatAllowedForTier("standard")).toBe(true);
    expect(webchatAllowedForTier("enterprise")).toBe(true);
    expect(webchatAllowedForTier("starter")).toBe(false);
    expect(webchatAllowedForTier(null)).toBe(false);
    expect(webchatAllowedForTier(undefined)).toBe(false);
    expect(webchatAllowedForTier("")).toBe(false);
  });
});

describe("assertWebchatAllowed", () => {
  it("passes for a standard business", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: { tier: "standard" }, error: null }));
    await expect(assertWebchatAllowed(BIZ)).resolves.toBeUndefined();
  });

  it("throws the typed error for starter (and for a missing row)", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: { tier: "starter" }, error: null }));
    await expect(assertWebchatAllowed(BIZ)).rejects.toThrow(WebchatTierValidationError);

    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: null }));
    await expect(assertWebchatAllowed(BIZ)).rejects.toThrow(WEBCHAT_TIER_MESSAGE);
  });

  it("surfaces read errors as plain errors (fail closed, not typed)", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: { message: "boom" } }));
    await expect(assertWebchatAllowed(BIZ)).rejects.toThrow("assertWebchatAllowed: boom");
  });

  it("accepts an injected client", async () => {
    const client = { from: vi.fn(() => makeBuilder({ data: { tier: "enterprise" }, error: null })) };
    await expect(
      assertWebchatAllowed(BIZ, client as never)
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledWith("businesses");
  });
});
