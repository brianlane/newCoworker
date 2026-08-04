import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/admin/view-as", () => ({ isViewAsActive: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/subscriptions", () => ({ getSubscription: vi.fn() }));
vi.mock("@/lib/db/auto-reload", () => ({
  getAutoReloadCard: vi.fn(),
  listAutoReloadRules: vi.fn(),
  upsertAutoReloadRule: vi.fn()
}));
vi.mock("@/lib/stripe/client", () => ({ createAutoReloadSetupSession: vi.fn() }));
// The route reads the consent copy for Stripe's own page; next-intl needs a
// request context that a unit test does not have.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `t:${key}`)
}));

import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  getAutoReloadCard,
  listAutoReloadRules,
  upsertAutoReloadRule
} from "@/lib/db/auto-reload";
import { createAutoReloadSetupSession } from "@/lib/stripe/client";
import { POST } from "@/app/api/billing/auto-reload/route";

/**
 * Guards on the auto-reload settings route. This is the surface that arms
 * unattended charging, so the auth/impersonation/entitlement checks and the
 * validation refusals matter more here than on an ordinary settings route.
 */

const OLD_ENV = process.env;

function post(body: unknown): Request {
  return new Request("https://ncw.example/api/billing/auto-reload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const VALID = {
  category: "sms",
  enabled: true,
  packId: "texts_500",
  thresholdUnits: 100,
  monthlyLimitCents: null
};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...OLD_ENV };
  process.env.NEXT_PUBLIC_APP_URL = "https://ncw.example";
  process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_s500";
  process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_c5";

  vi.mocked(getAuthUser).mockResolvedValue({ userId: "u1", email: "o@example.com" } as never);
  vi.mocked(isViewAsActive).mockResolvedValue(false);
  vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue("biz-1");
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({} as never);
  vi.mocked(getSubscription).mockResolvedValue({
    id: "sub-row",
    status: "active",
    stripe_subscription_id: "sub_1",
    stripe_customer_id: "cus_1"
  } as never);
  vi.mocked(getAutoReloadCard).mockResolvedValue({
    businessId: "biz-1",
    stripePaymentMethodId: "pm_1",
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpMonth: 1,
    cardExpYear: 2030,
    consentAt: "2026-08-01T00:00:00Z",
    revokedAt: null
  });
  vi.mocked(listAutoReloadRules).mockResolvedValue([]);
  vi.mocked(upsertAutoReloadRule).mockResolvedValue({ category: "sms" } as never);
  vi.mocked(createAutoReloadSetupSession).mockResolvedValue({
    id: "cs_setup",
    url: "https://checkout.stripe.com/setup"
  });
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("auth and impersonation guards", () => {
  it("refuses while view-as is active", async () => {
    // The business is resolved from the SIGNED-IN user, so an impersonating
    // admin's write would arm charging on the wrong tenant.
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const res = await POST(post(VALID));
    expect(res.status).toBe(403);
    expect(upsertAutoReloadRule).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it("404s when the user owns no billable business", async () => {
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(null);
    expect((await POST(post(VALID))).status).toBe(404);
  });
});

describe("body validation", () => {
  it("rejects a malformed body", async () => {
    const res = await POST(post({ category: "email", enabled: true }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(upsertAutoReloadRule).not.toHaveBeenCalled();
  });

  it("rejects an unavailable pack", async () => {
    delete process.env.STRIPE_SMS_BONUS_500_PRICE_ID;
    const res = await POST(post(VALID));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ message: "That pack is not available" });
  });

  it("rejects a threshold the pack cannot clear", async () => {
    const res = await POST(post({ ...VALID, thresholdUnits: 500 }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: { message: "The threshold must be smaller than the pack you picked" }
    });
  });

  it("rejects a threshold outside the allowed range", async () => {
    const res = await POST(post({ ...VALID, thresholdUnits: 1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a monthly limit below one pack price", async () => {
    const res = await POST(post({ ...VALID, monthlyLimitCents: 100 }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: { message: "The monthly limit must cover at least one pack" }
    });
  });

  it("requires a monthly limit for chat credit", async () => {
    // Chat credit raises the cap and is never consumed, so repeated reloads
    // stack for the period whether or not they are used.
    const res = await POST(
      post({
        category: "chat",
        enabled: true,
        packId: "usd_5",
        thresholdUnits: 2_000_000,
        monthlyLimitCents: null
      })
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: { message: "Set a monthly limit before turning on AI credit auto-reload" }
    });
  });
});

describe("subscription entitlement", () => {
  it("refuses to arm without an active subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({ status: "canceled" } as never);
    expect((await POST(post(VALID))).status).toBe(409);
  });

  it("still allows turning auto-reload OFF on a lapsed subscription", async () => {
    // A tenant must always be able to stop future charges.
    vi.mocked(getSubscription).mockResolvedValue({ status: "canceled" } as never);
    const res = await POST(post({ ...VALID, enabled: false }));
    expect(res.status).toBe(200);
    expect(upsertAutoReloadRule).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ enabled: false }),
      expect.anything()
    );
  });
});

describe("card authorization", () => {
  it("saves and returns no setup URL when a card is already authorized", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ data: { needsCard: false, setupUrl: null } });
    expect(createAutoReloadSetupSession).not.toHaveBeenCalled();
  });

  it("returns a setup URL when no card is authorized yet", async () => {
    vi.mocked(getAutoReloadCard).mockResolvedValue(null);
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    // The rule is saved anyway, so the tenant's choices survive the redirect.
    expect(upsertAutoReloadRule).toHaveBeenCalled();
    expect(await json(res)).toMatchObject({
      data: { needsCard: true, setupUrl: "https://checkout.stripe.com/setup" }
    });
  });

  it("treats a revoked card as no card", async () => {
    vi.mocked(getAutoReloadCard).mockResolvedValue({
      businessId: "biz-1",
      stripePaymentMethodId: "pm_1",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 1,
      cardExpYear: 2030,
      consentAt: "2026-08-01T00:00:00Z",
      revokedAt: "2026-08-02T00:00:00Z"
    });
    const res = await POST(post(VALID));
    expect(await json(res)).toMatchObject({ data: { needsCard: true } });
  });

  it("does not ask for a card when the rule is being turned off", async () => {
    vi.mocked(getAutoReloadCard).mockResolvedValue(null);
    const res = await POST(post({ ...VALID, enabled: false }));
    expect(await json(res)).toMatchObject({ data: { needsCard: false } });
    expect(createAutoReloadSetupSession).not.toHaveBeenCalled();
  });

  it("409s when there is no Stripe customer to attach a card to", async () => {
    vi.mocked(getAutoReloadCard).mockResolvedValue(null);
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_1",
      stripe_customer_id: null
    } as never);
    expect((await POST(post(VALID))).status).toBe(409);
  });
});

describe("persistence", () => {
  it("stores the per-family cooldown default rather than a caller value", async () => {
    // The cooldown is read from the row inside the claim RPC, so letting the
    // client set it would let a tenant shift the attempt bucket.
    await POST(post(VALID));
    expect(upsertAutoReloadRule).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ packId: "texts_500", cooldownMinutes: 120 }),
      expect.anything()
    );
  });

  it("normalizes an omitted monthly limit to null", async () => {
    await POST(post({ category: "sms", enabled: true, packId: "texts_500", thresholdUnits: 100 }));
    expect(upsertAutoReloadRule).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ monthlyLimitCents: null }),
      expect.anything()
    );
  });
});

describe("re-arming after a system disable", () => {
  it("refuses to re-arm a rule blocked by a dispute", async () => {
    // A chargeback is the customer saying they did not expect the charge, so
    // turning auto-charging back on is a support decision, not a toggle.
    vi.mocked(listAutoReloadRules).mockResolvedValue([
      { category: "sms", disabledReason: "dispute" }
    ] as never);
    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    expect(upsertAutoReloadRule).not.toHaveBeenCalled();
  });

  it("allows re-arming after declines, which the save clears", async () => {
    vi.mocked(listAutoReloadRules).mockResolvedValue([
      { category: "sms", disabledReason: "payment_failures" }
    ] as never);
    expect((await POST(post(VALID))).status).toBe(200);
  });

  it("ignores a dispute on a different family", async () => {
    vi.mocked(listAutoReloadRules).mockResolvedValue([
      { category: "voice", disabledReason: "dispute" }
    ] as never);
    expect((await POST(post(VALID))).status).toBe(200);
  });

  it("does not check the dispute state when turning auto-reload off", async () => {
    vi.mocked(listAutoReloadRules).mockResolvedValue([
      { category: "sms", disabledReason: "dispute" }
    ] as never);
    expect((await POST(post({ ...VALID, enabled: false }))).status).toBe(200);
  });
});
