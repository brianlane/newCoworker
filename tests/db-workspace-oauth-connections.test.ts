import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deleteWorkspaceOAuthConnection,
  getWorkspaceOAuthConnection,
  getWorkspaceOAuthConnectionByNangoIds,
  listWorkspaceOAuthConnections,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK = {
  id: "woc-1",
  business_id: "biz-1",
  provider_config_key: "gmail",
  connection_id: "conn-1",
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

describe("db/workspace-oauth-connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listWorkspaceOAuthConnections returns rows", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: [MOCK], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const rows = await listWorkspaceOAuthConnections("biz-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].connection_id).toBe("conn-1");
  });

  it("listWorkspaceOAuthConnections throws on error", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listWorkspaceOAuthConnections("biz-1")).rejects.toThrow(
      "listWorkspaceOAuthConnections"
    );
  });

  it("listWorkspaceOAuthConnections returns empty when data is null", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listWorkspaceOAuthConnections("biz-1")).resolves.toEqual([]);
  });

  it("getWorkspaceOAuthConnection returns row", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getWorkspaceOAuthConnection("biz-1", "woc-1");
    expect(row?.id).toBe("woc-1");
  });

  it("getWorkspaceOAuthConnection returns null when missing", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getWorkspaceOAuthConnection("biz-1", "woc-9")).resolves.toBeNull();
  });

  it("getWorkspaceOAuthConnection throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "bad" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getWorkspaceOAuthConnection("biz-1", "woc-1")).rejects.toThrow(
      "getWorkspaceOAuthConnection"
    );
  });

  it("getWorkspaceOAuthConnectionByNangoIds returns row", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "conn-1");
    expect(row?.connection_id).toBe("conn-1");
  });

  it("getWorkspaceOAuthConnectionByNangoIds returns null when missing", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "nope")
    ).resolves.toBeNull();
  });

  it("getWorkspaceOAuthConnectionByNangoIds throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "conn-1")
    ).rejects.toThrow("getWorkspaceOAuthConnectionByNangoIds");
  });

  it("upsertWorkspaceOAuthConnection upserts", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await upsertWorkspaceOAuthConnection({
      businessId: "biz-1",
      providerConfigKey: "gmail",
      connectionId: "conn-1"
    });
    expect(row.id).toBe("woc-1");
    expect(db.upsert).toHaveBeenCalled();
  });

  it("upsertWorkspaceOAuthConnection throws on error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      upsertWorkspaceOAuthConnection({
        businessId: "biz-1",
        providerConfigKey: "gmail",
        connectionId: "conn-1"
      })
    ).rejects.toThrow("upsertWorkspaceOAuthConnection");
  });

  it("deleteWorkspaceOAuthConnection deletes and returns row", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: MOCK, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    const row = await deleteWorkspaceOAuthConnection("biz-1", "woc-1");
    expect(row?.id).toBe("woc-1");
  });

  it("deleteWorkspaceOAuthConnection returns null when no row deleted", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(deleteWorkspaceOAuthConnection("biz-1", "woc-1")).resolves.toBeNull();
  });

  it("deleteWorkspaceOAuthConnection throws on error", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(deleteWorkspaceOAuthConnection("biz-1", "woc-1")).rejects.toThrow(
      "deleteWorkspaceOAuthConnection"
    );
  });

  it("listWorkspaceOAuthConnections uses injected client", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: [], error: null }) };
    await listWorkspaceOAuthConnections("biz-1", db as never);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
