#!/usr/bin/env tsx
/**
 * Fire the unassigned-booking owner alert (PR #828's fan-out) for ONE
 * existing booking, through the REAL production core
 * (src/lib/calendar-tools/unassigned-booking-alert.ts) — same contact
 * ownership check, same preference gate, same dispatcher.
 *
 * Why: the fan-out fires at BOOKING time, and the booking that motivated it
 * (Truly / Shabir, Wed Jul 22 12:00 PM ET) predates the deploy — so the
 * owner was never paged. This one-shot delivers that page retroactively and
 * doubles as the live verification of the new path.
 *
 * Dry-run by default (prints the resolved state and the copy that would
 * go out); --apply sends for real and prints the notification rows the
 * dispatcher wrote.
 *
 *   tsx debug/fire-unassigned-booking-alert.ts \
 *     --business <uuid> --phone +1613... --start 2026-07-22T16:00:00Z \
 *     --start-local "Wednesday, July 22, 2026 at 12:00 PM EDT" \
 *     --name "..." --email x@y.z --summary "..." --event-id AAMk... [--apply]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const APPLY = process.argv.includes("--apply");

const businessId = argOf("--business");
const phone = argOf("--phone");
const startIso = argOf("--start");
const startLocal = argOf("--start-local");
const name = argOf("--name");
const email = argOf("--email");
const summary = argOf("--summary");
const eventId = argOf("--event-id");
if (!businessId || !phone || !startIso || !startLocal || !name || !summary) {
  throw new Error(
    "Required: --business --phone --start --start-local --name --summary (optional: --email --event-id --apply)"
  );
}

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("Missing Supabase env");
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Read-only preview of the two gates the core will apply.
  const { data: contact } = await db
    .from("contacts")
    .select("owner_employee_id, display_name")
    .eq("business_id", businessId!)
    .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
    .maybeSingle();
  const { data: prefs } = await db
    .from("notification_preferences")
    .select("unassigned_booking_alerts, phone_number, alert_email, sms_urgent, email_urgent, dashboard_alerts")
    .eq("business_id", businessId!)
    .maybeSingle();
  console.log("contact:", contact ?? "(none — unowned by definition)");
  console.log("prefs:", prefs ?? "(no row — defaults, alert enabled)");

  if (!APPLY) {
    console.log(`\nDry-run. Would page the owner:\n  Unassigned booking: ${name} (${phone}) — ${startLocal}`);
    console.log("Re-run with --apply to send.");
    return;
  }

  const { maybeAlertUnassignedBooking } = await import(
    "../src/lib/calendar-tools/unassigned-booking-alert.ts"
  );
  const outcome = await maybeAlertUnassignedBooking(businessId!, {
    attendeeName: name!,
    attendeePhone: phone,
    attendeeEmail: email,
    startIso: new Date(startIso!).toISOString(),
    startLocal: startLocal!,
    summary: summary!,
    eventId: eventId,
    surface: "sms"
  });
  console.log(`\noutcome: ${outcome}`);

  const { data: rows } = await db
    .from("notifications")
    .select("delivery_channel, status, summary, created_at")
    .eq("business_id", businessId!)
    .eq("kind", "unassigned_booking")
    .order("created_at", { ascending: false })
    .limit(6);
  console.log("notification rows:");
  for (const r of rows ?? []) {
    console.log(
      `  ${(r as { delivery_channel: string }).delivery_channel}: ${(r as { status: string }).status} — ${(r as { summary: string }).summary}`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
