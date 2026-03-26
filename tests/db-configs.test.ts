import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_CONFIG = {
  business_id: "biz-uuid-1",
  soul_md: "# soul",
  identity_md: "# identity",
  memory_md: "# memory",
  elevenlabs_agent_id: "el-agent-1",
  updated_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
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

  it("getBusinessConfig returns config", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getBusinessConfig("biz-uuid-1");
    expect(result?.elevenlabs_agent_id).toBe("el-agent-1");
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
});
