import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/enterprise-deals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/enterprise-deals")>();
  return {
    ...actual,
    createEnterpriseDeal: vi.fn(),
    listEnterpriseDeals: vi.fn(),
    revokeEnterpriseDeal: vi.fn()
  };
});

import { POST, GET, DELETE } from "@/app/api/admin/enterprise-deals/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  createEnterpriseDeal,
  listEnterpriseDeals,
  revokeEnterpriseDeal
} from "@/lib/db/enterprise-deals";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";

const DEAL = {
  id: DEAL_ID,
  business_id: BIZ_ID,
  setup_cents: 82_500,
  monthly_cents: 49_500,
  status: "open" as const,
  created_by: "admin@example.com",
  created_at: "2026-07-08T00:00:00Z",
  activated_at: null,
  stripe_session_id: null,
  stripe_subscription_id: null,
  pay_token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
};

function enterpriseBusiness(tier = "enterprise") {
  return {
    id: BIZ_ID,
    name: "Corp",
    owner_email: "o@o.com",
    tier,
    status: "online",
    hostinger_vps_id: null,
    created_at: "2026-01-01T00:00:00Z"
  };
}

describe("api/admin/enterprise-deals route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
  });

  it("creates a deal for an enterprise business (USD → cents) and returns the pay link", async () => {
    vi.mocked(getBusiness).mockResolvedValue(enterpriseBusiness() as never);
    vi.mocked(createEnterpriseDeal).mockResolvedValue(DEAL as never);

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, setupUsd: 825, monthlyUsd: 495 })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createEnterpriseDeal).toHaveBeenCalledWith({
      businessId: BIZ_ID,
      setupCents: 82_500,
      monthlyCents: 49_500,
      createdBy: "admin@example.com"
    });
    expect(body.data.payUrl).toContain(`/enterprise-offer/${DEAL.pay_token}`);
  });

  it("rejects non-enterprise businesses", async () => {
    vi.mocked(getBusiness).mockResolvedValue(enterpriseBusiness("standard") as never);

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, setupUsd: 0, monthlyUsd: 495 })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(createEnterpriseDeal).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, setupUsd: 0, monthlyUsd: 495 })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("maps the one-live-deal unique violation to CONFLICT", async () => {
    vi.mocked(getBusiness).mockResolvedValue(enterpriseBusiness() as never);
    vi.mocked(createEnterpriseDeal).mockRejectedValue(
      new Error(
        'createEnterpriseDeal: duplicate key value violates unique constraint "enterprise_deals_one_live_per_business_idx"'
      )
    );

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, setupUsd: 0, monthlyUsd: 495 })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("validates the monthly price (must be at least $1)", async () => {
    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, setupUsd: 0, monthlyUsd: 0.5 })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(getBusiness).not.toHaveBeenCalled();
  });

  it("GET lists deals with pay links", async () => {
    vi.mocked(listEnterpriseDeals).mockResolvedValue([DEAL] as never);

    const response = await GET(
      new Request(`http://localhost/api/admin/enterprise-deals?businessId=${BIZ_ID}`)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.deals).toHaveLength(1);
    expect(body.data.deals[0].payUrl).toContain(`/enterprise-offer/${DEAL.pay_token}`);
  });

  it("GET rejects a non-UUID businessId", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/enterprise-deals?businessId=nope")
    );
    expect(response.status).toBe(400);
    expect(listEnterpriseDeals).not.toHaveBeenCalled();
  });

  it("DELETE revokes an open deal and 409s otherwise", async () => {
    vi.mocked(revokeEnterpriseDeal).mockResolvedValue(true);
    const ok = await DELETE(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: DEAL_ID })
      })
    );
    expect(ok.status).toBe(200);
    expect(revokeEnterpriseDeal).toHaveBeenCalledWith(DEAL_ID);

    vi.mocked(revokeEnterpriseDeal).mockResolvedValue(false);
    const conflict = await DELETE(
      new Request("http://localhost/api/admin/enterprise-deals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: DEAL_ID })
      })
    );
    const body = await conflict.json();
    expect(conflict.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });
});
