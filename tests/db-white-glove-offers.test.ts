import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createWhiteGloveOffer,
  listWhiteGloveOffers,
  listProspectWhiteGloveOffers,
  getWhiteGloveOffer,
  getWhiteGloveOfferByPayToken,
  whiteGloveOfferPayUrl,
  revokeWhiteGloveOffer,
  markWhiteGloveOfferPaid,
  extendPrioritySupport,
  attachProspectWhiteGloveOffersToBusiness,
  attachPaidProspectOfferToBusinessByEmail
} from "@/lib/db/white-glove-offers";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
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
      created_by: OFFER.created_by,
      recipient_email: null
    });
  });

  it("createWhiteGloveOffer supports PROSPECT offers (null business + recipient email)", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: OFFER, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await createWhiteGloveOffer({
      businessId: null,
      name: OFFER.name,
      description: "",
      amountCents: 100,
      createdBy: "admin@test.com",
      recipientEmail: "prospect@example.com"
    });
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: null, recipient_email: "prospect@example.com" })
    );
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

  it("listProspectWhiteGloveOffers filters to business_id IS NULL (and [] for null data)", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [OFFER], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listProspectWhiteGloveOffers()).toEqual([OFFER]);
    expect(db.is).toHaveBeenCalledWith("business_id", null);

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    expect(await listProspectWhiteGloveOffers()).toEqual([]);

    const err = mockDb({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
    await expect(listProspectWhiteGloveOffers()).rejects.toThrow(
      "listProspectWhiteGloveOffers: boom"
    );
  });

  it("getWhiteGloveOfferByPayToken resolves the pay link's offer (row, null, error)", async () => {
    const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: OFFER, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getWhiteGloveOfferByPayToken("tok-1")).toEqual(OFFER);
    expect(db.eq).toHaveBeenCalledWith("pay_token", "tok-1");

    const missing = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(missing as never);
    expect(await getWhiteGloveOfferByPayToken("tok-1")).toBeNull();

    const err = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
    await expect(getWhiteGloveOfferByPayToken("tok-1")).rejects.toThrow(
      "getWhiteGloveOfferByPayToken: boom"
    );
  });

  it("whiteGloveOfferPayUrl builds the durable link from the app URL (set and unset)", () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com/";
      expect(whiteGloveOfferPayUrl({ pay_token: "tok-abc" })).toBe(
        "https://www.newcoworker.com/offer/tok-abc"
      );
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(whiteGloveOfferPayUrl({ pay_token: "tok-abc" })).toBe(
        "http://localhost:3000/offer/tok-abc"
      );
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
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

  it("markWhiteGloveOfferPaid atomically claims the row (retry-safe, duplicate-session aware)", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: OFFER.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const claim = await markWhiteGloveOfferPaid(OFFER.id, {
      paidAt: new Date("2026-07-04T12:00:00Z"),
      stripeSessionId: "cs_123"
    });
    expect(claim).toBe("paid");
    expect(db.update).toHaveBeenCalledWith({
      status: "paid",
      paid_at: "2026-07-04T12:00:00.000Z",
      stripe_session_id: "cs_123"
    });
    // The claim guard: not-yet-paid OR same session (idempotent retry).
    expect(db.or).toHaveBeenCalledWith("status.neq.paid,stripe_session_id.eq.cs_123");

    // No row matched → the offer was already paid by a DIFFERENT session.
    const none = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
    expect(
      await markWhiteGloveOfferPaid(OFFER.id, { paidAt: new Date(), stripeSessionId: "cs_1" })
    ).toBe("duplicate_session");
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

  describe("attachProspectWhiteGloveOffersToBusiness", () => {
    function attachDb(rows: Array<{ id: string; status: string }>) {
      // One builder handles both statements: the attach UPDATE terminates in
      // .select(rows); the (conditional) priority-window UPDATE terminates in
      // .or({error:null}).
      return {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({ data: rows, error: null }),
        or: vi.fn().mockResolvedValue({ error: null })
      };
    }

    it("attaches by email (case-insensitive) and opens the window when a PAID offer attaches", async () => {
      const db = attachDb([
        { id: "o1", status: "paid" },
        { id: "o2", status: "open" }
      ]);
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const count = await attachProspectWhiteGloveOffersToBusiness("biz-1", "Owner@Example.com ");
      expect(count).toBe(2);
      expect(db.is).toHaveBeenCalledWith("business_id", null);
      expect(db.ilike).toHaveBeenCalledWith("recipient_email", "Owner@Example.com");
      // Paid offer present → priority window opened (monotonic .or guard).
      expect(db.or).toHaveBeenCalled();
    });

    it("attaches OPEN offers without touching the priority window", async () => {
      const db = attachDb([{ id: "o1", status: "open" }]);
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const count = await attachProspectWhiteGloveOffersToBusiness("biz-1", "p@x.com");
      expect(count).toBe(1);
      expect(db.or).not.toHaveBeenCalled();
    });

    it("returns 0 for a blank email or no matches, and throws on errors", async () => {
      expect(await attachProspectWhiteGloveOffersToBusiness("biz-1", "  ")).toBe(0);

      const none = attachDb([]);
      none.select = vi.fn().mockResolvedValue({ data: null, error: null });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
      expect(await attachProspectWhiteGloveOffersToBusiness("biz-1", "p@x.com")).toBe(0);

      const err = attachDb([]);
      err.select = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
      await expect(
        attachProspectWhiteGloveOffersToBusiness("biz-1", "p@x.com")
      ).rejects.toThrow("attachProspectWhiteGloveOffersToBusiness: boom");
    });
  });

  describe("attachPaidProspectOfferToBusinessByEmail", () => {
    function lookupDb(businessRows: Array<{ id: string } | null>) {
      // Each maybeSingle() call resolves the next candidate-email lookup; the
      // offer UPDATE terminates in .is() resolving {data,error}.
      const maybeSingle = vi.fn();
      for (const row of businessRows) {
        maybeSingle.mockResolvedValueOnce({ data: row, error: null });
      }
      return {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle,
        is: vi.fn().mockResolvedValue({ data: null, error: null })
      };
    }

    it("attaches to the newest business of the first matching email and returns its id", async () => {
      const db = lookupDb([{ id: "biz-9" }]);
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const id = await attachPaidProspectOfferToBusinessByEmail("offer-1", [
        "prospect@example.com",
        "payer@example.com"
      ]);
      expect(id).toBe("biz-9");
      expect(db.ilike).toHaveBeenCalledWith("owner_email", "prospect@example.com");
      expect(db.update).toHaveBeenCalledWith({ business_id: "biz-9" });
      // Only ever attaches while unattached — never re-homes an offer.
      expect(db.is).toHaveBeenCalledWith("business_id", null);
    });

    it("falls through blank/missing emails to the next candidate and returns null when none match", async () => {
      const db = lookupDb([null, null]);
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const id = await attachPaidProspectOfferToBusinessByEmail("offer-1", [
        "",
        null,
        undefined,
        "a@x.com",
        "b@x.com"
      ]);
      expect(id).toBeNull();
      expect(db.maybeSingle).toHaveBeenCalledTimes(2);
    });

    it("throws on lookup and update errors", async () => {
      const lookupErr = lookupDb([]);
      lookupErr.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: { message: "look-boom" }
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(lookupErr as never);
      await expect(
        attachPaidProspectOfferToBusinessByEmail("offer-1", ["a@x.com"])
      ).rejects.toThrow("attachPaidProspectOfferToBusinessByEmail: look-boom");

      const updateErr = lookupDb([{ id: "biz-9" }]);
      updateErr.is = vi.fn().mockResolvedValue({ data: null, error: { message: "up-boom" } });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(updateErr as never);
      await expect(
        attachPaidProspectOfferToBusinessByEmail("offer-1", ["a@x.com"])
      ).rejects.toThrow("attachPaidProspectOfferToBusinessByEmail: up-boom");
    });
  });

  describe("extendPrioritySupport", () => {
    const UNTIL = new Date("2026-08-05T00:00:00Z");

    it("extends monotonically in a single guarded UPDATE (null-or-shorter windows only)", async () => {
      const or = vi.fn().mockResolvedValue({ error: null });
      const db = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await extendPrioritySupport("biz-1", UNTIL);
      expect(db.update).toHaveBeenCalledWith({
        priority_support_until: UNTIL.toISOString()
      });
      // The monotonic guard lives in the WHERE clause, so concurrent webhook
      // handlers can never overwrite a longer window with a shorter one.
      expect(or).toHaveBeenCalledWith(
        `priority_support_until.is.null,priority_support_until.lt.${UNTIL.toISOString()}`
      );
    });

    it("throws on write errors", async () => {
      const db = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockResolvedValue({ error: { message: "write-boom" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(extendPrioritySupport("biz-1", UNTIL)).rejects.toThrow(
        "extendPrioritySupport: write-boom"
      );
    });
  });
});
