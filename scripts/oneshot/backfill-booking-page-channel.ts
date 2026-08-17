#!/usr/bin/env tsx
/**
 * One-shot: retag the contacts the booking page filed as `webchat`.
 *
 * Until migration 20260822160258 the public booking page had no channel of
 * its own, so `ensureCapturedContact` filed its visitors under `webchat` and
 * leaned on the "Booking Page" source tag for CRM scoping. That made every
 * reader of `last_channel` claim the visitor had chatted with the widget:
 * the contact badge ("LAST VIA WEBCHAT"), the CSV export, the MCP read tool,
 * the analytics channel breakdown, and buildCustomerPreamble, which tells
 * the model "last channel: webchat" for someone who only filled in a form.
 *
 * New rows are correct from the migration onward. This fixes the rows
 * already written.
 *
 * PROOF, NOT ASSUMPTION. The tag says where a contact came FROM, which is
 * not the same claim as `last_channel`, which is the LAST touch. A visitor
 * who booked and later genuinely used the chat widget is correctly `webchat`
 * and must be left alone. So a row is only retagged when its last
 * interaction is provably the booking itself: a `calendar_booking_dedupe`
 * row with booking_source='booking_page' for that attendee, created just
 * before `last_interaction_at` (the contact write follows the booking write
 * by a few seconds: 3.3s for the contact that prompted this). Anything
 * else is reported and skipped, never guessed at.
 *
 * Idempotent (rows already on `booking_page` are not candidates), dry-run by
 * default, records the apply in applied_oneshots. Global: it sweeps every
 * tenant, so the ledger row carries a null business_id.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/backfill-booking-page-channel.ts            # dry run
 *   npx tsx scripts/oneshot/backfill-booking-page-channel.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 *
 * Exit codes: 0 retagged/no-op/dry-run · 1 Supabase error · 2 bad env/arg.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

/** The tag the booking page stamps on contacts it creates. */
export const BOOKING_PAGE_TAG = "Booking Page";

/**
 * How long after a booking the contact rollup may land and still count as
 * the same event. The two writes are consecutive statements in
 * submitPublicBooking, so the real gap is seconds; this is generous enough
 * to survive a slow calendar round trip without ever spanning a separate
 * visit.
 */
export const PROOF_WINDOW_MS = 2 * 60 * 1000;

/**
 * Row cap per query. PostgREST silently truncates an unbounded select at
 * 1000 rows, which would read as "nothing left to fix", so the caps are
 * explicit and a filled scan is reported rather than trusted.
 */
export const SCAN_LIMIT = 1000;

export type CandidateContact = {
  business_id: string;
  customer_e164: string;
  display_name: string | null;
  last_channel: string | null;
  last_interaction_at: string | null;
};

export type BookingRow = {
  attendee_key: string;
  booking_source: string | null;
  created_at: string;
};

export type Decision =
  | { retag: true; bookingAt: string }
  | { retag: false; reason: string };

/**
 * Is this contact's LAST interaction provably the booking page?
 *
 * Pure so the rule is pinned by tests rather than re-read off a live run.
 */
export function decideRetag(
  contact: CandidateContact,
  bookings: readonly BookingRow[]
): Decision {
  if (!contact.last_interaction_at) {
    return { retag: false, reason: "contact has no last_interaction_at" };
  }
  const lastAt = Date.parse(contact.last_interaction_at);
  if (Number.isNaN(lastAt)) {
    return { retag: false, reason: `unparseable last_interaction_at ${contact.last_interaction_at}` };
  }

  const key = `phone:${contact.customer_e164}`;
  let best: { at: string; gap: number } | null = null;
  for (const booking of bookings) {
    if (booking.attendee_key !== key) continue;
    if (booking.booking_source !== "booking_page") continue;
    const bookedAt = Date.parse(booking.created_at);
    if (Number.isNaN(bookedAt)) continue;
    // The contact write FOLLOWS the booking write, never precedes it.
    const gap = lastAt - bookedAt;
    if (gap < 0 || gap > PROOF_WINDOW_MS) continue;
    if (!best || gap < best.gap) best = { at: booking.created_at, gap };
  }

  if (!best) {
    return {
      retag: false,
      reason: "last interaction does not line up with a booking-page booking (later touch on another channel?)"
    };
  }
  return { retag: true, bookingAt: best.at };
}

type Args = { apply: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: contactRows, error: contactErr } = await db
    .from("contacts")
    .select("business_id, customer_e164, display_name, last_channel, last_interaction_at")
    .eq("last_channel", "webchat")
    .contains("tags", [BOOKING_PAGE_TAG])
    .limit(SCAN_LIMIT);
  if (contactErr) {
    console.error(`contacts read failed: ${contactErr.message}`);
    process.exit(1);
  }
  const candidates = (contactRows ?? []) as CandidateContact[];
  if (candidates.length >= SCAN_LIMIT) {
    console.warn(`WARNING: contact scan filled its ${SCAN_LIMIT}-row cap; re-run after applying.`);
  }
  console.log(`candidates (last_channel=webchat, tagged "${BOOKING_PAGE_TAG}"): ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("nothing to do");
    return;
  }

  const { data: bookingRows, error: bookingErr } = await db
    .from("calendar_booking_dedupe")
    .select("business_id, attendee_key, booking_source, created_at")
    .eq("booking_source", "booking_page")
    .in("business_id", [...new Set(candidates.map((c) => c.business_id))])
    .limit(SCAN_LIMIT);
  if (bookingErr) {
    console.error(`calendar_booking_dedupe read failed: ${bookingErr.message}`);
    process.exit(1);
  }
  const bookingsByBusiness = new Map<string, BookingRow[]>();
  for (const row of (bookingRows ?? []) as Array<BookingRow & { business_id: string }>) {
    const list = bookingsByBusiness.get(row.business_id) ?? [];
    list.push(row);
    bookingsByBusiness.set(row.business_id, list);
  }

  const retagged: string[] = [];
  const skipped: string[] = [];
  for (const contact of candidates) {
    const label = `${contact.business_id} ${contact.customer_e164} (${contact.display_name ?? "no name"})`;
    const decision = decideRetag(contact, bookingsByBusiness.get(contact.business_id) ?? []);
    if (!decision.retag) {
      console.log(`SKIP  ${label}: ${decision.reason}`);
      skipped.push(contact.customer_e164);
      continue;
    }
    if (!args.apply) {
      console.log(`WOULD ${label}: webchat -> booking_page (booked ${decision.bookingAt})`);
      retagged.push(contact.customer_e164);
      continue;
    }
    // Compare-and-swap on last_channel: a PostgREST update matching zero
    // rows succeeds silently, so the .select() is what proves the write
    // landed and that nothing moved the channel underneath us.
    const { data: updated, error: updateErr } = await db
      .from("contacts")
      .update({ last_channel: "booking_page", updated_at: new Date().toISOString() })
      .eq("business_id", contact.business_id)
      .eq("customer_e164", contact.customer_e164)
      .eq("last_channel", "webchat")
      .select("customer_e164");
    if (updateErr) {
      console.error(`update failed for ${label}: ${updateErr.message}`);
      process.exit(1);
    }
    if (!updated || updated.length === 0) {
      console.log(`SKIP  ${label}: channel changed under us, left alone`);
      skipped.push(contact.customer_e164);
      continue;
    }
    console.log(`OK    ${label}: webchat -> booking_page (booked ${decision.bookingAt})`);
    retagged.push(contact.customer_e164);
  }

  console.log(
    `\n${args.apply ? "retagged" : "would retag"}: ${retagged.length} · skipped: ${skipped.length}`
  );
  if (!args.apply) {
    console.log("dry run: pass --apply to write");
    return;
  }
  if (retagged.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId: null,
      details: { retagged, skipped }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
