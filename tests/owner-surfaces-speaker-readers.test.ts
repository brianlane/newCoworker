import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/contact-names", () => ({ businessOwnerNumbersResult: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  businessIdentityOrThrow,
  ownerNumbersOrThrow
} from "@/lib/owner-surfaces/speaker";
import { businessOwnerNumbersResult } from "@/lib/db/contact-names";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * The production readers behind resolveSurfaceSpeaker, and the reason they
 * exist at all (Bugbot, PR #1629).
 *
 * The module's fail-closed promise only held when a reader THREW. The
 * shared readers swallow a PostgREST error and return an empty list or a
 * null row, which is indistinguishable from "no owner number on file". The
 * owner would then be classified `customer` with `readFailed: false`: not
 * just wrong, but wrong while claiming confidence, which is what sends the
 * owner down the customer path.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

function dbReturning(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = () => builder;
  builder.maybeSingle = () => Promise.resolve(result);
  return { from: () => builder };
}

describe("ownerNumbersOrThrow", () => {
  it("returns the numbers on a clean read", async () => {
    vi.mocked(businessOwnerNumbersResult).mockResolvedValue({
      numbers: ["+15145188192"],
      readFailed: false
    });
    await expect(ownerNumbersOrThrow(BIZ)).resolves.toEqual(["+15145188192"]);
  });

  it("returns an empty list when the business genuinely has no owner number", async () => {
    // Absent is a real answer. Only a FAILED read is not.
    vi.mocked(businessOwnerNumbersResult).mockResolvedValue({
      numbers: [],
      readFailed: false
    });
    await expect(ownerNumbersOrThrow(BIZ)).resolves.toEqual([]);
  });

  it("THROWS when the read failed, rather than reporting an empty list", async () => {
    vi.mocked(businessOwnerNumbersResult).mockResolvedValue({
      numbers: [],
      readFailed: true
    });
    await expect(ownerNumbersOrThrow(BIZ)).rejects.toThrow(/owner number lookup failed/);
  });
});

describe("businessIdentityOrThrow", () => {
  it("returns the row on a clean read", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({ data: { owner_name: "James", owner_email: "j@x.co" }, error: null }) as never
    );
    await expect(businessIdentityOrThrow(BIZ)).resolves.toEqual({
      owner_name: "James",
      owner_email: "j@x.co"
    });
  });

  it("returns null for a genuinely absent row", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({ data: null, error: null }) as never
    );
    await expect(businessIdentityOrThrow(BIZ)).resolves.toBeNull();
  });

  it("THROWS on a failed read, rather than reporting an absent row", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({ data: null, error: { message: "permission denied" } }) as never
    );
    await expect(businessIdentityOrThrow(BIZ)).rejects.toThrow(/permission denied/);
  });
});
