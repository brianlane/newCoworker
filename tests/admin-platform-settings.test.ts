import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAdminPlatformSetting", () => {
  it("returns the stored jsonb value / null when missing / throws on error", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({ data: { value: { enabled: true } }, error: null })
    );
    expect(await getAdminPlatformSetting("k")).toEqual({ enabled: true });

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await getAdminPlatformSetting("k")).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(getAdminPlatformSetting("k")).rejects.toThrow("getAdminPlatformSetting: x");
  });

  it("accepts an injected client", async () => {
    const client = {
      from: vi.fn(() => makeBuilder({ data: { value: 7 }, error: null }))
    };
    expect(await getAdminPlatformSetting("k", client as never)).toBe(7);
    expect(client.from).toHaveBeenCalledWith("admin_platform_settings");
  });
});

describe("upsertAdminPlatformSetting", () => {
  it("upserts on the key with a fresh updated_at", async () => {
    const builder = makeBuilder({ data: null, error: null });
    supabaseStub.from.mockReturnValueOnce(builder);
    await upsertAdminPlatformSetting("k", { enabled: false });
    const [row, opts] = (builder.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(row.key).toBe("k");
    expect(row.value).toEqual({ enabled: false });
    expect(typeof row.updated_at).toBe("string");
    expect(opts).toEqual({ onConflict: "key" });
  });

  it("throws on a write error; accepts an injected client", async () => {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(upsertAdminPlatformSetting("k", 1)).rejects.toThrow(
      "upsertAdminPlatformSetting: x"
    );

    const client = { from: vi.fn(() => makeBuilder({ data: null, error: null })) };
    await upsertAdminPlatformSetting("k", 1, client as never);
    expect(client.from).toHaveBeenCalledWith("admin_platform_settings");
  });
});
