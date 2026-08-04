/**
 * Owner alert for a booking nobody is on the hook for, against a REAL local
 * Postgres and the REAL dispatcher (Aug 3 2026).
 *
 * The unit suite fakes the Supabase client with a chainable stub, so three
 * claims in this code have never actually been checked:
 *
 *   1. "no active roster member" is a real query against a real column. The
 *      whole solo-tenant variant hangs off it, and HQ internal (no employees
 *      at all) is the tenant that exposed the defect: it was told to "assign
 *      the contact to a teammate" when there is no teammate to assign to.
 *   2. The phone lookup's PostgREST filter string
 *      (`customer_e164.eq.X,alias_e164s.cs.{X}`) is only parsed by a real
 *      PostgREST. A chainable fake returns whatever the test handed it, so an
 *      alias match, or a phone that matches TWO contacts, proves nothing.
 *   3. The rendered email is built inside the dispatcher, downstream of the
 *      alert, and is never persisted: `notifications` rows carry the summary
 *      and payload, not the subject or body. The only honest way to assert the
 *      copy is to catch the outbound send.
 *
 * Safety: this process loads no `.env` (verified), so nothing here can reach
 * production. `guardedFetch` below makes that structural rather than lucky: it
 * passes localhost through to the real stack, captures the Resend and Telnyx
 * calls, and THROWS on any other host.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, seedContact, serviceDb, SUPABASE_URL } from "./harness";

import {
  maybeAlertUnassignedBooking,
  type UnassignedBookingAlertInput
} from "@/lib/calendar-tools/unassigned-booking-alert";

let db: SupabaseClient;

/** Outbound sends captured instead of made. */
type SentEmail = { to: string; subject: string; text: string; html: string };
let sentEmails: SentEmail[] = [];
let sentSms: string[] = [];

const realFetch = globalThis.fetch;

/**
 * Everything local goes to the real stack; the two external transports are
 * captured; anything else is a bug and fails loudly rather than escaping.
 */
async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
    return realFetch(input, init);
  }

  if (url.startsWith("https://api.resend.com")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sentEmails.push({
      to: String(body.to ?? ""),
      subject: String(body.subject ?? ""),
      text: String(body.text ?? ""),
      html: String(body.html ?? "")
    });
    return new Response(JSON.stringify({ data: { id: `itest-${randomUUID()}` }, error: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.startsWith("https://api.telnyx.com")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sentSms.push(String(body.text ?? ""));
    return new Response(JSON.stringify({ data: { id: `itest-sms-${randomUUID()}` } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  throw new Error(`itest tried to reach an unexpected host: ${url}`);
}

beforeAll(() => {
  // Point the code under test at the LOCAL stack. Asserted, not assumed: if a
  // future change starts loading .env into this process, these must still be
  // local or the suite refuses to run rather than paging real owners.
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  process.env.NEXT_PUBLIC_APP_URL = "https://ncw.example";
  process.env.RESEND_API_KEY = "itest-resend-key";

  expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  expect(process.env.SUPABASE_SERVICE_ROLE_KEY).not.toBe("");

  globalThis.fetch = guardedFetch as typeof fetch;
  db = serviceDb();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  sentEmails = [];
  sentSms = [];
});

afterEach(async () => {
  // Nothing to undo: every scenario seeds its own business and the rows are
  // scoped to it.
});

const LEAD = "+12187702372";

function bookingInput(over: Partial<UnassignedBookingAlertInput> = {}): UnassignedBookingAlertInput {
  return {
    attendeeName: "Brett Douglas",
    attendeePhone: LEAD,
    attendeeEmail: "brett@example.com",
    startIso: "2026-08-14T19:00:00.000Z",
    startLocal: "Friday, August 14, 2026 at 12:00 PM MST",
    summary: "Brett Douglas + New Coworker: Discovery Call",
    eventId: "evt-itest",
    surface: "booking_page",
    ...over
  };
}

async function addMember(
  businessId: string,
  name: string,
  active = true
): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({
      business_id: businessId,
      name,
      phone_e164: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
      active
    })
    .select("id")
    .single();
  if (error) throw new Error(`addMember: ${error.message}`);
  return (data as { id: string }).id;
}

async function notificationsFor(businessId: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, kind, summary, payload")
    .eq("business_id", businessId);
  if (error) throw new Error(`notificationsFor: ${error.message}`);
  return (data ?? []) as Array<{
    delivery_channel: string;
    status: string;
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
  }>;
}

/** The one email the dispatcher actually sent, subject plus text body. */
function onlyEmail(): SentEmail {
  expect(sentEmails).toHaveLength(1);
  return sentEmails[0];
}

describe("maybeAlertUnassignedBooking against real Postgres", () => {
  it("a business with NO employees is never told to assign the lead to a teammate", async () => {
    const biz = await seedBusiness(db, "Solo HQ");
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    expect(outcome).toBe("sent_solo");

    const email = onlyEmail();
    const wholeEmail = `${email.subject}\n${email.text}`.toLowerCase();
    // The HQ-internal defect in one assertion: with no roster there is nobody
    // to assign to and the owner is on the hook by definition.
    expect(wholeEmail).not.toContain("assign");
    expect(wholeEmail).not.toContain("teammate");
    expect(wholeEmail).not.toContain("needs an owner");
    // It must still be a useful booking notice.
    expect(email.subject).toContain("Brett Douglas");
    expect(email.text).toContain("Friday, August 14, 2026 at 12:00 PM MST");
  });

  it("a roster of only INACTIVE members still counts as solo", async () => {
    const biz = await seedBusiness(db, "Everyone left");
    await addMember(biz, "Departed Dana", false);
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    expect(outcome).toBe("sent_solo");
    expect(`${onlyEmail().subject}\n${onlyEmail().text}`.toLowerCase()).not.toContain("assign");
  });

  it("a roster with nobody holding the lead keeps the needs-an-owner warning", async () => {
    const biz = await seedBusiness(db, "Team, unowned lead");
    await addMember(biz, "Dana Reyes");
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    expect(outcome).toBe("sent_unowned");
    const email = onlyEmail();
    expect(email.subject).toContain("needs an owner");
    expect(email.text.toLowerCase()).toContain("nobody is on the hook");

    const rows = await notificationsFor(biz);
    expect(rows.some((r) => r.kind === "unassigned_booking")).toBe(true);
  });

  it("a lead the contact row already owns names the assignee instead", async () => {
    const biz = await seedBusiness(db, "Team, owned lead");
    const dana = await addMember(biz, "Dana Reyes");
    await seedContact(db, biz, LEAD, {
      display_name: "Brett Douglas",
      owner_employee_id: dana
    });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    expect(outcome).toBe("sent_covered");
    const email = onlyEmail();
    expect(email.text).toContain("Dana Reyes");
    expect(email.text.toLowerCase()).not.toContain("nobody is on the hook");
  });

  it("the booking-page assignee wins over the contact owner", async () => {
    const biz = await seedBusiness(db, "Assignee beats owner");
    const dana = await addMember(biz, "Dana Reyes");
    const sam = await addMember(biz, "Sam Okafor");
    await seedContact(db, biz, LEAD, {
      display_name: "Brett Douglas",
      owner_employee_id: dana
    });

    const outcome = await maybeAlertUnassignedBooking(
      biz,
      bookingInput({ bookingAssigneeMemberId: sam })
    );

    expect(outcome).toBe("sent_covered");
    // Whoever holds the APPOINTMENT is who must show up.
    expect(onlyEmail().text).toContain("Sam Okafor");
    expect(onlyEmail().text).not.toContain("Dana Reyes");
  });

  it("ownership is found when the phone is an ALIAS, not the primary number", async () => {
    const biz = await seedBusiness(db, "Alias lead");
    const dana = await addMember(biz, "Dana Reyes");
    await seedContact(db, biz, "+16135550101", {
      display_name: "Brett Douglas",
      alias_e164s: [LEAD],
      owner_employee_id: dana
    });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    // Only a real PostgREST parses the `.or(...)` filter string that makes
    // this work; the chainable unit fake would pass either way.
    expect(outcome).toBe("sent_covered");
    expect(onlyEmail().text).toContain("Dana Reyes");
  });

  it("TWO contacts matching one number still alerts (maybeSingle would swallow it)", async () => {
    const biz = await seedBusiness(db, "Ambiguous number");
    const dana = await addMember(biz, "Dana Reyes");
    // The number is one contact's primary and another contact's alias, which
    // is ordinary after a merge. `.or(...)` matches BOTH rows.
    await seedContact(db, biz, LEAD, {
      display_name: "Brett Douglas",
      owner_employee_id: dana
    });
    await seedContact(db, biz, "+16135550102", {
      display_name: "Brett D (old)",
      alias_e164s: [LEAD]
    });

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    // The failure this pins: `.maybeSingle()` errors on multiple rows, the
    // catch swallows it, and the owner hears NOTHING about a real booking.
    expect(outcome).not.toBe("failed");
    expect(sentEmails.length).toBeGreaterThan(0);
    // The exact-number match is the authoritative one.
    expect(outcome).toBe("sent_covered");
    expect(onlyEmail().text).toContain("Dana Reyes");
  });

  it("the preference switched off sends nothing at all", async () => {
    const biz = await seedBusiness(db, "Alerts off");
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });
    const { error } = await db
      .from("notification_preferences")
      .insert({ business_id: biz, unassigned_booking_alerts: false });
    if (error) throw new Error(`prefs insert: ${error.message}`);

    const outcome = await maybeAlertUnassignedBooking(biz, bookingInput());

    expect(outcome).toBe("skipped_disabled");
    expect(sentEmails).toHaveLength(0);
    expect(await notificationsFor(biz)).toHaveLength(0);
  });

  it("the email links to the contact, not to a bare dashboard", async () => {
    const biz = await seedBusiness(db, "CTA check");
    await addMember(biz, "Dana Reyes");
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });

    await maybeAlertUnassignedBooking(biz, bookingInput());

    const email = onlyEmail();
    expect(email.html).toContain(`/dashboard/customers/${encodeURIComponent(LEAD)}`);
  });

  it("an AI-made booking still says the AI booked it; a page booking does not", async () => {
    const biz = await seedBusiness(db, "Attribution");
    await addMember(biz, "Dana Reyes");
    await seedContact(db, biz, LEAD, { display_name: "Brett Douglas" });

    await maybeAlertUnassignedBooking(biz, bookingInput({ surface: "sms" }));
    expect(onlyEmail().text).toContain("Your AI coworker booked");

    sentEmails = [];
    const biz2 = await seedBusiness(db, "Attribution page");
    await addMember(biz2, "Dana Reyes");
    await seedContact(db, biz2, LEAD, { display_name: "Brett Douglas" });

    await maybeAlertUnassignedBooking(biz2, bookingInput({ surface: "booking_page" }));
    // Brett booked himself. Saying the AI did it is the defect that started this.
    expect(onlyEmail().text).not.toContain("Your AI coworker booked");
    expect(onlyEmail().text.toLowerCase()).toContain("booking page");
  });
});
