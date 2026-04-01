import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBusiness,
  getBusiness,
  listBusinesses,
  updateBusinessOwnerEmail,
  updateBusinessStatus
} from "@/lib/db/businesses";

// Mock the Supabase service client
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

function mockDb(overrides: Record<string, unknown> = {}) {
  const base = {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
  return base;
}

const MOCK_BUSINESS = {
  id: "uuid-biz-1",
  name: "Sunrise Realty",
  owner_email: "owner@test.com",
  tier: "starter",
  status: "offline",
  hostinger_vps_id: null,
  created_at: "2026-01-01T00:00:00Z"
};

describe("db/businesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createBusiness inserts and returns the row", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await createBusiness({
      id: "uuid-biz-1",
      name: "Sunrise Realty",
      ownerEmail: "owner@test.com",
      tier: "starter"
    });

    expect(result.name).toBe("Sunrise Realty");
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(db.insert).toHaveBeenCalled();
  });

  it("createBusiness throws on DB error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      createBusiness({ id: "x", name: "x", ownerEmail: "x@x.com", tier: "starter" })
    ).rejects.toThrow("createBusiness");
  });

  it("getBusiness returns null on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "nf" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getBusiness("bad-id");
    expect(result).toBeNull();
  });

  it("getBusiness returns row when found", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getBusiness("uuid-biz-1");
    expect(result?.name).toBe("Sunrise Realty");
  });

  it("listBusinesses returns array", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: [MOCK_BUSINESS], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await listBusinesses();
    expect(result).toHaveLength(1);
  });

  it("listBusinesses throws on DB error", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: null, error: { message: "oops" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listBusinesses()).rejects.toThrow("listBusinesses");
  });

  it("listBusinesses returns empty array when data is null but no error", async () => {
    // This hits the `data ?? []` branch
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: null, error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    // When error is null but data is also null, it would throw because error check comes first
    // Actually looking at the code: if (error) throw; return data ?? []
    // So null data with null error returns []
    const result = await listBusinesses(db as never);
    expect(result).toEqual([]);
  });

  it("updateBusinessStatus updates with vpsId", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessStatus("uuid-biz-1", "online", "vps-123");
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ status: "online", hostinger_vps_id: "vps-123" }));
  });

  it("updateBusinessStatus updates without vpsId", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessStatus("uuid-biz-1", "offline");
    expect(db.update).toHaveBeenCalledWith({ status: "offline" });
  });

  it("updateBusinessStatus throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessStatus("x", "online")).rejects.toThrow("updateBusinessStatus");
  });

  it("updateBusinessOwnerEmail updates owner email", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessOwnerEmail("uuid-biz-1", "paid@test.com");
    expect(db.update).toHaveBeenCalledWith({ owner_email: "paid@test.com" });
  });

  it("updateBusinessOwnerEmail throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmail("uuid-biz-1", "paid@test.com")).rejects.toThrow("updateBusinessOwnerEmail");
  });

  it("createBusiness uses provided client", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    const result = await createBusiness(
      { id: "uuid-biz-1", name: "Sunrise", ownerEmail: "o@o.com", tier: "starter" },
      db as never
    );
    expect(result.name).toBe("Sunrise Realty");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
