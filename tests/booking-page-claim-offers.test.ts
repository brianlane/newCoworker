/**
 * Broadcast booking claims, Node side (src/lib/booking-page/claim-offers.ts):
 * the claim row is written BEFORE any invite (a "1" must always have a row
 * to land on), every send is per-recipient best-effort, and the dedupe-row
 * lookup never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(async () => ({ apiKey: "k" })),
  sendTelnyxSms: vi.fn(async () => ({}))
}));
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  BOOKING_CLAIM_WINDOW_MS,
  broadcastBookingClaim,
  findDedupeRowId
} from "@/lib/booking-page/claim-offers";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";
import type { TeamMemberRow } from "@/lib/db/employees";

const BIZ = "11111111-1111-4111-8111-111111111111";

const member = (over: Partial<TeamMemberRow> = {}): TeamMemberRow =>
  ({
    id: "m-1",
    name: "Ana",
    phone_e164: "+14805550111",
    active: true,
    ...over
  }) as TeamMemberRow;

const NOTICE = {
  visitorName: "Pat Visitor",
  visitorPhone: "+14805550100",
  startLocal: "Monday, January 5 at 9:00 AM",
  summary: "Strategy call"
};

type InsertResult = { error: { message: string } | null };
function makeDb(insertResult: InsertResult = { error: null }) {
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    from: vi.fn((table: string) => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserts.push({ table, ...row });
        return insertResult;
      }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: "row-9" }, error: null })
            })
          })
        })
      })
    }))
  };
  return { db: db as never, inserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: true, optedOut: false } as never);
  vi.mocked(sendTelnyxSms).mockResolvedValue({} as never);
});

describe("broadcastBookingClaim", () => {
  it("writes the row first, then texts each invitee, and reports who was texted", async () => {
    const { db, inserts } = makeDb();
    const texted = await broadcastBookingClaim(
      BIZ,
      "dedupe-1",
      [member(), member({ id: "m-2", phone_e164: "+14805550112" })],
      NOTICE,
      db
    );
    expect(texted).toEqual(["+14805550111", "+14805550112"]);
    expect(inserts[0]).toMatchObject({
      table: "booking_claim_offers",
      business_id: BIZ,
      dedupe_claim_id: "dedupe-1",
      recipients: ["+14805550111", "+14805550112"],
      attendee_name: "Pat Visitor"
    });
    const expiresMs = Date.parse(String(inserts[0].expires_at));
    expect(expiresMs - Date.now()).toBeGreaterThan(BOOKING_CLAIM_WINDOW_MS - 60_000);
    const bodies = vi.mocked(sendTelnyxSms).mock.calls.map((c) => String(c[2]));
    expect(bodies[0]).toContain("Reply 1 to take it.");
    expect(bodies[0]).toContain("Pat Visitor");
    expect(bodies[0]).not.toContain("—");
  });

  it("a failed row write sends NO invites: a 1 with nowhere to land is the alerts bug", async () => {
    const { db } = makeDb({ error: { message: "denied" } });
    const texted = await broadcastBookingClaim(BIZ, "dedupe-1", [member()], NOTICE, db);
    expect(texted).toEqual([]);
    expect(sendTelnyxSms).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-claim: offer row write failed (no invites sent)",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("an opted-out teammate is skipped; a dead number does not cost the others", async () => {
    const { db } = makeDb();
    vi.mocked(checkSmsOptOut)
      .mockResolvedValueOnce({ ok: true, optedOut: true } as never)
      .mockResolvedValue({ ok: true, optedOut: false } as never);
    vi.mocked(sendTelnyxSms)
      .mockRejectedValueOnce(new Error("40310 invalid destination"))
      .mockResolvedValue({} as never);
    const texted = await broadcastBookingClaim(
      BIZ,
      "dedupe-1",
      [
        member({ id: "m-stop", phone_e164: "+14805550110" }),
        member({ id: "m-dead", phone_e164: "+14805550113" }),
        member({ id: "m-ok", phone_e164: "+14805550114" })
      ],
      NOTICE,
      db
    );
    expect(texted).toEqual(["+14805550114"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-claim: invite text failed (booking unaffected)",
      expect.objectContaining({ memberId: "m-dead" })
    );
  });

  it("no textable recipients writes nothing at all", async () => {
    const { db, inserts } = makeDb();
    const texted = await broadcastBookingClaim(
      BIZ,
      "dedupe-1",
      [member({ phone_e164: null as never })],
      NOTICE,
      db
    );
    expect(texted).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("a phoneless visitor still reads cleanly in the invite", async () => {
    const { db } = makeDb();
    await broadcastBookingClaim(BIZ, "dedupe-1", [member()], { ...NOTICE, visitorPhone: null }, db);
    const body = String(vi.mocked(sendTelnyxSms).mock.calls[0][2]);
    expect(body).not.toContain("()");
  });

  it("never throws: a thrown client answers no invites", async () => {
    const throwing = {
      from() {
        throw new Error("connection reset");
      }
    } as never;
    await expect(broadcastBookingClaim(BIZ, "dedupe-1", [member()], NOTICE, throwing)).resolves.toEqual(
      []
    );
  });
});

describe("findDedupeRowId", () => {
  it("answers the matched row id", async () => {
    const { db } = makeDb();
    expect(await findDedupeRowId(BIZ, "phone:+14805550100", "2026-01-05T16:00:00.000Z", db)).toBe(
      "row-9"
    );
  });

  it("answers null on a read error, and never throws", async () => {
    const erroring = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) })
            })
          })
        })
      })
    } as never;
    expect(await findDedupeRowId(BIZ, "k", "s", erroring)).toBeNull();
    const throwing = {
      from() {
        throw new Error("reset");
      }
    } as never;
    expect(await findDedupeRowId(BIZ, "k", "s", throwing)).toBeNull();
  });
});

describe("default client construction", () => {
  it("both entry points build their own client when none is passed", async () => {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const { db } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      broadcastBookingClaim(BIZ, "dedupe-1", [member()], NOTICE)
    ).resolves.toEqual(["+14805550111"]);
    await expect(findDedupeRowId(BIZ, "k", "s")).resolves.toBe("row-9");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(2);
  });
});

describe("non-Error failure shapes", () => {
  it("logs a string rejection from an invite send as a string", async () => {
    const { db } = makeDb();
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce("telnyx sad");
    const texted = await broadcastBookingClaim(BIZ, "dedupe-1", [member()], NOTICE, db);
    expect(texted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-claim: invite text failed (booking unaffected)",
      expect.objectContaining({ error: "telnyx sad" })
    );
  });

  it("a client throwing a bare string still degrades cleanly in both entry points", async () => {
    const throwingString = {
      from() {
        // deno-style code can throw non-Errors; the warn path must not.
        throw "reset";
      }
    } as never;
    expect(await broadcastBookingClaim(BIZ, "d", [member()], NOTICE, throwingString)).toEqual([]);
    expect(await findDedupeRowId(BIZ, "k", "s", throwingString)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-claim: broadcast failed (booking unaffected)",
      expect.objectContaining({ error: "reset" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "booking-claim: dedupe row lookup threw",
      expect.objectContaining({ error: "reset" })
    );
  });
});

describe("mixed rosters and empty lookups", () => {
  it("a phoneless member inside a real invite list is skipped, not fatal", async () => {
    const { db, inserts } = makeDb();
    const texted = await broadcastBookingClaim(
      BIZ,
      "dedupe-1",
      [member({ id: "m-nophone", phone_e164: null as never }), member({ id: "m-ok" })],
      NOTICE,
      db
    );
    expect(texted).toEqual(["+14805550111"]);
    // The row records only textable recipients.
    expect(inserts[0]).toMatchObject({ recipients: ["+14805550111"] });
  });

  it("a dedupe lookup that matches nothing answers null", async () => {
    const empty = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
          })
        })
      })
    } as never;
    expect(await findDedupeRowId(BIZ, "k", "s", empty)).toBeNull();
  });
});

describe("opt-out lookup failure", () => {
  it("an unreadable opt-out state skips that member (fail closed on texting)", async () => {
    const { db } = makeDb();
    vi.mocked(checkSmsOptOut)
      .mockResolvedValueOnce({ ok: false } as never)
      .mockResolvedValue({ ok: true, optedOut: false } as never);
    const texted = await broadcastBookingClaim(
      BIZ,
      "dedupe-1",
      [member({ id: "m-unknown", phone_e164: "+14805550115" }), member({ id: "m-ok" })],
      NOTICE,
      db
    );
    expect(texted).toEqual(["+14805550111"]);
  });
});
