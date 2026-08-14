/**
 * Shared core behind update_business_profile (hours + timezone).
 *
 * The load-bearing behaviors: the per-day merge must ride OVER the stored
 * schedule (a patch naming only Tuesday must not drop Monday), validation
 * refuses before any write, and the post-write pipeline (profile_md refresh
 * + vault sync) fires so the live agent sees the change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data: unknown; error: { message: string } | null };

function makeBuilder(result: StubResult) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    update: vi.fn(() => b),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
  };
  return b;
}

const supabaseStub = { from: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

vi.mock("@/lib/db/businesses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/businesses")>();
  return {
    ...actual,
    updateBusinessProfileFields: vi.fn(),
    updateBusinessTimezone: vi.fn()
  };
});
// Mocked at module level so the PRODUCTION default deps (no injection) are a
// real, covered path rather than a coverage-ignored one.
vi.mock("@/lib/business-profile/refresh", () => ({
  refreshBusinessProfileMdAndLog: vi.fn(async () => null)
}));
vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn(async () => ({ ok: true }))
}));

import { applyBusinessProfileUpdate } from "@/lib/business-profile/update-core";
import {
  updateBusinessProfileFields,
  updateBusinessTimezone
} from "@/lib/db/businesses";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const BIZ = "11111111-1111-4111-8111-111111111111";

const refreshProfileMd = vi.fn(async () => null);
const syncVault = vi.fn(async () => ({ ok: true }) as never);
const deps = { refreshProfileMd, syncVault };

function bizRow(row: Record<string, unknown> | null) {
  supabaseStub.from.mockReturnValue(makeBuilder({ data: row, error: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  bizRow({ id: BIZ, business_hours: null, timezone: "America/Phoenix" });
});

describe("applyBusinessProfileUpdate", () => {
  it("refuses an empty patch without touching the DB", async () => {
    const result = await applyBusinessProfileUpdate(BIZ, {}, deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("Nothing to update") });
    expect(supabaseStub.from).not.toHaveBeenCalled();
  });

  it("refuses malformed times before any write, naming the day", async () => {
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { hours: { tue: { open: "9am", close: "17:00" } } },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("tue");
    expect(vi.mocked(updateBusinessProfileFields)).not.toHaveBeenCalled();
  });

  it("refuses an unknown timezone before any write", async () => {
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { timezone: "Mars/Olympus_Mons" },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Mars/Olympus_Mons");
    expect(vi.mocked(updateBusinessTimezone)).not.toHaveBeenCalled();
  });

  it("merges submitted days OVER the stored schedule (omitted day = unchanged)", async () => {
    bizRow({
      id: BIZ,
      business_hours: { mon: { open: "09:00", close: "17:00" }, wed: null },
      timezone: "America/Phoenix"
    });
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { hours: { tue: { open: "11:00", close: "18:00" }, sat: null } },
      deps
    );
    expect(result).toEqual({
      ok: true,
      business_hours: {
        mon: { open: "09:00", close: "17:00" },
        tue: { open: "11:00", close: "18:00" },
        wed: null,
        sat: null
      },
      timezone: "America/Phoenix"
    });
    expect(vi.mocked(updateBusinessProfileFields)).toHaveBeenCalledWith(
      BIZ,
      {
        business_hours: {
          mon: { open: "09:00", close: "17:00" },
          tue: { open: "11:00", close: "18:00" },
          wed: null,
          sat: null
        }
      },
      supabaseStub
    );
    // Timezone untouched: no timezone write.
    expect(vi.mocked(updateBusinessTimezone)).not.toHaveBeenCalled();
    // The live agent must see the change: refresh + fire-and-forget sync.
    expect(refreshProfileMd).toHaveBeenCalledWith(BIZ, supabaseStub);
    expect(syncVault).toHaveBeenCalledWith(BIZ);
  });

  it("writes the timezone alone, leaving hours untouched", async () => {
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { timezone: "America/Toronto" },
      deps
    );
    expect(result).toEqual({ ok: true, business_hours: null, timezone: "America/Toronto" });
    expect(vi.mocked(updateBusinessTimezone)).toHaveBeenCalledWith(
      BIZ,
      "America/Toronto",
      supabaseStub
    );
    expect(vi.mocked(updateBusinessProfileFields)).toHaveBeenCalledWith(BIZ, {}, supabaseStub);
  });

  it("reports the stored timezone as null when the row has none", async () => {
    bizRow({ id: BIZ, business_hours: null, timezone: null });
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { hours: { fri: { open: "08:00", close: "12:00" } } },
      deps
    );
    expect(result).toEqual({
      ok: true,
      business_hours: { fri: { open: "08:00", close: "12:00" } },
      timezone: null
    });
  });

  it("returns not-found for a missing business", async () => {
    bizRow(null);
    const result = await applyBusinessProfileUpdate(BIZ, { timezone: "America/Phoenix" }, deps);
    expect(result).toEqual({ ok: false, message: "Business not found." });
  });

  it("throws on a business read error (unexpected failures are not ok:false)", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: { message: "boom" } }));
    await expect(
      applyBusinessProfileUpdate(BIZ, { timezone: "America/Phoenix" }, deps)
    ).rejects.toThrow(/applyBusinessProfileUpdate: boom/);
  });

  it("uses the production refresh + vault-sync defaults when no deps are injected", async () => {
    const result = await applyBusinessProfileUpdate(BIZ, { timezone: "America/Phoenix" });
    expect(result.ok).toBe(true);
    expect(vi.mocked(refreshBusinessProfileMdAndLog)).toHaveBeenCalledWith(BIZ, supabaseStub);
    expect(vi.mocked(syncVaultToVpsAndLog)).toHaveBeenCalledWith(BIZ);
    // The injected-deps tests must not have leaked into the defaults.
    expect(refreshProfileMd).not.toHaveBeenCalled();
  });

  it("accepts an explicit injected client", async () => {
    const client = { from: vi.fn() };
    client.from.mockReturnValue(
      makeBuilder({ data: { id: BIZ, business_hours: null, timezone: null }, error: null })
    );
    const result = await applyBusinessProfileUpdate(
      BIZ,
      { timezone: "America/Phoenix" },
      { ...deps, client: client as never }
    );
    expect(result.ok).toBe(true);
    expect(supabaseStub.from).not.toHaveBeenCalled();
  });
});
