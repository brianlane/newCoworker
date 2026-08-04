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
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));

import {
  maybeAlertUnassignedBooking,
  type UnassignedBookingAlertInput
} from "@/lib/calendar-tools/unassigned-booking-alert";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { getTeamMember } from "@/lib/db/employees";
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
  vi.mocked(getNotificationPreferences).mockResolvedValue(null as never);
  vi.mocked(getTeamMember).mockResolvedValue({ id: "emp-1", name: "Dana Reyes" } as never);
});

describe("maybeAlertUnassignedBooking: a business with no employees", () => {
  it("never asks a solo owner to assign the lead to a teammate", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ roster: { count: 0 }, contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_solo");
    const call = dispatched();
    const whole = `${call.emailSubject}\n${call.emailBody}\n${call.smsBody}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("teammate");
    expect(whole).not.toContain("nobody is on the hook");
    // Still a useful notice, and filed under the handled kind.
    expect(call.kind).toBe("assigned_booking");
    expect(call.emailBody).toContain("Brett Douglas");
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
    expect(dispatched().emailBody).toContain("Dana Reyes is assigned to this appointment.");
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
    expect(dispatched().emailBody).toContain("Sam Okafor");
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
    expect(dispatched().emailBody).toContain("nobody is on the hook");
    expect(dispatched().emailBody).not.toContain("undefined");
  });

  it("a roster with nobody holding the lead keeps the original warning", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb({ contacts: NO_CONTACT })
    });

    expect(out).toBe("sent_unowned");
    expect(dispatched().kind).toBe("unassigned_booking");
    expect(dispatched().emailSubject).toContain("needs an owner");
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
    expect(call.ctaLabel).toBe("Assign this contact");
    expect(call.emailHeading).toBe("New appointment needs an owner");
    // Said once: the heading is not a copy of the subject.
    expect(call.emailHeading).not.toBe(call.emailSubject);
    expect(call.emailBody).toContain("Length: 30 minutes");
    expect(call.emailBody).toContain("Video link: https://zoom.us/j/123");
    expect(call.emailBody).toContain("Their note: Wants to talk pricing");
    expect(call.emailBody).toContain("Company: Acme");
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

  it("re-renders the copy in the owner's locale through the template callback", async () => {
    await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) });
    const es = dispatched().emailTemplate?.("es");
    expect(es?.subject).toContain("necesita responsable");
    expect(es?.ctaLabel).toBe("Asignar este contacto");
    // The path is locale-independent, so it must not move.
    expect(es?.ctaPath).toBe(dispatched().ctaPath);
  });

  it("credits the visitor for a page booking and the AI for an AI booking", async () => {
    await maybeAlertUnassignedBooking(BIZ, INPUT, { client: fakeDb({ contacts: NO_CONTACT }) });
    expect(dispatched().emailBody).not.toContain("Your AI coworker booked");

    vi.clearAllMocks();
    vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
    vi.mocked(getNotificationPreferences).mockResolvedValue(null as never);
    await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, surface: "voice" },
      { client: fakeDb({ contacts: NO_CONTACT }) }
    );
    expect(dispatched().emailBody).toContain("Your AI coworker booked");
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
