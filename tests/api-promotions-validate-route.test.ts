import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/promotions/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/promotions/validate")>();
  return { ...actual, validatePromotionCode: vi.fn() };
});

import { POST } from "@/app/api/promotions/validate/route";
import { validatePromotionCode } from "@/lib/promotions/validate";
import type { PromotionRow } from "@/lib/db/promotions";

const PROMO = {
  id: "22222222-2222-4222-8222-222222222222",
  code: "SUMMER20",
  name: "Summer 2026",
  duration: "repeating",
  duration_in_months: 3,
  stripe_promotion_code_id: "promo_1"
} as PromotionRow;

function post(body: unknown) {
  return new Request("http://localhost/api/promotions/validate", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

const VALID_BODY = { code: "summer20", tier: "standard", billingPeriod: "biennial" };

describe("api/promotions/validate route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the discount preview for a live code", async () => {
    vi.mocked(validatePromotionCode).mockResolvedValue({
      ok: true,
      promotion: PROMO,
      discountCents: 47520,
      planDueTodayCents: 190080
    });
    const res = await POST(post(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: {
        valid: true,
        code: "SUMMER20",
        name: "Summer 2026",
        discountCents: 47520,
        planDueTodayCents: 190080,
        // The order summary's continuation note needs the covered span.
        duration: "repeating",
        durationInMonths: 3
      }
    });
    expect(validatePromotionCode).toHaveBeenCalledWith({
      code: "summer20",
      tier: "standard",
      period: "biennial"
    });
  });

  it.each([
    ["not_found"],
    ["inactive"],
    ["scheduled"],
    ["expired"],
    ["exhausted"],
    ["tier_not_allowed"],
    ["period_not_allowed"]
  ] as const)("collapses %s to the generic invalid message", async (reason) => {
    vi.mocked(validatePromotionCode).mockResolvedValue({ ok: false, reason });
    const json = (await (await POST(post(VALID_BODY))).json()) as {
      data: { valid: boolean; reason: string };
    };
    // Confirming a real code exists but is capped or scoped elsewhere would
    // only invite probing.
    expect(json.data).toEqual({ valid: false, reason: "invalid" });
  });

  it("keeps the distinct message for a code that would not lower the price", async () => {
    vi.mocked(validatePromotionCode).mockResolvedValue({ ok: false, reason: "not_better" });
    const json = (await (await POST(post(VALID_BODY))).json()) as {
      data: { valid: boolean; reason: string };
    };
    expect(json.data).toEqual({ valid: false, reason: "notBetter" });
  });

  it("rejects a malformed body without hitting the database", async () => {
    expect((await POST(post({ code: "AB", tier: "standard", billingPeriod: "biennial" }))).status).toBe(400);
    expect((await POST(post({ code: "SUMMER20", tier: "enterprise", billingPeriod: "biennial" }))).status).toBe(400);
    expect(validatePromotionCode).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected lookup failure as a 500", async () => {
    vi.mocked(validatePromotionCode).mockRejectedValue(new Error("db down"));
    expect((await POST(post(VALID_BODY))).status).toBe(500);
  });
});
