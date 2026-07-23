import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CI live-e2e mode toggle (src/lib/admin/ci-e2e-mode.ts): vocabulary,
 * default-on-parse, and the platform-settings round trip. The CI side
 * (e2e-scope.sh consulting /api/public/ci-e2e-mode and failing open) is
 * exercised by the script's own stubbed-gh matrix in the PR that shipped
 * it; this file pins the app side the endpoint reads.
 */

type StubResult = { data: unknown; error: { message: string } | null };

function makeBuilder(result: StubResult) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    upsert: vi.fn(() => b),
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

import {
  CI_E2E_MODES,
  CI_E2E_MODE_KEY,
  getCiE2eMode,
  parseCiE2eMode,
  setCiE2eMode
} from "@/lib/admin/ci-e2e-mode";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseCiE2eMode", () => {
  it("recognizes nightly-only and defaults EVERYTHING else to per-change", () => {
    expect(parseCiE2eMode("nightly-only")).toBe("nightly-only");
    expect(parseCiE2eMode("per-change")).toBe("per-change");
    // Missing row, legacy junk, wrong types — all read as the default so a
    // corrupted setting can never silently turn the merge-time suite off.
    expect(parseCiE2eMode(null)).toBe("per-change");
    expect(parseCiE2eMode(undefined)).toBe("per-change");
    expect(parseCiE2eMode("NIGHTLY-ONLY")).toBe("per-change");
    expect(parseCiE2eMode({ mode: "nightly-only" })).toBe("per-change");
    expect(parseCiE2eMode(1)).toBe("per-change");
  });

  it("the vocabulary is exactly the two modes", () => {
    expect(CI_E2E_MODES).toEqual(["per-change", "nightly-only"]);
  });
});

describe("getCiE2eMode", () => {
  it("reads the settings row and parses it (default when missing)", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { value: "nightly-only" }, error: null })
    );
    expect(await getCiE2eMode()).toBe("nightly-only");
    expect(supabaseStub.from).toHaveBeenCalledWith("admin_platform_settings");

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getCiE2eMode()).toBe("per-change");
  });

  it("accepts an injected client and propagates read errors", async () => {
    const client = {
      from: vi.fn(() => makeBuilder({ data: { value: "nightly-only" }, error: null }))
    };
    expect(await getCiE2eMode(client as never)).toBe("nightly-only");
    expect(client.from).toHaveBeenCalledWith("admin_platform_settings");

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getCiE2eMode()).rejects.toThrow("getAdminPlatformSetting: x");
  });
});

describe("setCiE2eMode", () => {
  it("upserts the mode under the settings key", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await setCiE2eMode("nightly-only");
    const [row, opts] = (builder.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(row.key).toBe(CI_E2E_MODE_KEY);
    expect(row.value).toBe("nightly-only");
    expect(opts).toEqual({ onConflict: "key" });
  });

  it("accepts an injected client and propagates write errors", async () => {
    const client = { from: vi.fn(() => makeBuilder({ data: null, error: null })) };
    await setCiE2eMode("per-change", client as never);
    expect(client.from).toHaveBeenCalledWith("admin_platform_settings");

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(setCiE2eMode("per-change")).rejects.toThrow("upsertAdminPlatformSetting: x");
  });
});
