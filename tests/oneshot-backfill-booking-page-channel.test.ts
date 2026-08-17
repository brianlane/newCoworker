import { describe, expect, it } from "vitest";
import {
  decideRetag,
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
      bookingAt: BOOKED_AT
    });
  });

  it("leaves a contact who chatted AFTER booking on webchat", () => {
    // Two days later: a real widget conversation moved last_channel, and the
    // never-expiring tag must not drag it back.
    const decision = decideRetag(
      contact({ last_interaction_at: "2026-08-05T18:00:00.000Z" }),
      [booking()]
    );
    expect(decision.retag).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining("does not line up") });
  });

  it("ignores a booking that lands after the contact's last interaction", () => {
    // Clock skew or an unrelated later booking: the contact write always
    // FOLLOWS the booking it came from, so a negative gap proves nothing.
    const decision = decideRetag(contact({ last_interaction_at: "2026-08-03T21:46:40.000Z" }), [
      booking()
    ]);
    expect(decision.retag).toBe(false);
  });

  it("accepts a gap at the window edge and rejects one past it", () => {
    const bookedMs = Date.parse(BOOKED_AT);
    const atEdge = new Date(bookedMs + PROOF_WINDOW_MS).toISOString();
    const pastEdge = new Date(bookedMs + PROOF_WINDOW_MS + 1).toISOString();
    expect(decideRetag(contact({ last_interaction_at: atEdge }), [booking()]).retag).toBe(true);
    expect(decideRetag(contact({ last_interaction_at: pastEdge }), [booking()]).retag).toBe(false);
  });

  it("picks the closest booking when several are in range", () => {
    const closer = new Date(Date.parse("2026-08-03T21:46:50.043Z") - 1000).toISOString();
    const decision = decideRetag(contact(), [
      booking(),
      booking({ created_at: closer })
    ]);
    expect(decision).toEqual({ retag: true, bookingAt: closer });
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
