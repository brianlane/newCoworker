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
 * Safety: the shared fetch guard. Localhost reaches the real stack, Resend
 * and Telnyx are captured, and every other host throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb, SUPABASE_URL } from "./harness";
import { createFetchGuard, useLocalStackEnv } from "./guarded-fetch";

import { submitPublicBooking } from "@/lib/booking-page/service";

let db: SupabaseClient;

/** Outbound sends captured instead of made; anything unexpected throws. */
const guard = createFetchGuard();
let restoreFetch: () => void;

beforeAll(() => {
  useLocalStackEnv(SUPABASE_URL);
  restoreFetch = guard.install();
  db = serviceDb();
});

afterAll(() => {
  restoreFetch();
});

beforeEach(() => {
  guard.reset();
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

/**
 * One row per ALERT, not per row written: a dispatch writes a `notifications`
 * row for every channel it attempted (dashboard, email, sms, whatsapp), so
 * counting rows would count channels. The email row is written exactly once
 * per dispatch and these businesses all have an owner_email.
 */
async function ownerAlerts(businessId: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, kind, summary, payload")
    .eq("business_id", businessId)
    .eq("delivery_channel", "email")
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
function ownerEmail(ownerAddress: string) {
  const mine = guard.emails.filter((e) => e.to === ownerAddress);
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

  it("a resubmit that FILLS a missing assignment is the first moment there is somebody to name", async () => {
    const biz = await seedBusinessUtc("Gap fill shop");
    const dana = await addMember(biz, "Dana Reyes");
    // `any` records no assignee, which is how a booking ends up with nobody
    // named while a roster exists.
    const token = await seedPage(biz, { assignment_mode: "any" });

    expect((await submit(token)).ok).toBe(true);
    expect((await ledgerRow(biz))?.assignee_member_id).toBeNull();
    const afterFirst = await ownerAlerts(biz);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].kind).toBe("unassigned_booking");

    // The owner switches the page to round robin. The retry repairs the
    // assignment, and the owner hears who has it, which they could not have
    // been told before now.
    await db
      .from("booking_pages")
      .update({ assignment_mode: "round_robin" })
      .eq("business_id", biz);
    guard.reset();
    expect((await submit(token)).ok).toBe(true);
    expect((await ledgerRow(biz))?.assignee_member_id).toBe(dana);

    const afterRetry = await ownerAlerts(biz);
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry.filter((a) => a.kind === "assigned_booking")).toHaveLength(1);
    expect(ownerEmail(await ownerAddress(biz)).text).toContain("Dana Reyes");
  });

  it("a resubmit still pages the owner when the first request died before alerting", async () => {
    const biz = await seedBusinessUtc("Crashed mid-booking");
    const token = await seedPage(biz);

    expect((await submit(token)).ok).toBe(true);
    expect(await ownerAlerts(biz)).toHaveLength(1);

    // Reproduce the crash window: the booking is durable, but the request
    // died before the alert, so the claim was never taken and nobody was
    // told. The appointment exists and no human knows about it.
    await db
      .from("calendar_booking_dedupe")
      .update({ owner_alerted_at: null })
      .eq("business_id", biz)
      .eq("attendee_key", `phone:${VISITOR_PHONE}`);
    await db.from("notifications").delete().eq("business_id", biz);
    guard.reset();

    // The visitor retries. This is the only thing that will ever tell the
    // owner the appointment is there.
    expect((await submit(token)).ok).toBe(true);
    expect(await ownerAlerts(biz)).toHaveLength(1);
    expect(ownerEmail(await ownerAddress(biz)).text).toContain("Brett Douglas");

    // And a further resubmit, with the claim now taken, stays quiet.
    guard.reset();
    expect((await submit(token)).ok).toBe(true);
    expect(await ownerAlerts(biz)).toHaveLength(1);
  });

  it("the owner email links to the contact page, not to a bare dashboard", async () => {
    const biz = await seedBusinessUtc("CTA shop");
    const token = await seedPage(biz);

    await submit(token);

    const email = ownerEmail(await ownerAddress(biz));
    expect(email.html).toContain(`/dashboard/customers/${encodeURIComponent(VISITOR_PHONE)}`);
  });
});
