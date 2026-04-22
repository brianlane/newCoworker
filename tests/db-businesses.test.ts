import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBusiness,
  getBusiness,
  listBusinesses,
  setBusinessPaused,
  updateBusinessOwnerEmail,
  updateBusinessOwnerEmailIfPending,
  updateBusinessStatus,
  updateBusinessWebsiteUrl,
  updateEnterpriseLimits
} from "@/lib/db/businesses";
import { createPendingOwnerEmail } from "@/lib/onboarding/token";

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

  it("setBusinessPaused updates is_paused", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await setBusinessPaused("uuid-biz-1", true);
    expect(db.update).toHaveBeenCalledWith({ is_paused: true });
  });

  it("setBusinessPaused throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(setBusinessPaused("uuid-biz-1", false)).rejects.toThrow("setBusinessPaused");
  });

  it("updateEnterpriseLimits writes enterprise_limits json", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateEnterpriseLimits("uuid-biz-1", { maxConcurrentCalls: 20 });
    expect(db.update).toHaveBeenCalledWith({
      enterprise_limits: { maxConcurrentCalls: 20 }
    });
  });

  it("updateEnterpriseLimits clears overrides with null", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateEnterpriseLimits("uuid-biz-1", null);
    expect(db.update).toHaveBeenCalledWith({ enterprise_limits: null });
  });

  it("updateEnterpriseLimits throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateEnterpriseLimits("uuid-biz-1", { maxConcurrentCalls: 5 })).rejects.toThrow(
      "updateEnterpriseLimits"
    );
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

  it("updateBusinessOwnerEmailIfPending updates when the business is still pending", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: "uuid-biz-1" }], error: null })
    };
    const db = {
      from: vi.fn().mockReturnValue(updateQuery)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).resolves.toBe(true);
    expect(updateQuery.update).toHaveBeenCalledWith({ owner_email: "paid@test.com" });
    expect(updateQuery.eq).toHaveBeenNthCalledWith(1, "id", "uuid-biz-1");
    expect(updateQuery.eq).toHaveBeenNthCalledWith(2, "owner_email", createPendingOwnerEmail("uuid-biz-1"));
  });

  it("updateBusinessOwnerEmailIfPending does not update when the business already has a real owner", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null })
    };
    const db = {
      ...mockDb(),
      from: vi.fn()
        .mockReturnValueOnce(updateQuery)
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null })
        }),
      single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).resolves.toBe(false);
    expect(updateQuery.update).toHaveBeenCalled();
  });

  it("updateBusinessOwnerEmailIfPending is idempotent when the owner email is already finalized", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null })
    };
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(updateQuery)
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { ...MOCK_BUSINESS, owner_email: "paid@test.com" },
            error: null
          })
        })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).resolves.toBe(true);
    expect(updateQuery.update).toHaveBeenCalled();
  });

  it("updateBusinessOwnerEmailIfPending returns false when the business cannot be found", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null })
    };
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(updateQuery)
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } })
        })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).resolves.toBe(false);
    expect(updateQuery.update).toHaveBeenCalled();
  });

  it("updateBusinessOwnerEmailIfPending throws when the conditional update fails", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    };
    const db = {
      from: vi.fn().mockReturnValue(updateQuery)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).rejects.toThrow(
      "updateBusinessOwnerEmailIfPending"
    );
  });

  it("updateBusinessOwnerEmailIfPending handles a null conditional-update result without treating it as success", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(updateQuery)
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { ...MOCK_BUSINESS, owner_email: "paid@test.com" },
            error: null
          })
        })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")).resolves.toBe(true);
  });

  it("updateBusinessWebsiteUrl writes the normalized URL and uses the service client by default", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessWebsiteUrl("uuid-biz-1", "https://example.com/");
    expect(db.update).toHaveBeenCalledWith({ website_url: "https://example.com/" });
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("updateBusinessWebsiteUrl accepts a null URL to clear the field and honors an injected client", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    await updateBusinessWebsiteUrl("uuid-biz-1", null, db as never);
    expect(db.update).toHaveBeenCalledWith({ website_url: null });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("updateBusinessWebsiteUrl throws when Supabase reports an error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessWebsiteUrl("uuid-biz-1", "https://example.com/")).rejects.toThrow(
      "updateBusinessWebsiteUrl"
    );
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
