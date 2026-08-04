/**
 * A booking made on the PUBLIC booking page, end to end against a real local
 * Postgres, asserting what the owner is actually told (Aug 3 2026).
 *
 * This is the layer the mocked unit suite cannot reach, because the defect is
 * one of ORDER, not of logic. `submitPublicBooking` fired the unassigned
 * -booking alert inside the booking write, then filed the contact and picked
 * the assignee afterwards. Every claim in the resulting email was therefore
 * evaluated against a world that did not exist yet:
 *
 *   - "No teammate owns this lead yet" was true by construction on every
 *     first-time visitor, because the contact row was written later.
 *   - It stayed true even on a `round_robin` page that assigned the booking
 *     and texted the assignee seconds afterwards.
 *   - "Your AI coworker booked ..." was said about a booking the visitor made
 *     themselves, because the page reused the AI surface tag.
 *
 * Platform mode (no calendar connection) is used deliberately: the ledger is
 * the calendar of record, so the whole path runs with no provider and no Zoom
 * (`createZoomMeetingForBooking` returns null without a connection).
 *
 * Safety: same guarded fetch as unassigned-booking-alert.itest.ts. Localhost
 * reaches the real stack, Resend and Telnyx are captured, everything else
 * throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb, SUPABASE_URL } from "./harness";

import { submitPublicBooking } from "@/lib/booking-page/service";

let db: SupabaseClient;

type SentEmail = { to: string; subject: string; text: string; html: string };
let sentEmails: SentEmail[] = [];
let sentSms: Array<{ to: string; text: string }> = [];

const realFetch = globalThis.fetch;

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
    sentSms.push({ to: String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ data: { id: `itest-sms-${randomUUID()}` } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  throw new Error(`itest tried to reach an unexpected host: ${url}`);
}

beforeAll(() => {
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

/**
 * A weekday inside the default 9-to-5 business hours, far enough out to clear
 * min_notice_minutes and inside max_advance_days. Fixed, not relative: a
 * date that drifts with the clock is a flaky test waiting to happen.
 */
const START_ISO = "2026-08-12T15:00:00.000Z"; // Wednesday, 3pm UTC
const VISITOR_PHONE = "+12187702372";
const VISITOR_EMAIL = "brett@example.com";

async function seedPage(
  businessId: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  const token = `ncb_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`.slice(
    0,
    68
  );
  const { error } = await db.from("booking_pages").insert({
    business_id: businessId,
    token,
    enabled: true,
    allowed_durations: [30],
    min_notice_minutes: 120,
    max_advance_days: 30,
    ...over
  });
  if (error) throw new Error(`seedPage: ${error.message}`);
  return token;
}

async function addMember(businessId: string, name: string): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({
      business_id: businessId,
      name,
      phone_e164: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
      active: true
    })
    .select("id")
    .single();
  if (error) throw new Error(`addMember: ${error.message}`);
  return (data as { id: string }).id;
}

/** A business in platform mode (no calendar connection), UTC clock. */
async function seedBusinessUtc(name: string): Promise<string> {
  const id = await seedBusiness(db, name);
  const { error } = await db.from("businesses").update({ timezone: "UTC" }).eq("id", id);
  if (error) throw new Error(`seedBusinessUtc: ${error.message}`);
  return id;
}

async function submit(token: string, over: Record<string, unknown> = {}) {
  return submitPublicBooking(token, {
    startIso: START_ISO,
    durationMinutes: 30,
    name: "Brett Douglas",
    phone: VISITOR_PHONE,
    email: VISITOR_EMAIL,
    ...over
  });
}

async function ownerAlerts(businessId: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, kind, summary, payload")
    .eq("business_id", businessId)
    .in("kind", ["unassigned_booking", "assigned_booking"]);
  if (error) throw new Error(`ownerAlerts: ${error.message}`);
  return (data ?? []) as Array<{
    delivery_channel: string;
    status: string;
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
  }>;
}

/**
 * The booking itself. A submit also writes a transient `slot:` claim row for
 * the same slot, so the attendee row is selected explicitly rather than
 * assuming the business has exactly one ledger row.
 */
async function ledgerRow(businessId: string) {
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("assignee_member_id, event_id, start_at, attendee_key")
    .eq("business_id", businessId)
    .eq("attendee_key", `phone:${VISITOR_PHONE}`)
    .maybeSingle();
  if (error) throw new Error(`ledgerRow: ${error.message}`);
  return data as { assignee_member_id: string | null; event_id: string | null } | null;
}

async function contactRow(businessId: string) {
  const { data, error } = await db
    .from("contacts")
    .select("customer_e164, display_name")
    .eq("business_id", businessId)
    .eq("customer_e164", VISITOR_PHONE)
    .maybeSingle();
  if (error) throw new Error(`contactRow: ${error.message}`);
  return data as { customer_e164: string } | null;
}

/** The owner-facing alert email, isolated from the visitor's confirmation. */
function ownerEmail(ownerAddress: string): SentEmail {
  const mine = sentEmails.filter((e) => e.to === ownerAddress);
  expect(mine).toHaveLength(1);
  return mine[0];
}

async function ownerAddress(businessId: string): Promise<string> {
  const { data } = await db.from("businesses").select("owner_email").eq("id", businessId).single();
  return (data as { owner_email: string }).owner_email;
}

describe("public booking page: what the owner is told", () => {
  it("a round-robin page tells the owner WHO has it, after the assignment exists", async () => {
    const biz = await seedBusinessUtc("Round robin shop");
    const dana = await addMember(biz, "Dana Reyes");
    const token = await seedPage(biz, { assignment_mode: "round_robin" });

    const res = await submit(token);
    expect(res.ok).toBe(true);

    // All three must be true at once. That is only possible if the alert runs
    // AFTER the contact is filed and the assignee is stamped.
    const ledger = await ledgerRow(biz);
    expect(ledger?.assignee_member_id).toBe(dana);
    expect(await contactRow(biz)).not.toBeNull();

    const alerts = await ownerAlerts(biz);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.kind === "assigned_booking")).toBe(true);

    const email = ownerEmail(await ownerAddress(biz));
    expect(email.text).toContain("Dana Reyes");
    expect(email.text.toLowerCase()).not.toContain("nobody is on the hook");
    expect(email.subject).not.toContain("needs an owner");
  });

  it("a business with no employees is never told to assign the booking", async () => {
    const biz = await seedBusinessUtc("Solo HQ");
    const token = await seedPage(biz);

    const res = await submit(token);
    expect(res.ok).toBe(true);

    const email = ownerEmail(await ownerAddress(biz));
    const whole = `${email.subject}\n${email.text}`.toLowerCase();
    expect(whole).not.toContain("assign");
    expect(whole).not.toContain("teammate");
    expect(whole).not.toContain("needs an owner");
    expect(email.text).toContain("Brett Douglas");
  });

  it("never claims the AI booked something the visitor booked themselves", async () => {
    const biz = await seedBusinessUtc("Attribution shop");
    await addMember(biz, "Dana Reyes");
    const token = await seedPage(biz, { assignment_mode: "any" });

    await submit(token);

    const email = ownerEmail(await ownerAddress(biz));
    expect(email.text).not.toContain("Your AI coworker booked");
    expect(email.text.toLowerCase()).toContain("booking page");
  });

  it("an unchanged resubmit does not alert the owner twice", async () => {
    const biz = await seedBusinessUtc("Resubmit shop");
    await addMember(biz, "Dana Reyes");
    const token = await seedPage(biz, { assignment_mode: "any" });

    await submit(token);
    const first = (await ownerAlerts(biz)).length;
    expect(first).toBeGreaterThan(0);

    await submit(token);
    expect((await ownerAlerts(biz)).length).toBe(first);
  });

  it("the owner email links to the contact page, not to a bare dashboard", async () => {
    const biz = await seedBusinessUtc("CTA shop");
    const token = await seedPage(biz);

    await submit(token);

    const email = ownerEmail(await ownerAddress(biz));
    expect(email.html).toContain(`/dashboard/customers/${encodeURIComponent(VISITOR_PHONE)}`);
  });
});
