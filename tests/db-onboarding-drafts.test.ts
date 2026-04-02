import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOnboardingDraft, upsertOnboardingDraft } from "@/lib/db/onboarding-drafts";
import type { OnboardingData } from "@/lib/onboarding/storage";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_PAYLOAD: OnboardingData = {
  tier: "standard",
  billingPeriod: "biennial",
  businessName: "Test Biz",
  businessType: "real_estate",
  ownerName: "Brian Lane",
  ownerEmail: "owner@example.com",
  phone: "16026866672",
  serviceArea: "Phoenix",
  typicalInquiry: "Test inquiry",
  teamSize: "1",
  crmUsed: ""
};

const MOCK_ROW = {
  business_id: "11111111-1111-4111-8111-111111111111",
  draft_token: "22222222-2222-4222-8222-222222222222",
  payload: MOCK_PAYLOAD,
  created_at: "2026-04-02T00:00:00Z",
  updated_at: "2026-04-02T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_ROW, error: null }),
    ...overrides
  };
}

describe("db/onboarding-drafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts onboarding drafts", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await upsertOnboardingDraft({
      businessId: MOCK_ROW.business_id,
      draftToken: MOCK_ROW.draft_token,
      payload: MOCK_ROW.payload
    });

    expect(row.business_id).toBe(MOCK_ROW.business_id);
  });

  it("gets onboarding draft by business id and token", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOnboardingDraft(MOCK_ROW.business_id, MOCK_ROW.draft_token);
    expect(row?.draft_token).toBe(MOCK_ROW.draft_token);
    expect(db.eq).toHaveBeenCalledWith("draft_token", MOCK_ROW.draft_token);
  });

  it("returns null when draft lookup fails", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST116", message: "not found" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOnboardingDraft(MOCK_ROW.business_id, MOCK_ROW.draft_token);
    expect(row).toBeNull();
  });

  it("throws when onboarding draft lookup hits a database error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "db down" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      getOnboardingDraft(MOCK_ROW.business_id, MOCK_ROW.draft_token)
    ).rejects.toThrow("getOnboardingDraft: db down");
  });

  it("throws when upsert onboarding draft fails", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      upsertOnboardingDraft({
        businessId: MOCK_ROW.business_id,
        draftToken: MOCK_ROW.draft_token,
        payload: MOCK_ROW.payload
      })
    ).rejects.toThrow("upsertOnboardingDraft: boom");
  });

  it("gets onboarding draft by business id when no token is provided", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOnboardingDraft(MOCK_ROW.business_id);
    expect(row?.business_id).toBe(MOCK_ROW.business_id);
    expect(db.eq).toHaveBeenCalledTimes(1);
    expect(db.eq).toHaveBeenCalledWith("business_id", MOCK_ROW.business_id);
  });

  it("uses provided client without creating a service client", async () => {
    const db = mockDb();

    const row = await getOnboardingDraft(MOCK_ROW.business_id, MOCK_ROW.draft_token, db as never);
    expect(row?.draft_token).toBe(MOCK_ROW.draft_token);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("upserts with provided client without creating a service client", async () => {
    const db = mockDb();

    const row = await upsertOnboardingDraft({
      businessId: MOCK_ROW.business_id,
      draftToken: MOCK_ROW.draft_token,
      payload: MOCK_ROW.payload
    }, db as never);

    expect(row.business_id).toBe(MOCK_ROW.business_id);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
