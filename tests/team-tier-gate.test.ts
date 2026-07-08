import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  assertTeamAccessAllowed,
  teamAccessAllowedForTier,
  TeamAccessValidationError,
  TEAM_ACCESS_TIER_MESSAGE
} from "@/lib/team/tier-gate";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

function tierDb(result: { data?: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, eq };
}

describe("teamAccessAllowedForTier", () => {
  it("allows enterprise only", () => {
    expect(teamAccessAllowedForTier("enterprise")).toBe(true);
    expect(teamAccessAllowedForTier("standard")).toBe(false);
    expect(teamAccessAllowedForTier("starter")).toBe(false);
    expect(teamAccessAllowedForTier(null)).toBe(false);
    expect(teamAccessAllowedForTier(undefined)).toBe(false);
  });
});

describe("assertTeamAccessAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves for an enterprise business (explicit client)", async () => {
    const { db, from, eq } = tierDb({ data: { tier: "enterprise" }, error: null });
    await expect(assertTeamAccessAllowed(BIZ, db)).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith("businesses");
    expect(eq).toHaveBeenCalledWith("id", BIZ);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("throws the tier message for non-enterprise businesses", async () => {
    const { db } = tierDb({ data: { tier: "standard" }, error: null });
    await expect(assertTeamAccessAllowed(BIZ, db)).rejects.toThrow(TeamAccessValidationError);
    await expect(assertTeamAccessAllowed(BIZ, db)).rejects.toThrow(TEAM_ACCESS_TIER_MESSAGE);
  });

  it("throws the tier message when the business row is missing", async () => {
    const { db } = tierDb({ data: null, error: null });
    await expect(assertTeamAccessAllowed(BIZ, db)).rejects.toThrow(TEAM_ACCESS_TIER_MESSAGE);
  });

  it("surfaces query errors as plain errors (500, not an upsell)", async () => {
    const { db } = tierDb({ data: null, error: { message: "db down" } });
    const err = await assertTeamAccessAllowed(BIZ, db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TeamAccessValidationError);
    expect((err as Error).message).toContain("db down");
  });

  it("falls back to the service client when none is provided", async () => {
    const { db } = tierDb({ data: { tier: "enterprise" }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
    await expect(assertTeamAccessAllowed(BIZ)).resolves.toBeUndefined();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
