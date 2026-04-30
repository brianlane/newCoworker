import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { markEmailVerifiedByEmail } from "@/lib/db/customer-profiles";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Builds a fake supabase service-client whose `.from("customer_profiles")`
 * exposes both the SELECT chain (`.select().eq().maybeSingle()`) and
 * the UPDATE chain (`.update().eq().is()`) used by
 * `markEmailVerifiedByEmail`. The two terminal results are configurable
 * independently so we can test:
 *   - read returns row → write succeeds (happy first-confirm)
 *   - read returns row with email_verified_at → no write attempted (idempotent replay)
 *   - read returns null → not_found short-circuit
 *   - read errors → throws
 *   - read returns null email_verified_at, write errors → throws
 */
function makeFakeClient(opts: {
  selectData?: { id: string; email_verified_at: string | null } | null;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const updateChain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValue({ error: opts.updateError ?? null })
  };
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: opts.selectData ?? null,
      error: opts.selectError ?? null
    }),
    update: updateChain.update,
    is: updateChain.is
  };
  return {
    client: { from: vi.fn(() => selectChain) },
    selectChain,
    updateChain
  };
}

describe("markEmailVerifiedByEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps email_verified_at when the profile exists and was previously unverified", async () => {
    const { client, selectChain, updateChain } = makeFakeClient({
      selectData: { id: "prof-1", email_verified_at: null }
    });

    const result = await markEmailVerifiedByEmail("Owner@Example.COM", client as never);

    expect(result).toEqual({ ok: true, alreadyVerified: false });
    expect(client.from).toHaveBeenCalledWith("customer_profiles");
    // The select chain must filter on the *normalized* email, not the
    // raw input (the function calls `normalizeEmailForProfile` internally).
    expect(selectChain.eq).toHaveBeenCalledWith("normalized_email", "owner@example.com");
    expect(selectChain.maybeSingle).toHaveBeenCalled();
    // The conditional update guard `.is("email_verified_at", null)` is
    // load-bearing for the docstring's claim of concurrent-click
    // safety; assert it's actually being passed to the chain.
    expect(updateChain.is).toHaveBeenCalledWith("email_verified_at", null);
  });

  it("returns alreadyVerified without writing when the profile is already verified", async () => {
    const { client, updateChain } = makeFakeClient({
      selectData: { id: "prof-2", email_verified_at: "2026-04-29T20:00:00Z" }
    });

    const result = await markEmailVerifiedByEmail("owner@example.com", client as never);

    expect(result).toEqual({ ok: true, alreadyVerified: true });
    // Idempotent: no UPDATE issued because the column was already non-null.
    expect(updateChain.update).not.toHaveBeenCalled();
    expect(updateChain.is).not.toHaveBeenCalled();
  });

  it("returns not_found when the profile does not exist", async () => {
    const { client } = makeFakeClient({ selectData: null });

    const result = await markEmailVerifiedByEmail("ghost@example.com", client as never);

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("throws when the SELECT errors", async () => {
    const { client } = makeFakeClient({ selectError: { message: "select boom" } });

    await expect(
      markEmailVerifiedByEmail("owner@example.com", client as never)
    ).rejects.toThrow("markEmailVerifiedByEmail: select boom");
  });

  it("throws when the UPDATE errors", async () => {
    const { client } = makeFakeClient({
      selectData: { id: "prof-3", email_verified_at: null },
      updateError: { message: "update boom" }
    });

    await expect(
      markEmailVerifiedByEmail("owner@example.com", client as never)
    ).rejects.toThrow("markEmailVerifiedByEmail: update boom");
  });

  it("falls back to the default service client when no client is provided", async () => {
    const { client } = makeFakeClient({
      selectData: { id: "prof-4", email_verified_at: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce(client as never);

    const result = await markEmailVerifiedByEmail("default@example.com");

    expect(result).toEqual({ ok: true, alreadyVerified: false });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
