import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireBusinessRole: vi.fn(),
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/deals/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/deals/db")>();
  return {
    DealError: actual.DealError,
    listDealsWithContacts: vi.fn(),
    createDeal: vi.fn(),
    updateDeal: vi.fn(),
    deleteDeal: vi.fn()
  };
});

import { GET, POST } from "@/app/api/dashboard/deals/route";
import { PATCH, DELETE } from "@/app/api/dashboard/deals/[dealId]/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  DealError,
  createDeal,
  deleteDeal,
  listDealsWithContacts,
  updateDeal
} from "@/lib/deals/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";

const USER = { userId: "u-1", email: "owner@example.com", isAdmin: false };

const DEAL = {
  id: DEAL_ID,
  businessId: BIZ,
  contactId: null,
  title: "Roof job",
  valueCents: 100000,
  currency: "USD",
  commissionBps: null,
  expectedCloseDate: null,
  status: "open",
  wonAt: null,
  lostAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  contactE164: null,
  contactName: null
};

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/dashboard/deals?businessId=${BIZ}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

function patch(body: unknown, dealId = DEAL_ID) {
  return PATCH(
    new Request(`http://localhost/api/dashboard/deals/${dealId}?businessId=${BIZ}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ dealId }) }
  );
}

describe("api/dashboard/deals routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(USER as never);
    vi.mocked(listDealsWithContacts).mockResolvedValue([DEAL] as never);
    vi.mocked(createDeal).mockResolvedValue(DEAL as never);
    vi.mocked(updateDeal).mockResolvedValue(DEAL as never);
    vi.mocked(deleteDeal).mockResolvedValue(undefined as never);
  });

  it("GET lists deals behind view_dashboard", async () => {
    const res = await GET(new Request(`http://localhost/api/dashboard/deals?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.deals).toHaveLength(1);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");
  });

  it("GET validates the query and requires auth", async () => {
    const invalid = await GET(new Request("http://localhost/api/dashboard/deals?businessId=x"));
    expect(invalid.status).toBe(400);

    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const anon = await GET(new Request(`http://localhost/api/dashboard/deals?businessId=${BIZ}`));
    expect(anon.status).toBe(401);
  });

  it("POST creates a deal behind manage_settings and stamps the creator", async () => {
    const res = await post({ title: "Roof job", valueCents: 100000 });
    expect(res.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(createDeal).toHaveBeenCalledWith(
      BIZ,
      { title: "Roof job", valueCents: 100000 },
      "u-1"
    );
  });

  it("POST validates the body and maps typed lib failures", async () => {
    const invalid = await post({ title: "" });
    expect(invalid.status).toBe(400);
    expect(createDeal).not.toHaveBeenCalled();

    vi.mocked(createDeal).mockRejectedValue(new DealError("invalid", "bad contact"));
    const badContact = await post({ title: "ok" });
    expect(badContact.status).toBe(400);

    vi.mocked(createDeal).mockRejectedValue(new Error("boom"));
    const boom = await post({ title: "ok" });
    expect(boom.status).toBe(500);
  });

  it("PATCH updates a deal and maps not_found / transition errors", async () => {
    const ok = await patch({ status: "won" });
    expect(ok.status).toBe(200);
    expect(updateDeal).toHaveBeenCalledWith(BIZ, DEAL_ID, { status: "won" });
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");

    vi.mocked(updateDeal).mockRejectedValue(new DealError("not_found", "gone"));
    expect((await patch({ status: "won" })).status).toBe(404);

    vi.mocked(updateDeal).mockRejectedValue(new DealError("transition", "reopen first"));
    expect((await patch({ status: "lost" })).status).toBe(409);

    const empty = await patch({});
    expect(empty.status).toBe(400);

    const badId = await patch({ status: "won" }, "not-a-uuid");
    expect(badId.status).toBe(400);
  });

  it("DELETE removes a deal and maps not_found", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/dashboard/deals/${DEAL_ID}?businessId=${BIZ}`, {
        method: "DELETE"
      }),
      { params: Promise.resolve({ dealId: DEAL_ID }) }
    );
    expect(res.status).toBe(200);
    expect(deleteDeal).toHaveBeenCalledWith(BIZ, DEAL_ID);

    vi.mocked(deleteDeal).mockRejectedValue(new DealError("not_found", "gone"));
    const missing = await DELETE(
      new Request(`http://localhost/api/dashboard/deals/${DEAL_ID}?businessId=${BIZ}`, {
        method: "DELETE"
      }),
      { params: Promise.resolve({ dealId: DEAL_ID }) }
    );
    expect(missing.status).toBe(404);
  });

  it("admins skip the business-role check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...USER, isAdmin: true } as never);
    const res = await GET(new Request(`http://localhost/api/dashboard/deals?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});
