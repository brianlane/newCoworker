import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createWhiteGloveOffer,
  listWhiteGloveOffers,
  getWhiteGloveOffer,
  revokeWhiteGloveOffer,
  markWhiteGloveOfferPaid,
  extendPrioritySupport
} from "@/lib/db/white-glove-offers";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const OFFER = {
  id: "0f0f0f0f-0000-4000-8000-000000000001",
  business_id: "0f0f0f0f-0000-4000-8000-0000000000bb",
  name: "White-glove migration",
  description: "Full migration",
  amount_cents: 125_000,
  status: "open",
  created_by: "admin@test.com",
  created_at: "2026-07-01T00:00:00Z",
  paid_at: null,
  stripe_session_id: null
};

describe("db/white-glove-offers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createWhiteGloveOffer inserts and returns the row", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: OFFER, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const row = await createWhiteGloveOffer({
      businessId: OFFER.business_id,
      name: OFFER.name,
      description: OFFER.description,
      amountCents: OFFER.amount_cents,
      createdBy: OFFER.created_by
    });
    expect(row).toEqual(OFFER);
    expect(db.insert).toHaveBeenCalledWith({
      business_id: OFFER.business_id,
      name: OFFER.name,
      description: OFFER.description,
      amount_cents: OFFER.amount_cents,
      created_by: OFFER.created_by
    });
  });

  it("createWhiteGloveOffer throws on error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      createWhiteGloveOffer({
        businessId: OFFER.business_id,
        name: OFFER.name,
        description: "",
        amountCents: 100,
        createdBy: "a@b.c"
      })
    ).rejects.toThrow("createWhiteGloveOffer: boom");
  });

  it("listWhiteGloveOffers returns rows newest-first (and [] for null data)", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [OFFER], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listWhiteGloveOffers(OFFER.business_id)).toEqual([OFFER]);

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    expect(await listWhiteGloveOffers(OFFER.business_id)).toEqual([]);
  });

  it("listWhiteGloveOffers throws on error", async () => {
    const db = mockDb({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listWhiteGloveOffers(OFFER.business_id)).rejects.toThrow(
      "listWhiteGloveOffers: boom"
    );
  });

  it("getWhiteGloveOffer returns the row or null", async () => {
    const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: OFFER, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getWhiteGloveOffer(OFFER.id)).toEqual(OFFER);

    const missing = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(missing as never);
    expect(await getWhiteGloveOffer(OFFER.id)).toBeNull();
  });

  it("getWhiteGloveOffer throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getWhiteGloveOffer(OFFER.id)).rejects.toThrow("getWhiteGloveOffer: boom");
  });

  it("revokeWhiteGloveOffer flips only OPEN rows and reports whether one flipped", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: OFFER.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await revokeWhiteGloveOffer(OFFER.id)).toBe(true);
    expect(db.update).toHaveBeenCalledWith({ status: "revoked" });
    expect(db.eq).toHaveBeenCalledWith("status", "open");

    const none = mockDb({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
    expect(await revokeWhiteGloveOffer(OFFER.id)).toBe(false);

    const nullData = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(nullData as never);
    expect(await revokeWhiteGloveOffer(OFFER.id)).toBe(false);
  });

  it("revokeWhiteGloveOffer throws on error", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(revokeWhiteGloveOffer(OFFER.id)).rejects.toThrow("revokeWhiteGloveOffer: boom");
  });

  it("markWhiteGloveOfferPaid stamps status/paid_at/session and reports a match", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: OFFER.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const matched = await markWhiteGloveOfferPaid(OFFER.id, {
      paidAt: new Date("2026-07-04T12:00:00Z"),
      stripeSessionId: "cs_123"
    });
    expect(matched).toBe(true);
    expect(db.update).toHaveBeenCalledWith({
      status: "paid",
      paid_at: "2026-07-04T12:00:00.000Z",
      stripe_session_id: "cs_123"
    });

    const none = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
    expect(
      await markWhiteGloveOfferPaid(OFFER.id, { paidAt: new Date(), stripeSessionId: "cs_1" })
    ).toBe(false);
  });

  it("markWhiteGloveOfferPaid throws on error", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      markWhiteGloveOfferPaid(OFFER.id, { paidAt: new Date(), stripeSessionId: "cs_1" })
    ).rejects.toThrow("markWhiteGloveOfferPaid: boom");
  });

  describe("extendPrioritySupport", () => {
    const UNTIL = new Date("2026-08-05T00:00:00Z");

    function dbWithCurrentWindow(current: string | null) {
      // First call chain reads businesses.priority_support_until; the second
      // performs the update. eq() resolves the update terminal.
      const updateEq = vi.fn().mockResolvedValue({ error: null });
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: { priority_support_until: current }, error: null }),
        update: vi.fn().mockReturnValue({ eq: updateEq }),
        eq: vi.fn().mockReturnThis()
      };
      return { db, updateEq };
    }

    it("opens the window when none is set", async () => {
      const { db } = dbWithCurrentWindow(null);
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await extendPrioritySupport("biz-1", UNTIL);
      expect(db.update).toHaveBeenCalledWith({
        priority_support_until: UNTIL.toISOString()
      });
    });

    it("extends a shorter window but never shortens a longer one", async () => {
      const shorter = dbWithCurrentWindow("2026-07-10T00:00:00Z");
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(shorter.db as never);
      await extendPrioritySupport("biz-1", UNTIL);
      expect(shorter.db.update).toHaveBeenCalled();

      const longer = dbWithCurrentWindow("2026-09-01T00:00:00Z");
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(longer.db as never);
      await extendPrioritySupport("biz-1", UNTIL);
      expect(longer.db.update).not.toHaveBeenCalled();
    });

    it("throws on read and write errors", async () => {
      const readErr = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "read-boom" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(readErr as never);
      await expect(extendPrioritySupport("biz-1", UNTIL)).rejects.toThrow(
        "extendPrioritySupport read: read-boom"
      );

      const { db } = dbWithCurrentWindow(null);
      db.update = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: "write-boom" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(extendPrioritySupport("biz-1", UNTIL)).rejects.toThrow(
        "extendPrioritySupport: write-boom"
      );
    });

    it("treats a missing business row as no current window", async () => {
      const noRow = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(noRow as never);
      await extendPrioritySupport("biz-1", UNTIL);
      expect(noRow.update).toHaveBeenCalled();
    });
  });
});
