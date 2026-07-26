/**
 * The booking confirmation / reminder email: both clocks, the links a bare
 * calendar invite cannot carry, and the copy split between the two kinds.
 */
import { describe, expect, it } from "vitest";

import {
  bookingTimeLabel,
  buildBookingConfirmationEmail
} from "@/lib/email/templates/booking-confirmation";

const BASE = {
  businessName: "New Coworker",
  startIso: "2026-07-27T16:00:00.000Z",
  durationMinutes: 30,
  businessTimeZone: "America/Phoenix",
  recipientEmail: "liz@example.com",
  siteUrl: "https://www.newcoworker.com/"
} as const;

describe("bookingTimeLabel", () => {
  it("names the zone (a bare clock time is how people miss calls)", () => {
    expect(bookingTimeLabel(BASE.startIso, "America/Phoenix", "en")).toContain("9:00 AM");
    expect(bookingTimeLabel(BASE.startIso, "America/Phoenix", "en")).toMatch(/MST/);
    expect(bookingTimeLabel(BASE.startIso, "America/New_York", "en")).toContain("12:00 PM");
  });

  it("falls back to the raw instant on an unusable zone", () => {
    expect(bookingTimeLabel(BASE.startIso, "Not/AZone", "en")).toBe(BASE.startIso);
  });
});

describe("buildBookingConfirmationEmail", () => {
  it("shows BOTH clocks when the visitor is in another zone", () => {
    const mail = buildBookingConfirmationEmail({
      ...BASE,
      kind: "confirmation",
      visitorTimeZone: "America/New_York",
      joinUrl: "https://zoom.example.com/j/1?pwd=x",
      manageUrl: "https://www.newcoworker.com/book/manage/ncbm_abc"
    });
    expect(mail.subject).toBe("You are booked with New Coworker");
    expect(mail.text).toContain("12:00 PM");
    expect(mail.text).toContain("9:00 AM");
    expect(mail.text).toContain("30 minutes");
    expect(mail.text).toContain("https://zoom.example.com/j/1?pwd=x");
    expect(mail.text).toContain("/book/manage/ncbm_abc");
    // The join link is the most useful button on a booking with a call.
    expect(mail.html).toContain("Join the video call");
  });

  it("shows one clock when the visitor shares the business zone or is unknown", () => {
    const same = buildBookingConfirmationEmail({
      ...BASE,
      kind: "confirmation",
      visitorTimeZone: "America/Phoenix"
    });
    // Repeating one clock twice reads as a mistake.
    expect(same.text).not.toMatch(/that is .* for the business/);

    const unknown = buildBookingConfirmationEmail({ ...BASE, kind: "confirmation" });
    expect(unknown.text).toContain("9:00 AM");
    expect(unknown.text).not.toMatch(/that is .* for the business/);
  });

  it("uses reminder copy for the reminder kind", () => {
    const mail = buildBookingConfirmationEmail({ ...BASE, kind: "reminder" });
    expect(mail.subject).toBe("Reminder: your appointment with New Coworker");
    expect(mail.text).toContain("quick reminder");
  });

  it("falls back to the manage button, then to no button at all", () => {
    const manageOnly = buildBookingConfirmationEmail({
      ...BASE,
      kind: "confirmation",
      manageUrl: "https://www.newcoworker.com/book/manage/ncbm_abc"
    });
    expect(manageOnly.html).toContain("Reschedule or cancel");

    const bare = buildBookingConfirmationEmail({ ...BASE, kind: "reminder" });
    expect(bare.html).not.toContain("Reschedule or cancel");
    expect(bare.html).not.toContain("Join the video call");
  });

  it("renders Spanish from the same builder", () => {
    const mail = buildBookingConfirmationEmail({
      ...BASE,
      kind: "confirmation",
      locale: "es"
    });
    expect(mail.subject).toContain("está confirmada");
    expect(mail.text).toContain("Duración");
  });

  it("normalizes a trailing slash on the site url", () => {
    const mail = buildBookingConfirmationEmail({ ...BASE, kind: "confirmation" });
    expect(mail.html).not.toContain("newcoworker.com//");
  });

  it("blanks an empty visitor zone rather than treating it as a zone", () => {
    const mail = buildBookingConfirmationEmail({
      ...BASE,
      kind: "confirmation",
      visitorTimeZone: "   "
    });
    expect(mail.text).not.toMatch(/that is .* for the business/);
  });
});
