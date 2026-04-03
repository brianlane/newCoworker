import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getIntegrations,
  getIntegration,
  upsertIntegration,
  deleteIntegration
} from "@/lib/db/integrations";
import { encryptIntegrationSecret } from "@/lib/integrations/secrets";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_ROW = {
  id: "int-1",
  business_id: "biz-1",
  provider: "google",
  auth_type: "oauth",
  status: "connected",
  access_token: "at",
  refresh_token: "rt",
  token_expires_at: "2026-01-01T00:00:00Z",
  api_key_encrypted: null,
  scopes: ["a", "b"],
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_ROW, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

describe("db/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "integration-secret-for-tests";
  });

  it("getIntegrations returns rows", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: [MOCK_ROW], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const rows = await getIntegrations("biz-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("google");
  });

  it("getIntegrations throws on error", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getIntegrations("biz-1")).rejects.toThrow("getIntegrations");
  });

  it("getIntegrations returns empty array when data is null without error", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: null, error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getIntegrations("biz-1")).resolves.toEqual([]);
  });

  it("getIntegration returns row", async () => {
    const encryptedRow = {
      ...MOCK_ROW,
      access_token: encryptIntegrationSecret("at"),
      refresh_token: encryptIntegrationSecret("rt")
    };
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: encryptedRow, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getIntegration("biz-1", "google");
    expect(row?.status).toBe("connected");
    expect(row?.access_token).toBe("at");
    expect(row?.refresh_token).toBe("rt");
  });

  it("getIntegration returns null when missing", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getIntegration("biz-1", "slack")).resolves.toBeNull();
  });

  it("getIntegration throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "bad" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getIntegration("biz-1", "google")).rejects.toThrow("getIntegration");
  });

  it("upsertIntegration upserts and returns row", async () => {
    const encryptedRow = {
      ...MOCK_ROW,
      access_token: encryptIntegrationSecret("x"),
      refresh_token: encryptIntegrationSecret("y")
    };
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: encryptedRow, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await upsertIntegration({
      businessId: "biz-1",
      provider: "google",
      authType: "oauth",
      status: "connected",
      accessToken: "x",
      refreshToken: "y"
    });
    expect(row.provider).toBe("google");
    expect(row.access_token).toBe("x");
    expect(row.refresh_token).toBe("y");
    expect(db.upsert).toHaveBeenCalled();
    const payload = db.upsert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.access_token).toMatch(/^enc:v1:/);
    expect(payload.refresh_token).toMatch(/^enc:v1:/);
  });

  it("upsertIntegration throws on error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      upsertIntegration({
        businessId: "biz-1",
        provider: "google",
        authType: "oauth",
        status: "connected"
      })
    ).rejects.toThrow("upsertIntegration");
  });

  it("deleteIntegration deletes", async () => {
    const finalDb = {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null })
          })
        })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await deleteIntegration("biz-1", "google");
    expect(finalDb.from).toHaveBeenCalledWith("integrations");
  });

  it("deleteIntegration throws on error", async () => {
    const finalDb = {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: { message: "nope" } })
          })
        })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(deleteIntegration("biz-1", "google")).rejects.toThrow("deleteIntegration");
  });

  it("getIntegrations uses injected client", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: [], error: null }) };
    await getIntegrations("biz-1", db as never);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
