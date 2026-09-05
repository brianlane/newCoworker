/**
 * Owner-facing copy for a booking that just landed
 * (src/lib/email/templates/booking-owner-alert.ts).
 *
 * Three states, and the difference is the whole point:
 *
 *   solo    - the business has no roster. Nobody to assign to, and the owner
 *             is on the hook by definition, so the ownership language must
 *             not appear at all. This is the HQ-internal defect: the alert
 *             told a one-person business to "assign the contact to a
 *             teammate".
 *   covered - somebody holds it. Say who, and drop the warning.
 *   unowned - a roster exists and nobody holds it. The original alert, which
 *             is the only case that was ever right.
 *
 * Attribution is separate from state: a booking made on the public page was
 * made by the VISITOR, so claiming "your AI coworker booked it" is false.
 */
import { describe, expect, it } from "vitest";

import {
  buildBookingOwnerAlert,
  type BookingOwnerAlertInput
} from "@/lib/email/templates/booking-owner-alert";

function input(over: Partial<BookingOwnerAlertInput> = {}): BookingOwnerAlertInput {
  return {
    state: "unowned",
    attendeeName: "Brett Douglas",
    attendeePhone: "+12187702372",
    attendeeEmail: "brett@example.com",
    startLocal: "Friday, August 14, 2026 at 12:00 PM MST",
    summary: "Brett Douglas + New Coworker: Discovery Call",
    surface: "booking_page",
    ...over
  };
}

describe("buildBookingOwnerAlert: phone display", () => {
  it("renders a US number readably and leaves other formats alone", () => {
    expect(buildBookingOwnerAlert(input()).body).toContain("(218) 770-2372");
    // Mexico and other international numbers stay E.164 rather than being
    // forced into a US shape.
    expect(buildBookingOwnerAlert(input({ attendeePhone: "+525512345678" })).body).toContain(
      "+525512345678"
    );
    expect(buildBookingOwnerAlert(input({ attendeePhone: "not a phone" })).body).toContain(
      "not a phone"
    );
  });
});

describe("buildBookingOwnerAlert: solo business", () => {
  const solo = buildBookingOwnerAlert(input({ state: "solo" }));

  it("never uses ownership language, because there is nobody to assign to", () => {
    const whole = `${solo.subject}\n${solo.heading}\n${solo.body}\n${solo.smsBody}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("teammate");
    expect(whole).not.toContain("owner");
    expect(whole).not.toContain("nobody is on the hook");
  });

  it("is still a useful booking notice", () => {
    expect(solo.subject).toBe("New appointment: Brett Douglas, Friday, August 14, 2026 at 12:00 PM MST");
    expect(solo.heading).toBe("New appointment booked");
    expect(solo.body).toContain("Brett Douglas booked");
    expect(solo.body).toContain("(218) 770-2372");
    expect(solo.ctaLabel).toBe("Open contact");
  });

  it("ignores an assigneeName: solo calls now carry the implicit owner's name for the SMS leg", () => {
    // The alert resolver feeds the solo owner's name in for the employee
    // text, but the owner-facing solo email stays ownership-free: the
    // booking IS the message, and naming the owner to themselves is noise.
    const named = buildBookingOwnerAlert(input({ state: "solo", assigneeName: "Brian" }));
    const whole = `${named.subject}\n${named.heading}\n${named.body}\n${named.smsBody}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("brian");
    expect(named.body).toBe(solo.body);
  });
});

describe("buildBookingOwnerAlert: covered", () => {
  const covered = buildBookingOwnerAlert(
    input({ state: "covered", assigneeName: "Dana Reyes" })
  );

  it("names who has it and drops the warning", () => {
    expect(covered.body).toContain("Dana Reyes is assigned to this appointment.");
    expect(covered.body.toLowerCase()).not.toContain("nobody is on the hook");
    expect(covered.subject).not.toContain("needs an owner");
    expect(covered.ctaLabel).toBe("Open contact");
  });

  it("does not claim the assignee was texted, because that send is best effort", () => {
    expect(covered.body.toLowerCase()).not.toContain("texted");
  });

  it("falls back to the unowned copy when the name could not be resolved", () => {
    const nameless = buildBookingOwnerAlert(input({ state: "covered", assigneeName: null }));
    expect(nameless.subject).toContain("needs an owner");
    expect(nameless.body.toLowerCase()).toContain("nobody is on the hook");
  });
});

describe("buildBookingOwnerAlert: unowned", () => {
  const unowned = buildBookingOwnerAlert(input());

  it("keeps the warning and asks for the one action that fixes it", () => {
    expect(unowned.subject).toBe(
      "New appointment needs an owner: Brett Douglas, Friday, August 14, 2026 at 12:00 PM MST"
    );
    expect(unowned.body).toContain("No teammate owns this lead yet, so nobody is on the hook to show up.");
    expect(unowned.body).toContain("Assign the contact to a teammate");
    expect(unowned.ctaLabel).toBe("Assign this contact");
  });

  it("says it once: the heading is short, not a copy of the subject", () => {
    expect(unowned.heading).toBe("New appointment needs an owner");
    expect(unowned.heading.length).toBeLessThan(unowned.subject.length);
    // The phone belongs in the detail block, not in the subject line.
    expect(unowned.subject).not.toContain("218");
  });
});

describe("buildBookingOwnerAlert: who booked it", () => {
  it("a public-page booking was made by the visitor, not by the AI", () => {
    const page = buildBookingOwnerAlert(input({ surface: "booking_page" }));
    expect(page.body).not.toContain("Your AI coworker booked");
    // The page builds its titles as "<visitor> + <business>: <meeting>", so
    // quoting the whole thing after the visitor's name says the name twice:
    // `Brett Douglas booked "Brett Douglas + New Coworker: Discovery Call"`.
    // Only the meeting is quoted.
    expect(page.body).toContain('Brett Douglas booked "Discovery Call" on your booking page');
    expect(page.body).not.toContain('"Brett Douglas +');
  });

  it("drops the visitor prefix even when the page has no meeting types", () => {
    // The other title shape the page produces, with a duration instead of a
    // meeting name and no colon to split on.
    const page = buildBookingOwnerAlert(
      input({ surface: "booking_page", summary: "Brett Douglas + Acme Plumbing (30 min)" })
    );
    expect(page.body).toContain('booked "Acme Plumbing (30 min)" on your booking page');
    expect(page.body).not.toContain('"Brett Douglas +');
  });

  it("keeps the original title when stripping would leave nothing", () => {
    // A degenerate title (the business name never rendered) must not reduce
    // the sentence to `booked ""`.
    const page = buildBookingOwnerAlert(
      input({ surface: "booking_page", summary: "Brett Douglas + " })
    );
    expect(page.body).toContain('booked "Brett Douglas + " on your booking page');
  });

  it("leaves a title that does not carry the visitor's name alone", () => {
    const page = buildBookingOwnerAlert(
      input({ surface: "booking_page", summary: "Roof inspection" })
    );
    expect(page.body).toContain('booked "Roof inspection" on your booking page');
  });

  it("an AI-surface booking still credits the AI, and its title is left untouched", () => {
    for (const surface of ["voice", "sms", "webchat"] as const) {
      const ai = buildBookingOwnerAlert(input({ surface }));
      // Model-written summaries have no fixed shape, so nothing is stripped.
      expect(ai.body).toContain(
        'Your AI coworker booked "Brett Douglas + New Coworker: Discovery Call"'
      );
    }
  });
});

describe("buildBookingOwnerAlert: the detail block", () => {
  it("carries what somebody needs in order to show up", () => {
    const full = buildBookingOwnerAlert(
      input({
        durationMinutes: 30,
        joinUrl: "https://zoom.us/j/123",
        note: "Wants to talk pricing",
        intakeLines: ["Company: Acme", "Team size: 12"]
      })
    );
    expect(full.body).toContain("Phone: (218) 770-2372");
    expect(full.body).toContain("Email: brett@example.com");
    expect(full.body).toContain("Length: 30 minutes");
    expect(full.body).toContain("Video link: https://zoom.us/j/123");
    expect(full.body).toContain("Their note: Wants to talk pricing");
    expect(full.body).toContain("Company: Acme");
    expect(full.body).toContain("Team size: 12");
  });

  it("omits every line it has no value for", () => {
    const bare = buildBookingOwnerAlert(
      input({ attendeePhone: null, attendeeEmail: null, intakeLines: [] })
    );
    expect(bare.body).not.toContain("Phone:");
    expect(bare.body).not.toContain("Email:");
    expect(bare.body).not.toContain("Length:");
    expect(bare.body).not.toContain("Video link:");
    expect(bare.body).not.toContain("Their note:");
  });
});

describe("buildBookingOwnerAlert: the link", () => {
  it("points at the contact, where the owner picker lives", () => {
    expect(buildBookingOwnerAlert(input()).ctaPath).toBe(
      `/dashboard/customers/${encodeURIComponent("+12187702372")}`
    );
  });

  it("falls back to the bookings list when the booking carried no phone", () => {
    expect(buildBookingOwnerAlert(input({ attendeePhone: null })).ctaPath).toBe(
      "/dashboard/bookings"
    );
  });
});

describe("buildBookingOwnerAlert: the dashboard summary line", () => {
  it("reads correctly for each state", () => {
    expect(buildBookingOwnerAlert(input()).summaryLine).toContain("Unassigned booking");
    expect(
      buildBookingOwnerAlert(input({ state: "covered", assigneeName: "Dana Reyes" })).summaryLine
    ).toContain("Dana Reyes");
    expect(buildBookingOwnerAlert(input({ state: "solo" })).summaryLine).toContain(
      "New appointment"
    );
  });
});
