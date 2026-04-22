import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  upsertBusinessConfig,
  getBusinessConfig,
  setBusinessWebsiteMd,
  patchBusinessConfig
} from "@/lib/db/configs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_CONFIG = {
  business_id: "biz-uuid-1",
  soul_md: "# soul",
  identity_md: "# identity",
  memory_md: "# memory",
  rowboat_project_id: "proj-uuid-1",
  updated_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_CONFIG, error: null }),
    ...overrides
  };
}

describe("db/configs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upsertBusinessConfig inserts/updates config", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await upsertBusinessConfig({
      business_id: "biz-uuid-1",
      soul_md: "# soul",
      identity_md: "# identity",
      memory_md: "# memory"
    });
    expect(result.business_id).toBe("biz-uuid-1");
  });

  it("upsertBusinessConfig throws on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(upsertBusinessConfig({
      business_id: "x",
      soul_md: "",
      identity_md: "",
      memory_md: ""
    })).rejects.toThrow("upsertBusinessConfig");
  });

  it("getBusinessConfig returns config with rowboat_project_id", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getBusinessConfig("biz-uuid-1");
    expect(result?.rowboat_project_id).toBe("proj-uuid-1");
  });

  it("getBusinessConfig returns null on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "nf" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getBusinessConfig("bad");
    expect(result).toBeNull();
  });

  it("getBusinessConfig uses provided client", async () => {
    const db = mockDb();
    const result = await getBusinessConfig("biz-uuid-1", db as never);
    expect(result?.soul_md).toBe("# soul");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  // --- setBusinessWebsiteMd ---

  function raceSafeDb() {
    // Separate mock for each call chain so we can distinguish the
    // `upsert(..., { ignoreDuplicates })` from the targeted `update`.
    const upsertChain = { upsert: vi.fn().mockResolvedValue({ error: null }) };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null })
    };
    return {
      upsertChain,
      updateChain,
      db: {
        from: vi.fn().mockImplementation(() => ({
          upsert: upsertChain.upsert,
          update: updateChain.update,
          eq: updateChain.eq
        }))
      }
    };
  }

  it("setBusinessWebsiteMd inserts-if-absent (ignoreDuplicates) and then patches website_md only", async () => {
    const { db, upsertChain, updateChain } = raceSafeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await setBusinessWebsiteMd("biz-uuid-1", "# site");

    expect(upsertChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-uuid-1",
        soul_md: "",
        identity_md: "",
        memory_md: "",
        website_md: ""
      }),
      { onConflict: "business_id", ignoreDuplicates: true }
    );
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ website_md: "# site" })
    );
    // Crucially the update payload does NOT mention soul/identity/memory,
    // which is the whole point of the race-safe pattern.
    const updateCall = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.soul_md).toBeUndefined();
    expect(updateCall.identity_md).toBeUndefined();
    expect(updateCall.memory_md).toBeUndefined();
    expect(updateChain.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
  });

  it("setBusinessWebsiteMd throws when the skeleton upsert fails", async () => {
    const upsertChain = { upsert: vi.fn().mockResolvedValue({ error: { message: "denied" } }) };
    const db = {
      from: vi.fn().mockReturnValue({
        upsert: upsertChain.upsert,
        update: vi.fn(),
        eq: vi.fn()
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    // `setBusinessWebsiteMd` now delegates to `patchBusinessConfig`, so the
    // error prefix reflects the inner function. We still assert it surfaces
    // an "(ensure)" classifier so operators can tell the skeleton upsert is
    // the failing step (vs the targeted update).
    await expect(setBusinessWebsiteMd("biz", "md")).rejects.toThrow("patchBusinessConfig(ensure)");
  });

  it("setBusinessWebsiteMd throws when the patch update fails", async () => {
    const upsertChain = { upsert: vi.fn().mockResolvedValue({ error: null }) };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { message: "rls" } })
    };
    const db = {
      from: vi.fn().mockReturnValue({
        upsert: upsertChain.upsert,
        update: updateChain.update,
        eq: updateChain.eq
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(setBusinessWebsiteMd("biz", "md")).rejects.toThrow("patchBusinessConfig(patch)");
  });

  it("setBusinessWebsiteMd reuses the provided client", async () => {
    const { db, upsertChain } = raceSafeDb();
    await setBusinessWebsiteMd("biz", "md", db as never);
    expect(upsertChain.upsert).toHaveBeenCalled();
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  // --- patchBusinessConfig ---

  it("patchBusinessConfig only updates the keys the caller provided", async () => {
    const { db, upsertChain, updateChain } = raceSafeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await patchBusinessConfig("biz-uuid-1", { soul_md: "# s", identity_md: "# i" });

    expect(upsertChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: "biz-uuid-1", website_md: "" }),
      { onConflict: "business_id", ignoreDuplicates: true }
    );
    const updateCall = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.soul_md).toBe("# s");
    expect(updateCall.identity_md).toBe("# i");
    expect(updateCall.memory_md).toBeUndefined();
    expect(updateCall.website_md).toBeUndefined();
  });

  it("patchBusinessConfig with an empty patch still runs the skeleton upsert and a no-op update", async () => {
    // Exercises the false branch of every `patch.* !== undefined` check so the
    // partial-update payload is literally just `{ updated_at }`. This path
    // supports callers that only want to ensure a row exists without mutating
    // any other field.
    const { db, upsertChain, updateChain } = raceSafeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await patchBusinessConfig("biz-uuid-1", {});

    expect(upsertChain.upsert).toHaveBeenCalled();
    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["updated_at"]);
  });

  it("patchBusinessConfig forwards memory_md and website_md when present", async () => {
    const { db, updateChain } = raceSafeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await patchBusinessConfig("biz-uuid-1", {
      soul_md: "# s",
      identity_md: "# i",
      memory_md: "# m",
      website_md: "# w"
    });

    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.memory_md).toBe("# m");
    expect(payload.website_md).toBe("# w");
  });

  it("patchBusinessConfig throws when the skeleton upsert fails", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: { message: "x" } }),
        update: vi.fn(),
        eq: vi.fn()
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(patchBusinessConfig("biz", {})).rejects.toThrow("patchBusinessConfig(ensure)");
  });

  it("patchBusinessConfig throws when the update fails", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: { message: "y" } })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(patchBusinessConfig("biz", { soul_md: "a" })).rejects.toThrow("patchBusinessConfig(patch)");
  });

  it("patchBusinessConfig reuses the provided client", async () => {
    const { db, upsertChain } = raceSafeDb();
    await patchBusinessConfig("biz", { soul_md: "" }, db as never);
    expect(upsertChain.upsert).toHaveBeenCalled();
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
