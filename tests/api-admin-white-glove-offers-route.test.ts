import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/white-glove-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/white-glove-offers")>();
  return {
    ...actual,
    createWhiteGloveOffer: vi.fn(),
    listWhiteGloveOffers: vi.fn(),
    revokeWhiteGloveOffer: vi.fn()
  };
});

import { POST, GET, DELETE } from "@/app/api/admin/white-glove-offers/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  createWhiteGloveOffer,
  listWhiteGloveOffers,
  revokeWhiteGloveOffer
} from "@/lib/db/white-glove-offers";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/admin/white-glove-offers", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/white-glove-offers route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "Corp",
      owner_email: "o@o.com",
      tier: "standard",
      status: "online",
      hostinger_vps_id: null,
      created_at: "2026-01-01T00:00:00Z"
    });
  });

  it("POST creates an offer with the amount converted to cents and the admin as author", async () => {
    vi.mocked(createWhiteGloveOffer).mockResolvedValue({ id: OFFER_ID } as never);
    const res = await POST(
      jsonRequest("POST", {
        businessId: BIZ_ID,
        name: "White-glove migration",
        description: "Full migration",
        amountUsd: 1250
      })
    );
    expect(res.status).toBe(200);
    expect(createWhiteGloveOffer).toHaveBeenCalledWith({
      businessId: BIZ_ID,
      name: "White-glove migration",
      description: "Full migration",
      amountCents: 125_000,
      createdBy: "admin@example.com"
    });
  });

  it("POST defaults description to empty and rejects out-of-bounds amounts", async () => {
    vi.mocked(createWhiteGloveOffer).mockResolvedValue({ id: OFFER_ID } as never);
    const ok = await POST(
      jsonRequest("POST", { businessId: BIZ_ID, name: "Deal", amountUsd: 1 })
    );
    expect(ok.status).toBe(200);
    expect(createWhiteGloveOffer).toHaveBeenCalledWith(
      expect.objectContaining({ description: "", amountCents: 100 })
    );

    for (const amountUsd of [0.5, 50_001, -3]) {
      const res = await POST(jsonRequest("POST", { businessId: BIZ_ID, name: "Deal", amountUsd }));
      expect(res.status).toBe(400);
    }
  });

  it("POST 404s for an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ_ID, name: "Deal", amountUsd: 100 })
    );
    expect(res.status).toBe(404);
    expect(createWhiteGloveOffer).not.toHaveBeenCalled();
  });

  it("POST falls back to the admin userId when the email is missing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ userId: "admin-1", email: null } as never);
    vi.mocked(createWhiteGloveOffer).mockResolvedValue({ id: OFFER_ID } as never);
    const res = await POST(
      jsonRequest("POST", { businessId: BIZ_ID, name: "Deal", amountUsd: 100 })
    );
    expect(res.status).toBe(200);
    expect(createWhiteGloveOffer).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: "admin-1" })
    );
  });

  it("GET lists a business's offers and validates the businessId", async () => {
    vi.mocked(listWhiteGloveOffers).mockResolvedValue([{ id: OFFER_ID } as never]);
    const ok = await GET(
      new Request(`http://localhost/api/admin/white-glove-offers?businessId=${BIZ_ID}`)
    );
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.data.offers).toHaveLength(1);

    const bad = await GET(
      new Request("http://localhost/api/admin/white-glove-offers?businessId=nope")
    );
    expect(bad.status).toBe(400);
  });

  it("DELETE revokes an open offer and 409s when it isn't open", async () => {
    vi.mocked(revokeWhiteGloveOffer).mockResolvedValue(true);
    const ok = await DELETE(jsonRequest("DELETE", { offerId: OFFER_ID }));
    expect(ok.status).toBe(200);

    vi.mocked(revokeWhiteGloveOffer).mockResolvedValue(false);
    const conflict = await DELETE(jsonRequest("DELETE", { offerId: OFFER_ID }));
    const body = await conflict.json();
    expect(conflict.status).toBe(409);
    expect(body.error.message).toContain("not open");
  });

  it("rejects invalid bodies with 400", async () => {
    expect((await POST(jsonRequest("POST", { businessId: "nope" }))).status).toBe(400);
    expect((await DELETE(jsonRequest("DELETE", { offerId: "nope" }))).status).toBe(400);
  });

  it("propagates admin auth failures", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Admin access required"));
    const res = await GET(
      new Request(`http://localhost/api/admin/white-glove-offers?businessId=${BIZ_ID}`)
    );
    expect(res.status).toBe(500);
  });
});
