import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBusiness,
  getBusiness,
  getBusinessTimezone,
  isValidIanaTimezone,
  listBusinesses,
  listBusinessIdsByOwnerEmail,
  recordWhiteGlovePurchase,
  setBusinessPaused,
  setCustomerChannelsEnabled,
  updateBusinessName,
  updateBusinessOwnerEmail,
  updateBusinessOwnerEmailIfPending,
  updateBusinessStatus,
  updateBusinessBranding,
  updateBusinessTimezone,
  updateComplianceModule,
  updateEnterpriseModels,
  updateBusinessVpsSize,
  updateBusinessWebsiteUrl,
  updateEnterpriseLimits
} from "@/lib/db/businesses";
import { createPendingOwnerEmail } from "@/lib/onboarding/token";

// Mock the Supabase service client
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

// createBusiness auto-attaches prospect white-glove offers; keep it inert
// here (its own behavior is covered in db-white-glove-offers.test.ts).
vi.mock("@/lib/db/white-glove-offers", () => ({
  attachProspectWhiteGloveOffersToBusiness: vi.fn().mockResolvedValue(0)
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { attachProspectWhiteGloveOffersToBusiness } from "@/lib/db/white-glove-offers";

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
    // A prospect who paid a white-glove offer pre-signup gets it attached to
    // the new business automatically.
    expect(attachProspectWhiteGloveOffersToBusiness).toHaveBeenCalledWith(
      MOCK_BUSINESS.id,
      "owner@test.com",
      db
    );
  });

  it("createBusiness survives a failing prospect white-glove attach (best-effort)", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.mocked(attachProspectWhiteGloveOffersToBusiness).mockRejectedValueOnce(
      new Error("ledger down")
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createBusiness({
        id: "uuid-biz-1",
        name: "Sunrise Realty",
        ownerEmail: "owner@test.com",
        tier: "starter"
      });
      expect(result.name).toBe("Sunrise Realty");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("createBusiness tolerates a non-Error attach failure", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.mocked(attachProspectWhiteGloveOffersToBusiness).mockRejectedValueOnce("string failure");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBusiness({ id: "x", name: "X", ownerEmail: "x@x.com", tier: "starter" });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("createBusiness passes the detected timezone through to the insert", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_BUSINESS, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await createBusiness({
      id: "uuid-biz-1",
      name: "Sunrise Realty",
      ownerEmail: "owner@test.com",
      tier: "starter",
      timezone: "America/Phoenix"
    });

    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Phoenix" })
    );
  });

  it("createBusiness throws on DB error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      createBusiness({ id: "x", name: "x", ownerEmail: "x@x.com", tier: "starter" })
    ).rejects.toThrow("createBusiness");
  });

  describe("listBusinessIdsByOwnerEmail", () => {
    it("returns the ids of every business owned by the email, newest first", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({
          data: [{ id: "biz-new" }, { id: "biz-old" }],
          error: null
        })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const ids = await listBusinessIdsByOwnerEmail("owner@test.com");
      expect(ids).toEqual(["biz-new", "biz-old"]);
      expect(db.from).toHaveBeenCalledWith("businesses");
      expect(db.eq).toHaveBeenCalledWith("owner_email", "owner@test.com");
      expect(db.order).toHaveBeenCalledWith("created_at", { ascending: false });
    });

    it("returns an empty array when the owner has no businesses", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: null, error: null })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(listBusinessIdsByOwnerEmail("nobody@test.com")).resolves.toEqual([]);
    });

    it("throws on a query error so the checkout guard fails closed", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: null, error: { message: "replica down" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(listBusinessIdsByOwnerEmail("owner@test.com")).rejects.toThrow(
        "listBusinessIdsByOwnerEmail: replica down"
      );
    });
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

  it("setCustomerChannelsEnabled writes the Safe Mode flag (enabled=true → Safe Mode OFF)", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await setCustomerChannelsEnabled("uuid-biz-1", true);
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(db.update).toHaveBeenCalledWith({ customer_channels_enabled: true });
    expect(db.eq).toHaveBeenCalledWith("id", "uuid-biz-1");
  });

  it("setCustomerChannelsEnabled writes false when Safe Mode is turned ON", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    await setCustomerChannelsEnabled("uuid-biz-1", false, db as never);
    expect(db.update).toHaveBeenCalledWith({ customer_channels_enabled: false });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("setCustomerChannelsEnabled throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "boom" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(setCustomerChannelsEnabled("uuid-biz-1", true)).rejects.toThrow(
      "setCustomerChannelsEnabled"
    );
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

  it("updateEnterpriseModels writes/clears enterprise_models json, throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateEnterpriseModels("uuid-biz-1", { voiceName: "Puck" });
    expect(db.update).toHaveBeenCalledWith({ enterprise_models: { voiceName: "Puck" } });

    await updateEnterpriseModels("uuid-biz-1", null);
    expect(db.update).toHaveBeenCalledWith({ enterprise_models: null });

    const bad = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(bad as never);
    await expect(updateEnterpriseModels("uuid-biz-1", null)).rejects.toThrow(
      "updateEnterpriseModels"
    );
  });

  it("updateComplianceModule writes/clears compliance_module json, throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateComplianceModule("uuid-biz-1", { forbiddenTerms: ["merger"] });
    expect(db.update).toHaveBeenCalledWith({ compliance_module: { forbiddenTerms: ["merger"] } });

    await updateComplianceModule("uuid-biz-1", null);
    expect(db.update).toHaveBeenCalledWith({ compliance_module: null });

    const bad = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(bad as never);
    await expect(updateComplianceModule("uuid-biz-1", null)).rejects.toThrow(
      "updateComplianceModule"
    );
  });

  it("updateBusinessBranding writes branding json, clears with null, throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateBusinessBranding("uuid-biz-1", { productName: "Acme" });
    expect(db.update).toHaveBeenCalledWith({ branding: { productName: "Acme" } });

    await updateBusinessBranding("uuid-biz-1", null);
    expect(db.update).toHaveBeenCalledWith({ branding: null });

    const bad = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(bad as never);
    await expect(updateBusinessBranding("uuid-biz-1", null)).rejects.toThrow(
      "updateBusinessBranding"
    );
  });

  it("recordWhiteGlovePurchase stamps package + priority window on the row", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await recordWhiteGlovePurchase("uuid-biz-1", {
      packageId: "buildout",
      purchasedAt: new Date("2026-07-04T12:00:00.000Z"),
      prioritySupportUntil: new Date("2026-08-03T12:00:00.000Z")
    });

    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(db.update).toHaveBeenCalledWith({
      white_glove_package: "buildout",
      white_glove_purchased_at: "2026-07-04T12:00:00.000Z",
      priority_support_until: "2026-08-03T12:00:00.000Z"
    });
    expect(db.eq).toHaveBeenCalledWith("id", "uuid-biz-1");
  });

  it("recordWhiteGlovePurchase throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      recordWhiteGlovePurchase("uuid-biz-1", {
        packageId: "setup",
        purchasedAt: new Date("2026-07-04T12:00:00.000Z"),
        prioritySupportUntil: new Date("2026-08-03T12:00:00.000Z")
      })
    ).rejects.toThrow("recordWhiteGlovePurchase");
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

  it("updateBusinessName updates the business name", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessName("uuid-biz-1", "New Name LLC");
    expect(db.update).toHaveBeenCalledWith({ name: "New Name LLC" });
    expect(db.eq).toHaveBeenCalledWith("id", "uuid-biz-1");
  });

  it("updateBusinessName throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessName("uuid-biz-1", "New Name LLC")).rejects.toThrow("updateBusinessName");
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
    // The REAL email just landed (row was created with the pending sentinel):
    // prospect white-glove offers keyed to it are attached now.
    expect(attachProspectWhiteGloveOffersToBusiness).toHaveBeenCalledWith(
      "uuid-biz-1",
      "paid@test.com",
      db
    );
  });

  it("updateBusinessOwnerEmailIfPending survives a failing prospect attach (best-effort)", async () => {
    const updateQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: "uuid-biz-1" }], error: null })
    };
    const db = { from: vi.fn().mockReturnValue(updateQuery) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.mocked(attachProspectWhiteGloveOffersToBusiness).mockRejectedValueOnce(
      new Error("ledger down")
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")
      ).resolves.toBe(true);
      expect(errSpy).toHaveBeenCalled();

      // Non-Error rejections are stringified, not rethrown.
      vi.mocked(attachProspectWhiteGloveOffersToBusiness).mockRejectedValueOnce("string fail");
      await expect(
        updateBusinessOwnerEmailIfPending("uuid-biz-1", "paid@test.com")
      ).resolves.toBe(true);
    } finally {
      errSpy.mockRestore();
    }
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

  it("isValidIanaTimezone accepts real zones and rejects junk", () => {
    expect(isValidIanaTimezone("America/Phoenix")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });

  it("updateBusinessTimezone writes the zone and supports clearing with null", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessTimezone("uuid-biz-1", "America/Phoenix");
    expect(db.update).toHaveBeenCalledWith({ timezone: "America/Phoenix" });

    await updateBusinessTimezone("uuid-biz-1", null, db as never);
    expect(db.update).toHaveBeenCalledWith({ timezone: null });
  });

  it("updateBusinessTimezone throws when Supabase reports an error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessTimezone("uuid-biz-1", "UTC")).rejects.toThrow(
      "updateBusinessTimezone"
    );
  });

  it("updateBusinessVpsSize writes the pin and supports clearing with null", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateBusinessVpsSize("uuid-biz-1", "kvm2");
    expect(db.update).toHaveBeenCalledWith({ vps_size: "kvm2" });

    await updateBusinessVpsSize("uuid-biz-1", null, db as never);
    expect(db.update).toHaveBeenCalledWith({ vps_size: null });
  });

  it("updateBusinessVpsSize throws when Supabase reports an error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateBusinessVpsSize("uuid-biz-1", "kvm8")).rejects.toThrow(
      "updateBusinessVpsSize"
    );
  });

  it("getBusinessTimezone returns the trimmed zone when set", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: { timezone: "America/Denver" }, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getBusinessTimezone("uuid-biz-1")).resolves.toBe("America/Denver");
  });

  it("getBusinessTimezone returns null for unset, blank, error, and missing rows", async () => {
    const cases = [
      { data: { timezone: null }, error: null },
      { data: { timezone: "   " }, error: null },
      { data: null, error: { message: "boom" } },
      { data: null, error: null }
    ];
    for (const result of cases) {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue(result) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getBusinessTimezone("uuid-biz-1")).resolves.toBeNull();
    }
  });

  it("getBusinessTimezone honors an injected client", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: { timezone: "UTC" }, error: null })
    });
    await expect(getBusinessTimezone("uuid-biz-1", db as never)).resolves.toBe("UTC");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
