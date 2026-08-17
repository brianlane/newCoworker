import { describe, expect, it } from "vitest";
import {
  decideRetag,
  describeProof,
  PROOF_WINDOW_MS,
  type BookingRow,
  type CandidateContact
} from "../scripts/oneshot/backfill-booking-page-channel";

/**
 * The backfill retags contacts the booking page filed as `webchat` before it
 * had a channel of its own. The rule under test is the one that keeps it
 * honest: the "Booking Page" tag proves ORIGIN, not the LAST touch, so a row
 * only moves when its last interaction lines up with an actual booking. A
 * visitor who booked and later really used the chat widget is correctly
 * `webchat` and must survive the sweep untouched.
 */

const PHONE = "+12187702372";
const BOOKED_AT = "2026-08-03T21:46:46.721Z";

const contact = (over: Partial<CandidateContact> = {}): CandidateContact => ({
  business_id: "biz-1",
  customer_e164: PHONE,
  display_name: "Brett Douglas",
  last_channel: "webchat",
  // The real gap observed on the contact that prompted this: 3.3 seconds.
  last_interaction_at: "2026-08-03T21:46:50.043Z",
  // Touched since creation by default, so the ledger proof is what is
  // under test unless a case opts into the creation proof.
  created_at: "2026-08-01T00:00:00.000Z",
  total_interaction_count: 3,
  ...over
});

const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  attendee_key: `phone:${PHONE}`,
  booking_source: "booking_page",
  created_at: BOOKED_AT,
  ...over
});

describe("decideRetag", () => {
  it("retags when the last interaction is the booking write itself", () => {
    expect(decideRetag(contact(), [booking()])).toEqual({
      retag: true,
      proof: "ledger",
      bookingAt: BOOKED_AT
    });
  });

  it("accepts a contact rollup that landed BEFORE its booking row", () => {
    // Live case +12092520704: the contact write beat the ledger row by 41
    // seconds. A one-directional window rejected it even though the
    // booking-page row was sitting right there, so the window is symmetric.
    const decision = decideRetag(
      contact({ last_interaction_at: "2026-08-13T13:43:29.201Z" }),
      [booking({ created_at: "2026-08-13T13:44:10.780Z" })]
    );
    expect(decision).toMatchObject({ retag: true, proof: "ledger" });
  });

  it("leaves a contact who chatted AFTER booking on webchat", () => {
    // Two days later: a real widget conversation moved last_channel, and the
    // never-expiring tag must not drag it back.
    const decision = decideRetag(
      contact({ last_interaction_at: "2026-08-05T18:00:00.000Z" }),
      [booking()]
    );
    expect(decision.retag).toBe(false);
    expect(decision).toMatchObject({
      reason: expect.stringContaining("later touch on another channel")
    });
  });

  it("accepts a gap at either window edge and rejects one past it", () => {
    const bookedMs = Date.parse(BOOKED_AT);
    const afterEdge = new Date(bookedMs + PROOF_WINDOW_MS).toISOString();
    const beforeEdge = new Date(bookedMs - PROOF_WINDOW_MS).toISOString();
    const pastAfter = new Date(bookedMs + PROOF_WINDOW_MS + 1).toISOString();
    const pastBefore = new Date(bookedMs - PROOF_WINDOW_MS - 1).toISOString();
    expect(decideRetag(contact({ last_interaction_at: afterEdge }), [booking()]).retag).toBe(true);
    expect(decideRetag(contact({ last_interaction_at: beforeEdge }), [booking()]).retag).toBe(true);
    expect(decideRetag(contact({ last_interaction_at: pastAfter }), [booking()]).retag).toBe(false);
    expect(decideRetag(contact({ last_interaction_at: pastBefore }), [booking()]).retag).toBe(false);
  });

  describe("creation proof (no ledger row to lean on)", () => {
    // Live cases +15550100000 and +16026866672: one interaction, never
    // touched since, and no booking_source='booking_page' row anywhere,
    // because the oldest bookings predate that column being stamped.
    const untouched = (over: Partial<CandidateContact> = {}) =>
      contact({
        total_interaction_count: 1,
        created_at: "2026-07-25T06:02:04.757Z",
        last_interaction_at: "2026-07-25T06:02:04.757Z",
        ...over
      });

    it("retags a single-interaction row untouched since creation", () => {
      expect(decideRetag(untouched(), [])).toEqual({
        retag: true,
        proof: "untouched-since-creation"
      });
    });

    it("refuses once the row has been touched after creation", () => {
      // Live case +16025551234: created 15:50:24, last touched 15:54:40,
      // two interactions, no bookings. Genuinely ambiguous, stays webchat.
      const decision = decideRetag(
        untouched({
          total_interaction_count: 2,
          last_interaction_at: "2026-07-25T06:05:00.000Z"
        }),
        []
      );
      expect(decision.retag).toBe(false);
    });

    it("refuses on a second interaction even at the same timestamp", () => {
      expect(decideRetag(untouched({ total_interaction_count: 2 }), []).retag).toBe(false);
    });

    it("refuses when created_at is missing", () => {
      expect(decideRetag(untouched({ created_at: null }), []).retag).toBe(false);
    });

    it("prefers the ledger proof when both would apply", () => {
      const decision = decideRetag(untouched({ last_interaction_at: BOOKED_AT }), [booking()]);
      expect(decision).toMatchObject({ proof: "ledger" });
    });
  });

  describe("describeProof", () => {
    it("names the evidence behind each retag", () => {
      expect(describeProof({ retag: true, proof: "ledger", bookingAt: BOOKED_AT })).toBe(
        `booked ${BOOKED_AT}`
      );
      expect(describeProof({ retag: true, proof: "untouched-since-creation" })).toBe(
        "only interaction, untouched since creation"
      );
    });
  });

  it("picks the closest booking when several are in range", () => {
    const closer = new Date(Date.parse("2026-08-03T21:46:50.043Z") - 1000).toISOString();
    const decision = decideRetag(contact(), [
      booking(),
      booking({ created_at: closer })
    ]);
    expect(decision).toEqual({ retag: true, proof: "ledger", bookingAt: closer });
  });

  it("ignores bookings belonging to a different attendee", () => {
    const decision = decideRetag(contact(), [booking({ attendee_key: "phone:+15550001111" })]);
    expect(decision.retag).toBe(false);
  });

  it("ignores bookings made through another surface", () => {
    // A voice or dashboard booking is not evidence the booking PAGE was the
    // last touch, so it must not license the retag.
    expect(decideRetag(contact(), [booking({ booking_source: "voice" })]).retag).toBe(false);
    expect(decideRetag(contact(), [booking({ booking_source: null })]).retag).toBe(false);
  });

  it("skips a contact with no interaction timestamp", () => {
    const decision = decideRetag(contact({ last_interaction_at: null }), [booking()]);
    expect(decision).toEqual({
      retag: false,
      reason: "contact has no last_interaction_at"
    });
  });

  it("skips rather than throws on an unparseable timestamp", () => {
    const decision = decideRetag(contact({ last_interaction_at: "not-a-date" }), [booking()]);
    expect(decision.retag).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining("unparseable") });
  });

  it("ignores a booking row with an unparseable created_at", () => {
    expect(decideRetag(contact(), [booking({ created_at: "nonsense" })]).retag).toBe(false);
  });

  it("skips when the tenant has no bookings at all", () => {
    expect(decideRetag(contact(), []).retag).toBe(false);
  });
});
