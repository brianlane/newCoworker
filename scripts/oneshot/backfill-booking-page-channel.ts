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
 * How far apart the contact rollup and its booking may sit and still count
 * as the same event. The two writes are consecutive statements in
 * submitPublicBooking, so the real gap is seconds.
 *
 * The window is SYMMETRIC, which the first dry run forced. The obvious
 * reading is that the contact write always follows the booking write, and
 * that is what the ledger showed for +12187702372 (3.3s after). It is not
 * universal: +12092520704's contact rollup landed 41 SECONDS BEFORE its
 * booking row, because the ledger row is not stamped at the moment the
 * visitor submits. A one-directional window silently rejected a contact
 * whose booking-page row was sitting right there.
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
  created_at: string | null;
  total_interaction_count: number | null;
};

export type BookingRow = {
  attendee_key: string;
  booking_source: string | null;
  created_at: string;
};

export type Decision =
  | { retag: true; proof: "ledger"; bookingAt: string }
  | { retag: true; proof: "untouched-since-creation" }
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
    const gap = Math.abs(lastAt - bookedAt);
    if (gap > PROOF_WINDOW_MS) continue;
    if (!best || gap < best.gap) best = { at: booking.created_at, gap };
  }
  if (best) return { retag: true, proof: "ledger", bookingAt: best.at };

  // Second, INDEPENDENT proof, for the rows the ledger cannot speak to.
  // Not every booking-page contact has a matching ledger row: two of the
  // six live candidates have none at all (the oldest predate
  // booking_source being stamped). Their creation still proves it.
  //
  // ensureCapturedContact writes the "Booking Page" tag ONLY on the call
  // that CREATED the row, so the tag means the booking page created this
  // contact. If the row has exactly one interaction AND has not been
  // touched since creation (created_at == last_interaction_at), that one
  // interaction IS the creating booking, so it is also the last touch.
  //
  // Residual risk, accepted and small: an owner can type the same tag by
  // hand. To be wrongly retagged, a contact would have to be hand-tagged
  // "Booking Page", be on last_channel webchat, and have exactly one
  // interaction that is still its creating one. The cost if that happens
  // is one badge reading "booking page", and it is reversible.
  if (
    contact.total_interaction_count === 1 &&
    contact.created_at &&
    Date.parse(contact.created_at) === lastAt
  ) {
    return { retag: true, proof: "untouched-since-creation" };
  }

  return {
    retag: false,
    reason: "no booking-page booking near the last interaction, and the row has been touched since creation (later touch on another channel?)"
  };
}

/** Which proof licensed a retag, printed on every line so a run is auditable. */
export function describeProof(decision: Extract<Decision, { retag: true }>): string {
  return decision.proof === "ledger"
    ? `booked ${decision.bookingAt}`
    : "only interaction, untouched since creation";
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
    .select(
      "business_id, customer_e164, display_name, last_channel, last_interaction_at, created_at, total_interaction_count"
    )
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
    // Newest-first so a capped scan deterministically keeps the bookings
    // most likely to be somebody's last touch, instead of an arbitrary page.
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);
  if (bookingErr) {
    console.error(`calendar_booking_dedupe read failed: ${bookingErr.message}`);
    process.exit(1);
  }
  // A clipped booking scan is worse than a clipped contact scan: a contact
  // whose proof row fell outside the cap reads as "does not line up" and is
  // reported as a SKIP, which looks like a deliberate decision rather than
  // missing evidence. Say so loudly instead.
  if ((bookingRows ?? []).length >= SCAN_LIMIT) {
    console.warn(
      `WARNING: booking scan filled its ${SCAN_LIMIT}-row cap. Some SKIP lines below may be missing evidence rather than genuinely ineligible.`
    );
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
      console.log(`WOULD ${label}: webchat -> booking_page (${describeProof(decision)})`);
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
    console.log(`OK    ${label}: webchat -> booking_page (${describeProof(decision)})`);
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
