import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  countPromotionRedemptions,
  createPromotion,
  deletePromotion,
  getPromotion,
  getPromotionByCode,
  listPromotionRedemptions,
  listPromotions,
  listRedemptionsForPromotion,
  recordPromotionRedemption,
  updatePromotion,
  type PromotionRow
} from "@/lib/db/promotions";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const PROMO: PromotionRow = {
  id: "aaaa0000-0000-4000-8000-000000000001",
  code: "SUMMER20",
  name: "Summer 2026",
  percent_off: 20,
  amount_off_cents: null,
  duration: "once",
  duration_in_months: null,
  allowed_tiers: ["starter", "standard"],
  allowed_periods: ["monthly", "annual", "biennial"],
  starts_at: "2026-07-01T00:00:00Z",
  ends_at: null,
  max_redemptions: null,
  active: true,
  stripe_coupon_id: "coupon_1",
  stripe_promotion_code_id: "promo_1",
  created_by: "admin@test.com",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

const CREATE_INPUT = {
  code: PROMO.code,
  name: PROMO.name,
  percentOff: 20,
  amountOffCents: null,
  duration: "once" as const,
  durationInMonths: null,
  allowedTiers: PROMO.allowed_tiers,
  allowedPeriods: PROMO.allowed_periods,
  startsAt: PROMO.starts_at,
  endsAt: null,
  maxRedemptions: null,
  active: true,
  stripeCouponId: "coupon_1",
  stripePromotionCodeId: "promo_1",
  createdBy: "admin@test.com"
};

describe("db/promotions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createPromotion inserts the mapped row and returns it", async () => {
    const select = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: PROMO, error: null })
    });
    const db = mockDb({ select });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(createPromotion(CREATE_INPUT)).resolves.toEqual(PROMO);
    expect(db.insert).toHaveBeenCalledWith({
      code: "SUMMER20",
      name: "Summer 2026",
      percent_off: 20,
      amount_off_cents: null,
      duration: "once",
      duration_in_months: null,
      allowed_tiers: ["starter", "standard"],
      allowed_periods: ["monthly", "annual", "biennial"],
      starts_at: PROMO.starts_at,
      ends_at: null,
      max_redemptions: null,
      active: true,
      stripe_coupon_id: "coupon_1",
      stripe_promotion_code_id: "promo_1",
      created_by: "admin@test.com"
    });
  });

  it("createPromotion surfaces a DB error", async () => {
    const select = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "duplicate code" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ select }) as never);
    await expect(createPromotion(CREATE_INPUT)).rejects.toThrow("createPromotion: duplicate code");
  });

  it("listPromotions returns rows newest first", async () => {
    const select = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: [PROMO], error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ select }) as never);
    await expect(listPromotions()).resolves.toEqual([PROMO]);
  });

  it("listPromotions defaults a null payload to an empty list", async () => {
    const select = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ select }) as never);
    await expect(listPromotions()).resolves.toEqual([]);
  });

  it("listPromotions surfaces a DB error", async () => {
    const select = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ select }) as never);
    await expect(listPromotions()).rejects.toThrow("listPromotions: boom");
  });

  it("getPromotion returns the row and null when missing", async () => {
    const found = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: PROMO, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(found as never);
    await expect(getPromotion(PROMO.id)).resolves.toEqual(PROMO);

    const missing = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(missing as never);
    await expect(getPromotion(PROMO.id)).resolves.toBeNull();
  });

  it("getPromotion surfaces a DB error", async () => {
    const db = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getPromotion(PROMO.id)).rejects.toThrow("getPromotion: nope");
  });

  it("getPromotionByCode matches the stored uppercase code", async () => {
    const eq = vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: PROMO, error: null })
    });
    const db = mockDb({ select: vi.fn().mockReturnValue({ eq }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getPromotionByCode("SUMMER20")).resolves.toEqual(PROMO);
    expect(eq).toHaveBeenCalledWith("code", "SUMMER20");
  });

  it("getPromotionByCode returns null when the code is unknown", async () => {
    const db = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getPromotionByCode("NOPE")).resolves.toBeNull();
  });

  it("getPromotionByCode surfaces a DB error", async () => {
    const db = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "down" } })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getPromotionByCode("SUMMER20")).rejects.toThrow("getPromotionByCode: down");
  });

  it("updatePromotion maps every editable field and stamps updated_at", async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: PROMO, error: null })
        })
      })
    });
    const db = mockDb({ update });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      updatePromotion(PROMO.id, {
        name: "Renamed",
        percentOff: null,
        amountOffCents: 2500,
        duration: "repeating",
        durationInMonths: 3,
        allowedTiers: ["standard"],
        allowedPeriods: ["biennial"],
        startsAt: "2026-08-01T00:00:00Z",
        endsAt: "2026-09-01T00:00:00Z",
        maxRedemptions: 50,
        active: false,
        stripeCouponId: "coupon_2",
        stripePromotionCodeId: "promo_2"
      })
    ).resolves.toEqual(PROMO);

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: "Renamed",
      percent_off: null,
      amount_off_cents: 2500,
      duration: "repeating",
      duration_in_months: 3,
      allowed_tiers: ["standard"],
      allowed_periods: ["biennial"],
      starts_at: "2026-08-01T00:00:00Z",
      ends_at: "2026-09-01T00:00:00Z",
      max_redemptions: 50,
      active: false,
      stripe_coupon_id: "coupon_2",
      stripe_promotion_code_id: "promo_2"
    });
    expect(typeof payload.updated_at).toBe("string");
  });

  it("updatePromotion writes only updated_at for an empty patch and returns null when the id is unknown", async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ update }) as never);
    await expect(updatePromotion(PROMO.id, {})).resolves.toBeNull();
    expect(Object.keys(update.mock.calls[0][0] as object)).toEqual(["updated_at"]);
  });

  it("updatePromotion surfaces a DB error", async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "locked" } })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb({ update }) as never);
    await expect(updatePromotion(PROMO.id, { active: true })).rejects.toThrow(
      "updatePromotion: locked"
    );
  });

  it("deletePromotion reports whether a row was removed", async () => {
    const deleted = mockDb({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: [{ id: PROMO.id }], error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(deleted as never);
    await expect(deletePromotion(PROMO.id)).resolves.toBe(true);

    const nothing = mockDb({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: null, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(nothing as never);
    await expect(deletePromotion(PROMO.id)).resolves.toBe(false);
  });

  it("deletePromotion surfaces the restrict violation as an error", async () => {
    const db = mockDb({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue({ data: null, error: { message: "foreign key violation" } })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(deletePromotion(PROMO.id)).rejects.toThrow(
      "deletePromotion: foreign key violation"
    );
  });

  const REDEMPTION = {
    id: "bbbb0000-0000-4000-8000-000000000001",
    promotion_id: PROMO.id,
    business_id: "cccc0000-0000-4000-8000-000000000001",
    tier: "standard" as const,
    billing_period: "biennial" as const,
    stripe_session_id: "cs_1",
    amount_discounted_cents: 47520,
    created_at: "2026-07-20T00:00:00Z"
  };

  it("listPromotionRedemptions returns rows and defaults a null payload", async () => {
    const withRows = mockDb({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: [REDEMPTION], error: null })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(withRows as never);
    await expect(listPromotionRedemptions()).resolves.toEqual([REDEMPTION]);

    const empty = mockDb({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: null, error: null })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    await expect(listPromotionRedemptions()).resolves.toEqual([]);
  });

  it("listPromotionRedemptions surfaces a DB error", async () => {
    const db = mockDb({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: null, error: { message: "bad" } })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listPromotionRedemptions()).rejects.toThrow("listPromotionRedemptions: bad");
  });

  it("listRedemptionsForPromotion scopes to one promotion", async () => {
    const eq = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: [REDEMPTION], error: null })
    });
    const db = mockDb({ select: vi.fn().mockReturnValue({ eq }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listRedemptionsForPromotion(PROMO.id)).resolves.toEqual([REDEMPTION]);
    expect(eq).toHaveBeenCalledWith("promotion_id", PROMO.id);
  });

  it("listRedemptionsForPromotion defaults a null payload and surfaces errors", async () => {
    const empty = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: null, error: null })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    await expect(listRedemptionsForPromotion(PROMO.id)).resolves.toEqual([]);

    const failing = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: null, error: { message: "gone" } })
        })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(failing as never);
    await expect(listRedemptionsForPromotion(PROMO.id)).rejects.toThrow(
      "listRedemptionsForPromotion: gone"
    );
  });

  it("countPromotionRedemptions returns the head count, defaulting null to zero", async () => {
    const counted = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ count: 4, error: null })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(counted as never);
    await expect(countPromotionRedemptions(PROMO.id)).resolves.toBe(4);

    const nullCount = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ count: null, error: null })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(nullCount as never);
    await expect(countPromotionRedemptions(PROMO.id)).resolves.toBe(0);
  });

  it("countPromotionRedemptions surfaces a DB error", async () => {
    const db = mockDb({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ count: null, error: { message: "timeout" } })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(countPromotionRedemptions(PROMO.id)).rejects.toThrow(
      "countPromotionRedemptions: timeout"
    );
  });

  it("recordPromotionRedemption upserts on the session id and reports a fresh insert", async () => {
    const upsert = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: [{ id: REDEMPTION.id }], error: null })
    });
    const db = mockDb({ upsert });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      recordPromotionRedemption({
        promotionId: PROMO.id,
        businessId: REDEMPTION.business_id,
        tier: "standard",
        billingPeriod: "biennial",
        stripeSessionId: "cs_1",
        amountDiscountedCents: 47520
      })
    ).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      {
        promotion_id: PROMO.id,
        business_id: REDEMPTION.business_id,
        tier: "standard",
        billing_period: "biennial",
        stripe_session_id: "cs_1",
        amount_discounted_cents: 47520
      },
      { onConflict: "stripe_session_id", ignoreDuplicates: true }
    );
  });

  it("recordPromotionRedemption reports false when the retry hit the unique index", async () => {
    const db = mockDb({
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: null, error: null })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      recordPromotionRedemption({
        promotionId: PROMO.id,
        businessId: REDEMPTION.business_id,
        tier: "starter",
        billingPeriod: "monthly",
        stripeSessionId: "cs_1",
        amountDiscountedCents: 0
      })
    ).resolves.toBe(false);
  });

  it("recordPromotionRedemption surfaces a DB error", async () => {
    const db = mockDb({
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: null, error: { message: "no grant" } })
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      recordPromotionRedemption({
        promotionId: PROMO.id,
        businessId: REDEMPTION.business_id,
        tier: "starter",
        billingPeriod: "monthly",
        stripeSessionId: "cs_2",
        amountDiscountedCents: 0
      })
    ).rejects.toThrow("recordPromotionRedemption: no grant");
  });

  it("every accessor accepts an injected client instead of building one", async () => {
    const injected = mockDb({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: [PROMO], error: null })
      })
    });
    await expect(listPromotions(injected as never)).resolves.toEqual([PROMO]);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
