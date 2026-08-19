/**
 * Owner alert for a booking that just landed
 * (src/lib/calendar-tools/unassigned-booking-alert.ts): the three ownership
 * states, the fail directions, what reaches the dispatcher, and the
 * never-throws contract.
 *
 * The production triggers, both of them:
 *   - Truly Insurance, Jul 21 2026: the AI booked a real broker call for a
 *     lead no one owned, and no human was told the meeting existed.
 *   - HQ internal, Aug 3 2026: a business with no employees at all was told
 *     to "assign the contact to a teammate", and a booking the visitor made
 *     on the public page was credited to the AI coworker.
 *
 * The database-shaped claims (the roster count filtering on `active`, the
 * alias lookup, and one number matching TWO contacts) are pinned against a
 * real Postgres in tests/worker-integration/unassigned-booking-alert.itest.ts,
 * because a chainable fake cannot parse a PostgREST filter string. What is
 * asserted here is the decision logic on top of those reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/notification-preferences", () => ({
  getNotificationPreferences: vi.fn()
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn(), listTeamMembers: vi.fn() }));
vi.mock("@/lib/db/implicit-contact-owner", () => ({
  resolveImplicitContactOwner: vi.fn()
}));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));

import {
  maybeAlertUnassignedBooking,
  type UnassignedBookingAlertInput
} from "@/lib/calendar-tools/unassigned-booking-alert";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { getTeamMember, listTeamMembers } from "@/lib/db/employees";
import { resolveImplicitContactOwner } from "@/lib/db/implicit-contact-owner";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

const INPUT: UnassignedBookingAlertInput = {
  attendeeName: "Brett Douglas",
  attendeePhone: "+12187702372",
  attendeeEmail: "brett@example.com",
  startIso: "2026-08-14T19:00:00.000Z",
  startLocal: "Friday, August 14, 2026 at 12:00 PM MST",
  summary: "Brett Douglas + New Coworker: Discovery Call",
  eventId: "evt-1",
  surface: "booking_page"
};

type ContactAnswer = { data?: unknown; error?: { message: string } | null };
type RosterAnswer = { count?: number; error?: { message: string } | null; rejectWith?: unknown };

/**
 * Table-routed fake. `ai_flow_team_members` answers the head-count query;
 * `contacts` answers the phone lookup (an ARRAY, since the real query is
 * ordered-and-limited rather than maybeSingle) and then the email lookup.
 */
function fakeDb(opts: { roster?: RosterAnswer; contacts?: ContactAnswer[] } = {}) {
  const contacts = [...(opts.contacts ?? [])];
  return {
    from(table: string) {
      const chain: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "or", "order"]) chain[m] = () => chain;

      if (table === "ai_flow_team_members") {
        // The count query resolves off the builder itself (await, no .single).
        const answer = opts.roster ?? { count: 1, error: null };
        chain.select = () => ({
          eq: () => ({
            eq: () =>
              "rejectWith" in answer
                ? Promise.reject(answer.rejectWith)
                : // An explicit roster object with no count passes `null`
                  // through, the way PostgREST can answer a head-count.
                  Promise.resolve({ count: answer.count ?? null, error: answer.error ?? null })
          })
        });
        return chain;
      }

      // contacts: phone lookup ends at .limit(), email lookup at .maybeSingle().
      chain.select = () => chain;
      chain.limit = () => {
        const r = contacts.shift() ?? { data: [], error: null };
        const resolved = { data: r.data ?? null, error: r.error ?? null };
        return Object.assign(Promise.resolve(resolved), {
          maybeSingle: () => Promise.resolve(resolved)
        });
      };
      return chain;
    }
  } as never;
}

/** No contact row anywhere: both lookups come back empty. */
const NO_CONTACT: ContactAnswer[] = [{ data: [] }, { data: null }];

function dispatched() {
  return vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
}

/**
 * The email copy as the dispatcher will render it. It lives in the template
 * callback rather than in explicit fields, because explicit fields would
 * outrank the template and defeat the owner's locale.
 */
function emailCopy(locale: "en" | "es" = "en") {
  const templated = dispatched().emailTemplate?.(locale);
  if (!templated) throw new Error("no emailTemplate was supplied");
  return templated;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
  vi.mocked(getNotificationPreferences).mockResolvedValue(null as never);
  vi.mocked(getTeamMember).mockResolvedValue({ id: "emp-1", name: "Dana Reyes" } as never);
  // Default: the one active member is NOT the owner, so a count of 1 means a
  // real teammate exists. The solo-owner block below overrides it.
  vi.mocked(resolveImplicitContactOwner).mockResolvedValue(null);
});

/**
 * HQ, Aug 18 2026. The Aug 3 rework taught this alert about a business with
 * NO roster, and HQ has one roster row: Brian, the owner himself. So every
 * booking told the owner to "assign the contact to a teammate" who does not
 * exist. One active member who IS the owner is the same situation as no
 * roster at all, and takes the same `solo` copy.
 */
describe("maybeAlertUnassignedBooking: a one-person roster that is the owner", () => {
  const OWNER_ONLY = { id: "mem-owner", name: "Brian" };

  it("never asks the owner to assign the lead to their nonexistent teammate", async () => {
    vi.mocked(resolveImplicitContactOwner).mockResolvedValue(OWNER_ONLY);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 1 }, contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_solo");
    const copy = emailCopy();
    const whole = `${copy.subject}\n${copy.body}\n${dispatched().smsBody}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("teammate");
  });

  it("still warns a one-person roster whose member is NOT the owner", async () => {
    // An assistant on the roster can be handed the lead, so "nobody holds
    // this yet" is still news. resolveImplicitContactOwner returns null.
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 1 }, contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_unowned");
    expect(emailCopy().body.toLowerCase()).toContain("assign");
  });

  it("keeps the old wording when the ownership read fails", async () => {
    // Fails toward "there is a team": a wording miss beats silencing the
    // warning that exists to prevent a no-show.
    vi.mocked(resolveImplicitContactOwner).mockResolvedValue(null);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 1 }, contacts: NO_CONTACT })
    });
    expect(out).toBe("sent_unowned");
  });

  it("does not pay for the ownership read when the roster is empty", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 0 }, contacts: NO_CONTACT })
    });
    expect(out).toBe("sent_solo");
    expect(resolveImplicitContactOwner).not.toHaveBeenCalled();
  });
});

describe("maybeAlertUnassignedBooking: a business with no employees", () => {
  it("never asks a solo owner to assign the lead to a teammate", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 0 }, contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_solo");
    const call = dispatched();
    const copy = emailCopy();
    const whole = `${copy.subject}\n${copy.body}\n${call.smsBody}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("teammate");
    expect(whole).not.toContain("nobody is on the hook");
    // Still a useful notice, and filed under the handled kind.
    expect(call.kind).toBe("assigned_booking");
    expect(emailCopy().body).toContain("Brett Douglas");
  });

  it("does not run the roster query as a proxy for ownership: a solo business with an owned contact is still solo", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({
        roster: { count: 0 },
        contacts: [{ data: [{ owner_employee_id: "emp-1", customer_e164: INPUT.attendeePhone }] }]
      })
    });
    expect(out).toBe("sent_solo");
  });
});

describe("maybeAlertUnassignedBooking: who holds the appointment", () => {
  it("names the contact's owner and drops the warning", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({
        contacts: [{ data: [{ owner_employee_id: "emp-1", customer_e164: INPUT.attendeePhone }] }]
      })
    });

    expect(out).toBe("sent_covered");
    expect(emailCopy().body).toContain("Dana Reyes is assigned to this appointment.");
    expect(dispatched().kind).toBe("assigned_booking");
  });

  it("the booking's own assignee outranks the contact owner, and skips the contact lookup", async () => {
    vi.mocked(getTeamMember).mockResolvedValue({ id: "emp-9", name: "Sam Okafor" } as never);
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, bookingAssigneeMemberId: "emp-9" },
      { client: fakeDb({ contacts: [] }) }
    );

    expect(out).toBe("sent_covered");
    expect(getTeamMember).toHaveBeenCalledWith(BIZ, "emp-9");
    expect(emailCopy().body).toContain("Sam Okafor");
    expect(dispatched().payload).toMatchObject({
      assignee_member_id: "emp-9",
      assignee_name: "Sam Okafor",
      ownership_state: "covered"
    });
  });

  it("a holder whose name cannot be resolved degrades to the warning, never to a blank name", async () => {
    vi.mocked(getTeamMember).mockResolvedValue(null as never);
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, bookingAssigneeMemberId: "emp-gone" },
      { client: fakeDb({ contacts: [] }) }
    );

    expect(out).toBe("sent_unowned");
    expect(emailCopy().body).toContain("nobody is on the hook");
    expect(emailCopy().body).not.toContain("undefined");
  });

  it("a roster with nobody holding the lead keeps the original warning", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_unowned");
    expect(dispatched().kind).toBe("unassigned_booking");
    expect(emailCopy().subject).toContain("needs an owner");
  });

  it("falls back to the email lookup when the phone matches nothing", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: [{ data: [] }, { data: { owner_employee_id: "emp-1" } }] })
    });
    expect(out).toBe("sent_covered");
  });

  it("prefers the EXACT number over a contact carrying it only as an alias", async () => {
    vi.mocked(getTeamMember).mockResolvedValue({ id: "emp-2", name: "Exact Owner" } as never);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({
        contacts: [
          {
            data: [
              { owner_employee_id: null, customer_e164: "+16135550102" },
              { owner_employee_id: "emp-2", customer_e164: INPUT.attendeePhone }
            ]
          }
        ]
      })
    });
    expect(out).toBe("sent_covered");
    expect(getTeamMember).toHaveBeenCalledWith(BIZ, "emp-2");
  });

  it("matches on an ALIAS when no contact holds the number as its primary", async () => {
    vi.mocked(getTeamMember).mockResolvedValue({ id: "emp-7", name: "Alias Owner" } as never);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({
        // The number lives only in this row's alias_e164s, so nothing has it
        // as customer_e164 and the exact-match preference has no candidate.
        contacts: [{ data: [{ owner_employee_id: "emp-7", customer_e164: "+16135550102" }] }]
      })
    });
    expect(out).toBe("sent_covered");
    expect(getTeamMember).toHaveBeenCalledWith(BIZ, "emp-7");
  });

  it("a null rows payload reads as no contact rather than throwing", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: [{ data: null }, { data: null }] })
    });
    expect(out).toBe("sent_unowned");
  });

  it("a null roster count reads as no roster", async () => {
    // PostgREST can answer a head-count with a null count; treating that as
    // NaN or as a team would both be wrong for a business with no employees.
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: undefined }, contacts: NO_CONTACT })
    });
    expect(out).toBe("sent_solo");
  });

  it("a phoneless booking goes straight to the email lookup", async () => {
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, attendeePhone: null },
      { client: fakeDb({ contacts: [{ data: null }] }) }
    );
    expect(out).toBe("sent_unowned");
    expect(dispatched().payload).not.toHaveProperty("contactE164");
    // No contact page to link to without a number.
    expect(dispatched().ctaPath).toBe("/dashboard/bookings");
  });

  it("a booking with neither phone nor email cannot be looked up at all", async () => {
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, attendeePhone: null, attendeeEmail: null },
      { client: fakeDb({ contacts: [] }) }
    );
    expect(out).toBe("sent_unowned");
  });
});

describe("maybeAlertUnassignedBooking: what reaches the dispatcher", () => {
  it("carries the deep link, the short heading, and the booking context", async () => {
    await maybeAlertUnassignedBooking(
      BIZ,
      {
        ...INPUT,
        durationMinutes: 30,
        joinUrl: "https://zoom.us/j/123",
        note: "Wants to talk pricing",
        intakeLines: ["Company: Acme"]
      },
      { client: fakeDb({ contacts: NO_CONTACT }) }
    );

    const call = dispatched();
    expect(call.ctaPath).toBe(`/dashboard/customers/${encodeURIComponent("+12187702372")}`);
    expect(emailCopy().ctaLabel).toBe("Assign this contact");
    const copy = emailCopy();
    expect(copy.heading).toBe("New appointment needs an owner");
    // Said once: the heading is not a copy of the subject.
    expect(copy.heading).not.toBe(copy.subject);
    expect(copy.body).toContain("Length: 30 minutes");
    expect(copy.body).toContain("Video link: https://zoom.us/j/123");
    expect(copy.body).toContain("Their note: Wants to talk pricing");
    expect(copy.body).toContain("Company: Acme");
    expect(call.payload).toMatchObject({
      surface: "booking_page",
      ownership_state: "unowned",
      contactE164: "+12187702372"
    });
  });

  it("is addressed to the business owner on every branch (no contactE164 routing)", async () => {
    await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) });
    // Redirecting to the contact's owner would page the very person the
    // covered branch already names, and nobody new on the solo branch.
    expect(dispatched().contactE164).toBeUndefined();
  });

  it("hands the EMAIL copy to the template and does not also send English overrides", async () => {
    await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) });
    const call = dispatched();

    // The bug this pins: passing an explicit English emailSubject/emailBody
    // ALONGSIDE the template meant the explicit copy always won in the
    // dispatcher, so the owner's locale was resolved and then thrown away.
    // Asserting the callback can speak Spanish is not enough, because the
    // callback's output was never the thing that got sent.
    expect(call.emailSubject).toBeUndefined();
    expect(call.emailBody).toBeUndefined();
    expect(call.emailHeading).toBeUndefined();
    expect(call.ctaLabel).toBeUndefined();

    // The channels that resolve NO locale keep their English copy, since
    // there is nothing to render them in.
    expect(call.summary).toContain("Unassigned booking");
    expect(call.smsBody).toContain("No teammate owns this lead yet");

    const en = call.emailTemplate?.("en");
    expect(en?.subject).toContain("needs an owner");
    expect(en?.heading).toBe("New appointment needs an owner");
    expect(en?.ctaLabel).toBe("Assign this contact");

    const es = call.emailTemplate?.("es");
    expect(es?.subject).toContain("necesita responsable");
    expect(es?.ctaLabel).toBe("Asignar este contacto");
    // The path is locale-independent, so it must not move.
    expect(es?.ctaPath).toBe(call.ctaPath);
  });

  it("credits the visitor for a page booking and the AI for an AI booking", async () => {
    await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) });
    expect(emailCopy().body).not.toContain("Your AI coworker booked");

    vi.clearAllMocks();
    vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
    vi.mocked(getNotificationPreferences).mockResolvedValue(null as never);
    await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, surface: "voice" },
      { client: fakeDb({ contacts: NO_CONTACT }) }
    );
    expect(emailCopy().body).toContain("Your AI coworker booked");
  });
});

describe("maybeAlertUnassignedBooking: gates and failure", () => {
  it("skips only on an explicit false; a missing row or column reads as on", async () => {
    vi.mocked(getNotificationPreferences).mockResolvedValue({
      unassigned_booking_alerts: false
    } as never);
    const disabled = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT })
    });
    expect(disabled).toBe("skipped_disabled");
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();

    vi.mocked(getNotificationPreferences).mockResolvedValue(null as never);
    expect(
      await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) })
    ).toBe("sent_unowned");

    // A row predating the column.
    vi.mocked(getNotificationPreferences).mockResolvedValue({} as never);
    expect(
      await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) })
    ).toBe("sent_unowned");
  });

  it("an unreadable roster count keeps the warning rather than silently dropping it", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { error: { message: "roster down" } }, contacts: NO_CONTACT })
    });
    // Fails toward the noisier, safer answer. This read only chooses the
    // wording, so it must never be able to suppress the alert: a solo tenant
    // seeing team copy is a wording miss, a team tenant losing the warning is
    // the no-show the alert exists to prevent.
    expect(out).toBe("sent_unowned");
    expect(dispatchUrgentNotification).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert: roster count unreadable, assuming a team",
      expect.objectContaining({ error: expect.stringContaining("roster down") })
    );
  });

  it("a roster read that rejects with a non-Error still keeps the warning", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { rejectWith: "roster string sad" }, contacts: NO_CONTACT })
    });
    expect(out).toBe("sent_unowned");
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert: roster count unreadable, assuming a team",
      expect.objectContaining({ error: "roster string sad" })
    );
  });

  it("never throws: lookup errors, dispatch failures, and non-Error shapes all answer failed", async () => {
    expect(
      await maybeAlertUnassignedBooking(BIZ, INPUT, {
        client: fakeDb({ contacts: [{ error: { message: "contacts down" } }] })
      })
    ).toBe("failed");

    expect(
      await maybeAlertUnassignedBooking(BIZ, INPUT, {
        client: fakeDb({ contacts: [{ data: [] }, { error: { message: "email index down" } }] })
      })
    ).toBe("failed");

    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce("dispatch string sad");
    expect(
      await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) })
    ).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert failed (booking unaffected)",
      expect.objectContaining({ error: "dispatch string sad" })
    );
  });

  it("binds the production client, preference read, dispatcher, and roster read when no deps are injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      fakeDb({ roster: { count: 0 }, contacts: NO_CONTACT })
    );
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT);
    expect(out).toBe("sent_solo");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(getNotificationPreferences).toHaveBeenCalled();
  });
});

/**
 * The employee audience (Amy Laidlaw Real Estate, Aug 17 2026). The owner
 * half of this alert already fired on every booking; what was impossible was
 * telling anyone else. `booking_alert_audience` adds that without moving the
 * default: an untouched tenant stays owner-only and never reads the roster.
 */
describe("the employee audience", () => {
  const ROSTER = [
    { id: "a", name: "Dave Lane", phone_e164: "+15555550101", active: true },
    { id: "b", name: "Gabrielle Mota", phone_e164: "+15555550102", active: true }
  ];

  function prefs(over: Record<string, unknown>) {
    vi.mocked(getNotificationPreferences).mockResolvedValue(over as never);
  }

  it("never reads the roster when the audience is the default owner", async () => {
    prefs({ unassigned_booking_alerts: true });
    // Two active members: a business with a real team, which is what this
    // cost claim is about. (A count of ONE takes the ownership read below,
    // since that single member may be the owner's own roster row.)
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 2 }, contacts: NO_CONTACT }),
      listMembers: vi.fn() as never
    });
    expect(out).toBe("sent_unowned");
    expect(listTeamMembers).not.toHaveBeenCalled();
    expect(resolveImplicitContactOwner).not.toHaveBeenCalled();
  });

  it("texts every active member and still alerts the owner on 'both'", async () => {
    prefs({ booking_alert_audience: "both" });
    const sendSms = vi.fn().mockResolvedValue(undefined);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue(ROSTER) as never,
      sendSms
    });
    expect(out).toBe("sent_unowned");
    expect(dispatchUrgentNotification).toHaveBeenCalled();
    expect(sendSms.mock.calls.map((c) => c[1])).toEqual(["+15555550101", "+15555550102"]);
    expect(String(sendSms.mock.calls[0][2])).toContain("NOT assigned to anyone yet.");
  });

  it("drops the owner dispatch entirely on 'employees'", async () => {
    prefs({ booking_alert_audience: "employees" });
    const sendSms = vi.fn().mockResolvedValue(undefined);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue(ROSTER) as never,
      sendSms
    });
    expect(out).toBe("sent_employees_only");
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(2);
  });

  it("honors a selected-employee list", async () => {
    prefs({ booking_alert_audience: "employees", booking_alert_member_ids: ["b"] });
    const sendSms = vi.fn().mockResolvedValue(undefined);
    await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue(ROSTER) as never,
      sendSms
    });
    expect(sendSms.mock.calls.map((c) => c[1])).toEqual(["+15555550102"]);
  });

  it("one dead number does not cost the others their message", async () => {
    prefs({ booking_alert_audience: "employees" });
    const sendSms = vi
      .fn()
      .mockRejectedValueOnce(new Error("40310 invalid destination"))
      .mockResolvedValue(undefined);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue(ROSTER) as never,
      sendSms
    });
    expect(out).toBe("sent_employees_only");
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "booking alert: employee text failed",
      expect.objectContaining({ memberId: "a" })
    );
  });

  it("logs a non-Error rejection as a string", async () => {
    prefs({ booking_alert_audience: "employees" });
    const sendSms = vi.fn().mockRejectedValue("telnyx sad");
    await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue([ROSTER[0]]) as never,
      sendSms
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "booking alert: employee text failed",
      expect.objectContaining({ error: "telnyx sad" })
    );
  });

  it("sends nothing when the roster has nobody textable", async () => {
    prefs({ booking_alert_audience: "employees" });
    const sendSms = vi.fn();
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockResolvedValue([]) as never,
      sendSms
    });
    expect(out).toBe("sent_employees_only");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("names the holder when the booking is owned", async () => {
    prefs({ booking_alert_audience: "employees" });
    vi.mocked(getTeamMember).mockResolvedValue({ name: "Dave Lane" } as never);
    const sendSms = vi.fn().mockResolvedValue(undefined);
    await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, bookingAssigneeMemberId: "a" },
      {
        client: fakeDb({ contacts: NO_CONTACT }),
        listMembers: vi.fn().mockResolvedValue([ROSTER[1]]) as never,
        sendSms
      }
    );
    expect(String(sendSms.mock.calls[0][2])).toContain("Assigned to Dave Lane.");
  });

  it("binds the real roster read and Telnyx send when no deps are injected", async () => {
    prefs({ booking_alert_audience: "employees" });
    vi.mocked(listTeamMembers).mockResolvedValue(ROSTER as never);
    vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({} as never);
    vi.mocked(sendTelnyxSms).mockResolvedValue({} as never);
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT })
    });
    expect(out).toBe("sent_employees_only");
    expect(sendTelnyxSms).toHaveBeenCalledTimes(2);
    expect(getTelnyxMessagingForBusiness).toHaveBeenCalledWith(BIZ, expect.anything());
  });

  it("a roster read that throws is caught by the never-throws contract", async () => {
    prefs({ booking_alert_audience: "both" });
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: vi.fn().mockRejectedValue(new Error("roster down")) as never
    });
    expect(out).toBe("failed");
  });

  it("an unknown stored audience falls back to owner-only", async () => {
    prefs({ booking_alert_audience: "everyone" });
    const listMembers = vi.fn();
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT }),
      listMembers: listMembers as never
    });
    expect(out).toBe("sent_unowned");
    expect(listMembers).not.toHaveBeenCalled();
  });
});
