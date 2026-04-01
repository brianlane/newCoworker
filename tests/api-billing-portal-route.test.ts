import { beforeEach, describe, expect, it, vi } from "vitest";

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
      limit: vi.fn().mockResolvedValue({
        data: [{ id: "biz_123" }],
        error: null
      })
    } as never);
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
