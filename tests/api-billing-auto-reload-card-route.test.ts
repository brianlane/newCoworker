import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/subscriptions", () => ({ getSubscription: vi.fn() }));
vi.mock("@/lib/stripe/client", () => ({ createAutoReloadSetupSession: vi.fn() }));
// The route reads the consent copy for Stripe's own page; next-intl needs a
// request context that a unit test does not have.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `t:${key}`)
}));

import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { createAutoReloadSetupSession } from "@/lib/stripe/client";
import { POST } from "@/app/api/billing/auto-reload/card/route";

/**
 * Re-authorizing the auto-reload card.
 *
 * This exists because the Stripe billing portal is the wrong tool: it updates
 * the card on the MEMBERSHIP subscription, which is a different payment
 * method from the one auto-reload charges. Sending a tenant to the portal
 * would look like it worked while the sweep kept charging the old card.
 */

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://ncw.example";
  vi.mocked(getAuthUser).mockResolvedValue({ userId: "u1", email: "o@example.com" } as never);
  vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue("biz-1");
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({} as never);
  vi.mocked(getSubscription).mockResolvedValue({ stripe_customer_id: "cus_1" } as never);
  vi.mocked(createAutoReloadSetupSession).mockResolvedValue({
    id: "cs_setup",
    url: "https://checkout.stripe.com/setup"
  });
});

describe("POST /api/billing/auto-reload/card", () => {
  it("mints a setup session for the tenant's own customer", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { setupUrl: "https://checkout.stripe.com/setup" }
    });
    expect(createAutoReloadSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_1", businessId: "biz-1", userId: "u1" })
    );
  });

  it("mints the session for the resolved business, not the caller's own", async () => {
    // Admin view-as can re-authorize a tenant's card, and this is the line
    // that keeps it pointed at the tenant: the business id comes from
    // resolveActiveBusinessIdForAction (view-as aware), never from
    // getAuthUser().email.
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue("biz-tenant");
    expect((await POST()).status).toBe(200);
    expect(createAutoReloadSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-tenant" })
    );
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await POST()).status).toBe(403);
  });

  it("404s when the user owns no billable business", async () => {
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(null);
    expect((await POST()).status).toBe(404);
  });

  it("409s when there is no Stripe customer to attach a card to", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null as never);
    expect((await POST()).status).toBe(409);
  });

  it("surfaces a Stripe failure rather than returning a broken URL", async () => {
    vi.mocked(createAutoReloadSetupSession).mockRejectedValue(new Error("stripe down"));
    expect((await POST()).status).toBeGreaterThanOrEqual(500);
  });
});
