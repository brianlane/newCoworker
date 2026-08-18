import { describe, expect, it } from "vitest";
import {
  buildBookingAlertSms,
  parseBookingAlertAudience,
  resolveBookingAlertRecipients,
  type BookingAlertMember
} from "@/lib/calendar-tools/booking-alert-recipients";

function member(over: Partial<BookingAlertMember> = {}): BookingAlertMember {
  return {
    id: "m1",
    name: "Dave Lane",
    phone_e164: "+16025245719",
    active: true,
    ...over
  };
}

describe("parseBookingAlertAudience", () => {
  it("reads the three stored values", () => {
    expect(parseBookingAlertAudience("owner")).toBe("owner");
    expect(parseBookingAlertAudience("employees")).toBe("employees");
    expect(parseBookingAlertAudience("both")).toBe("both");
  });

  it("falls back to owner for anything else", () => {
    // The column has a CHECK constraint, so this should be unreachable. It
    // still has to be safe: throwing on a best-effort alert path would
    // suppress a real booking notice, and "owner" is the behavior every
    // tenant had before the column existed.
    expect(parseBookingAlertAudience(undefined)).toBe("owner");
    expect(parseBookingAlertAudience(null)).toBe("owner");
    expect(parseBookingAlertAudience("")).toBe("owner");
    expect(parseBookingAlertAudience("everyone")).toBe("owner");
    expect(parseBookingAlertAudience(7)).toBe("owner");
  });
});

describe("resolveBookingAlertRecipients", () => {
  it("owner-only never reads the roster", () => {
    const out = resolveBookingAlertRecipients("owner", null, [member()]);
    expect(out).toEqual({ owner: true, members: [] });
  });

  it("both keeps the owner and adds the employees", () => {
    const out = resolveBookingAlertRecipients("both", null, [member()]);
    expect(out.owner).toBe(true);
    expect(out.members.map((m) => m.id)).toEqual(["m1"]);
  });

  it("employees drops the owner", () => {
    const out = resolveBookingAlertRecipients("employees", null, [member()]);
    expect(out.owner).toBe(false);
    expect(out.members).toHaveLength(1);
  });

  it("a null id list means every active member", () => {
    const out = resolveBookingAlertRecipients("employees", null, [
      member({ id: "a", phone_e164: "+16025245719" }),
      member({ id: "b", phone_e164: "+14807202013" })
    ]);
    expect(out.members.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("an empty id list also means every active member, not nobody", () => {
    // A UI that clears the list means "stop narrowing". "Employees, but
    // nobody" is a setting that can only ever be a mistake.
    const out = resolveBookingAlertRecipients("employees", [], [member()]);
    expect(out.members).toHaveLength(1);
  });

  it("a non-empty id list selects only those members", () => {
    const out = resolveBookingAlertRecipients(
      "employees",
      ["b"],
      [
        member({ id: "a", phone_e164: "+16025245719" }),
        member({ id: "b", phone_e164: "+14807202013" })
      ]
    );
    expect(out.members.map((m) => m.id)).toEqual(["b"]);
  });

  it("drops an inactive member even when named explicitly", () => {
    // Someone who left the roster does not start receiving alerts again
    // because their id is still sitting in a preference nobody edited.
    const out = resolveBookingAlertRecipients("employees", ["a"], [
      member({ id: "a", active: false })
    ]);
    expect(out.members).toEqual([]);
  });

  it("drops a member with no phone, since this leg is SMS only", () => {
    const out = resolveBookingAlertRecipients("employees", null, [
      member({ id: "a", phone_e164: "" }),
      member({ id: "b", phone_e164: "   " })
    ]);
    expect(out.members).toEqual([]);
  });

  it("survives a roster row with a missing phone field", () => {
    const out = resolveBookingAlertRecipients("employees", null, [
      { id: "a", name: "No Phone", active: true } as unknown as BookingAlertMember
    ]);
    expect(out.members).toEqual([]);
  });

  it("trims the number it hands back", () => {
    const out = resolveBookingAlertRecipients("employees", null, [
      member({ phone_e164: "  +16025245719  " })
    ]);
    expect(out.members[0].phone_e164).toBe("+16025245719");
  });

  it("texts one message when two roster rows share a phone", () => {
    // The same person entered twice should not get the alert twice.
    const out = resolveBookingAlertRecipients("employees", null, [
      member({ id: "a", phone_e164: "+16025245719" }),
      member({ id: "b", phone_e164: "+16025245719" })
    ]);
    expect(out.members.map((m) => m.id)).toEqual(["a"]);
  });

  it("returns nobody when the roster is empty", () => {
    const out = resolveBookingAlertRecipients("both", null, []);
    expect(out).toEqual({ owner: true, members: [] });
  });
});

describe("buildBookingAlertSms", () => {
  const base = {
    attendeeName: "Aurora Anthony",
    startLocal: "Mon Aug 18, 2:00 PM",
    summary: "Buyer consultation",
    attendeePhone: "+16029200022"
  };

  it("names the holder when the appointment is assigned", () => {
    const text = buildBookingAlertSms({ ...base, assigneeName: "Dave Lane" });
    expect(text).toContain("Aurora Anthony +16029200022");
    expect(text).toContain("Buyer consultation");
    expect(text).toContain("Mon Aug 18, 2:00 PM");
    expect(text).toContain("Assigned to Dave Lane.");
  });

  it("says so plainly when nobody holds it", () => {
    // This is the case somebody actually has to act on, so it must not be
    // phrased as an absence the reader has to notice.
    const text = buildBookingAlertSms({ ...base, assigneeName: null });
    expect(text).toContain("NOT assigned to anyone yet.");
  });

  it("omits the phone when the booking carried none", () => {
    const text = buildBookingAlertSms({ ...base, attendeePhone: null, assigneeName: null });
    expect(text).toContain("New booking: Aurora Anthony\n");
  });

  it("carries no em dash", () => {
    const text = buildBookingAlertSms({ ...base, assigneeName: "Dave Lane" });
    expect(text).not.toContain("—");
  });
});
