import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 2 (agency): the route resolves the ACTIVE business through the
// cookie-aware helper; pin it to a fixed id here, the supabase chain mock
// below still decides which rows come back, so existing fixtures keep
// driving each scenario.
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111")
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));


vi.mock("@/lib/stripe/client", () => ({
  createCustomerPortalSession: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

import { POST } from "@/app/api/billing/portal/route";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createCustomerPortalSession } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";

describe("api/billing/portal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      email: "owner@example.com"
    } as never);
    vi.mocked(createCustomerPortalSession).mockResolvedValue({
      url: "https://billing.stripe.com/session/mock"
    });
    vi.mocked(getSubscription).mockResolvedValue({
      stripe_customer_id: "cus_123"
    } as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ id: "biz_123" }],
        error: null
      })
    } as never);
  });

  it("opens the portal for the business the active-business resolver picked", async () => {
    // Impersonation is full access, and this is what makes it safe: the
    // business comes from resolveActiveBusinessIdForAction (which honors the
    // view-as pin), never from the signed-in user's own email. If someone
    // re-derives it from the caller, an admin in view-as would open the
    // OPERATOR's portal while the page shows the tenant.
    const TENANT = "22222222-2222-4222-8222-222222222222";
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(TENANT);
    const inFilter = vi.fn().mockReturnThis();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: inFilter,
      limit: vi.fn().mockResolvedValue({ data: [{ id: TENANT }], error: null })
    } as never);

    const response = await POST();
    expect(response.status).toBe(303);
    // The row lookup is filtered by the RESOLVED id, and it is resolved at
    // the owner-only bar. A caller-derived business would show up here as the
    // operator's own id instead of the tenant's.
    expect(resolveActiveBusinessIdForAction).toHaveBeenCalledWith(
      expect.anything(),
      "manage_billing"
    );
    expect(inFilter).toHaveBeenCalledWith("id", [TENANT]);
    expect(getSubscription).toHaveBeenCalledWith(TENANT);
  });

  it("redirects authenticated users to Stripe billing portal", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    const response = await POST();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://billing.stripe.com/session/mock");
    expect(createCustomerPortalSession).toHaveBeenCalledWith({
      customerId: "cus_123",
      returnUrl: "http://localhost:3000/dashboard/settings"
    });
  });
});
