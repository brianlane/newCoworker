#!/usr/bin/env tsx
/**
 * Cancel a ghost calendar booking: delete ONE provider event (Microsoft
 * Graph via the tenant's Nango connection — the same `/v1.0/me/events/{id}`
 * DELETE the production cancel core uses) and drop its
 * `calendar_booking_dedupe` ledger row.
 *
 * Why this exists (Truly Insurance, Jul 21 2026): the SMS assistant booked
 * +16136067906 for Wed Jul 22 9:00 AM ET, mislabeled it "today", disowned it
 * as "already passed", and booked a second slot at 12:00 PM ET — leaving an
 * orphaned 9:00 AM event on the broker's Outlook that the customer is not
 * expecting. Deleting the Graph event sends the attendee ONE cancellation
 * email (correct: they hold the 9 AM invite), and dropping the ledger row
 * keeps duplicate checks honest.
 *
 * Dry-run by default (verifies the event exists and prints it); pass
 * --apply to delete. The event id AND its expected start must both match
 * the ledger row so a typo can never delete the wrong meeting.
 *
 *   tsx debug/cancel-ghost-booking.ts \
 *     --business <uuid> --attendee "phone:+16136067906" \
 *     --start 2026-07-22T13:00:00Z [--apply]
 *
 * Fleet audit mode — report every attendee holding 2+ upcoming confirmed
 * bookings (the duplicate class this incident belongs to), no writes:
 *
 *   tsx debug/cancel-ghost-booking.ts --audit
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { getNangoClient } from "../src/lib/nango/server.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");

const db = createClient(url, key, { auth: { persistSession: false } });

const APPLY = process.argv.includes("--apply");
const AUDIT = process.argv.includes("--audit");
function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type LedgerRow = {
  id: string;
  business_id: string;
  attendee_key: string;
  start_at: string;
  event_id: string | null;
};

async function audit(): Promise<void> {
  const { data, error } = await db
    .from("calendar_booking_dedupe")
    .select("business_id, attendee_key, start_at, event_id")
    .not("event_id", "is", null)
    .gte("start_at", new Date().toISOString())
    .order("business_id")
    .order("attendee_key")
    .order("start_at");
  if (error) throw new Error(`audit read: ${error.message}`);
  const rows = (data ?? []) as LedgerRow[];

  const byAttendee = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const k = `${r.business_id}|${r.attendee_key}`;
    byAttendee.set(k, [...(byAttendee.get(k) ?? []), r]);
  }
  const dupes = [...byAttendee.entries()].filter(([, v]) => v.length > 1);
  if (dupes.length === 0) {
    console.log(`No attendee holds 2+ upcoming confirmed bookings (${rows.length} upcoming rows scanned).`);
    return;
  }
  const bizIds = [...new Set(dupes.map(([k]) => k.split("|")[0]))];
  const { data: bizRows } = await db.from("businesses").select("id, name").in("id", bizIds);
  const bizName = new Map((bizRows ?? []).map((b) => [b.id as string, b.name as string]));
  console.log(`${dupes.length} attendee(s) with 2+ upcoming confirmed bookings:`);
  for (const [k, v] of dupes) {
    const [biz, attendee] = k.split("|");
    console.log(`\n  ${bizName.get(biz) ?? biz} — ${attendee}`);
    for (const r of v) {
      console.log(`    ${r.start_at}  event ${r.event_id!.slice(0, 12)}…${r.event_id!.slice(-8)}`);
    }
  }
}

async function cancelGhost(): Promise<void> {
  const businessId = argOf("--business");
  const attendeeKey = argOf("--attendee");
  const startIsoArg = argOf("--start");
  if (!businessId || !attendeeKey || !startIsoArg) {
    throw new Error("Required: --business <uuid> --attendee <key> --start <ISO> (or --audit)");
  }
  if (!process.env.NANGO_SECRET_KEY) throw new Error("Missing NANGO_SECRET_KEY");
  const startIso = new Date(startIsoArg).toISOString();

  // 1. The ledger row is the source of truth for WHICH event dies: the
  //    (business, attendee, start) triple must resolve to exactly one
  //    confirmed row. No free-form event-id input — a typo'd id could
  //    delete a legitimate meeting.
  const { data: rowRaw, error: rowErr } = await db
    .from("calendar_booking_dedupe")
    .select("id, business_id, attendee_key, start_at, event_id")
    .eq("business_id", businessId)
    .eq("attendee_key", attendeeKey)
    .eq("start_at", startIso)
    .maybeSingle();
  if (rowErr) throw new Error(`ledger read: ${rowErr.message}`);
  const row = rowRaw as LedgerRow | null;
  if (!row) throw new Error(`No ledger row for ${attendeeKey} @ ${startIso}`);
  if (!row.event_id) throw new Error("Ledger row has no confirmed event_id (nothing to cancel)");
  console.log(`Ledger row ${row.id}`);
  console.log(`  attendee ${row.attendee_key}, start ${row.start_at}`);
  console.log(`  event    ${row.event_id}`);

  // 2. Resolve the tenant's Microsoft connection (same table the production
  //    proxy binding checks) and verify the event actually exists.
  const { data: conns, error: connErr } = await db
    .from("workspace_oauth_connections")
    .select("provider_config_key, connection_id")
    .eq("business_id", businessId);
  if (connErr) throw new Error(`connections read: ${connErr.message}`);
  const conn = (conns ?? []).find((c) =>
    /microsoft|outlook/i.test(String(c.provider_config_key))
  );
  if (!conn) {
    throw new Error(
      `No Microsoft workspace connection for ${businessId} — found: ${(conns ?? [])
        .map((c) => c.provider_config_key)
        .join(", ") || "(none)"}`
    );
  }
  console.log(`  via Nango ${conn.provider_config_key} / ${String(conn.connection_id).slice(-6)}`);

  const nango = getNangoClient();
  const eventPath = `/v1.0/me/events/${encodeURIComponent(row.event_id)}`;
  const got = await nango.proxy({
    method: "GET",
    endpoint: `${eventPath}?$select=subject,start,end,attendees,isCancelled`,
    providerConfigKey: String(conn.provider_config_key),
    connectionId: String(conn.connection_id),
    // Graph otherwise reports start.dateTime as naive local time in the
    // event's own (named) timezone, which cannot be compared to the ledger
    // instant without a zone conversion — force UTC so the start guard
    // below ALWAYS runs (Bugbot Medium on PR #814).
    headers: { Prefer: 'outlook.timezone="UTC"' }
  });
  const ev = got.data as {
    subject?: string;
    start?: { dateTime?: string; timeZone?: string };
    end?: { dateTime?: string };
    isCancelled?: boolean;
    attendees?: Array<{ emailAddress?: { address?: string } }>;
  };
  console.log(`\nProvider event:`);
  console.log(`  subject   ${ev.subject ?? "(none)"}`);
  console.log(`  start     ${ev.start?.dateTime ?? "?"} (${ev.start?.timeZone ?? "?"})`);
  console.log(`  attendees ${(ev.attendees ?? []).map((a) => a.emailAddress?.address).join(", ") || "(none)"}`);
  console.log(`  cancelled ${ev.isCancelled === true}`);

  // Guard: the provider event's start must equal the ledger start we
  // targeted — a moved event means the ledger drifted; stop and look. The
  // Prefer header above pins the response to UTC; if Graph still answers in
  // another zone (or with no start at all) the start CANNOT be verified, so
  // refuse rather than guess (fail closed — Bugbot Medium on PR #814).
  if ((ev.start?.timeZone ?? "") !== "UTC" || !ev.start?.dateTime) {
    throw new Error(
      `Provider start not verifiable (timeZone=${ev.start?.timeZone ?? "?"}) — refusing`
    );
  }
  const providerStart = new Date(
    ev.start.dateTime.endsWith("Z") || /[+-]\d\d:\d\d$/.test(ev.start.dateTime)
      ? ev.start.dateTime
      : `${ev.start.dateTime}Z`
  ).toISOString();
  if (providerStart !== startIso) {
    throw new Error(`Provider start ${providerStart} != ledger start ${startIso} — refusing`);
  }

  if (!APPLY) {
    console.log("\nDry-run: event verified. Re-run with --apply to delete it + the ledger row.");
    return;
  }

  // 3. Delete the provider event (Graph emails the attendee ONE
  //    cancellation — they hold this invite), then the ledger row.
  await nango.proxy({
    method: "DELETE",
    endpoint: eventPath,
    providerConfigKey: String(conn.provider_config_key),
    connectionId: String(conn.connection_id)
  });
  console.log("\nProvider event deleted.");

  const { error: delErr } = await db.from("calendar_booking_dedupe").delete().eq("id", row.id);
  if (delErr) throw new Error(`ledger delete (event already gone!): ${delErr.message}`);
  console.log("Ledger row deleted. Done.");
}

(AUDIT ? audit() : cancelGhost()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
