/**
 * Provider-neutral `appointment_booked` goal firing.
 *
 * The fan-out here was born in the Calendly booking-goal sweep
 * (calendly-booking-goals.ts) and is now shared by every off-platform
 * booking observer — the Calendly sweep/webhook/precheck AND the Vagaro
 * webhook/precheck — so the providers cannot drift:
 *
 *   - a booked person's phone (normalized to E.164) and email both seed the
 *     firing set; emails resolve through the business's contacts to that
 *     contact's primary number (a booking form often collects email but no
 *     phone);
 *   - every seed number is fanned out over its matched contact row's
 *     primary + merged aliases (the same fan-out the update_contact tag
 *     hook does — runs match the EXACT number they were triggered with,
 *     which after a profile merge may be any of them);
 *   - `applyGoalEvent` fires once per unique number, fast-forwarding parked
 *     runs past their remaining nudges.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { findContactsByEmails } from "@/lib/db/contact-emails";
import { ingestBooking } from "@/lib/memory/graph-deterministic";
import { logger } from "@/lib/logger";
import { applyGoalEvent } from "../../../supabase/functions/_shared/ai_flows/goal_events";
import {
  isE164,
  normalizeNanpToE164
} from "../../../supabase/functions/_shared/ai_flows/engine";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * A booked person's phone as a provider reports it → E.164 (already-E.164
 * kept as-is, loose NANP normalized, anything else null) — the same
 * tolerance as fireGoalEvent's phone handling.
 */
export function bookingPhoneE164(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return isE164(trimmed) ? trimmed : normalizeNanpToE164(trimmed);
}

/**
 * One booked person's identity as an off-platform booking observer sees it.
 * `phone` may be raw provider formatting (normalized here); `email` is
 * matched case-insensitively against the business's contacts.
 */
export type BookingIdentity = {
  phone?: string | null;
  email?: string | null;
};

/**
 * The contact row's full number set for one seed number (primary + merged
 * aliases + the seed itself), for the exact-match fan-out. Best-effort: a
 * lookup failure degrades to just the seed number. Exported for the
 * backfill one-shot's dry-run preview (scripts/oneshot).
 */
export async function contactNumbersFor(
  db: SupabaseClient,
  businessId: string,
  seedE164: string
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("contacts")
      .select("customer_e164, alias_e164s")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${seedE164},alias_e164s.cs.{${seedE164}}`)
      .maybeSingle();
    if (error) {
      logger.warn("booking goal fire: contact number union failed", {
        businessId,
        error: error.message
      });
      return [seedE164];
    }
    const row = data as { customer_e164?: string | null; alias_e164s?: string[] | null } | null;
    return [
      ...new Set(
        [seedE164, row?.customer_e164 ?? "", ...(row?.alias_e164s ?? [])].filter(Boolean)
      )
    ];
  } catch (err) {
    logger.warn("booking goal fire: contact number union threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [seedE164];
  }
}

export type BookingGoalFireDeps = {
  /** Injectable goal applier (tests). */
  applyGoal?: typeof applyGoalEvent;
  /** Injectable email→contact resolver (tests). */
  findByEmails?: typeof findContactsByEmails;
  /** Injectable knowledge-graph booking ingest (tests). */
  ingestBookingEvent?: typeof ingestBooking;
};

export type BookingGoalFireResult = {
  /** applyGoalEvent invocations (unique numbers fired). */
  goalsFired: number;
  /** Runs fast-forwarded to their goal step. */
  jumpedRuns: number;
};

/**
 * Booked identities → appointment_booked goal events. The provider-facing
 * wrappers (Calendly invitees, Vagaro webhook payloads) map their shapes to
 * `BookingIdentity` and delegate here, so double-observation between any
 * two observers is a benign no-op (a jumped run has no matching goal ahead
 * anymore).
 */
export async function fireBookingGoalsForIdentities(
  db: SupabaseClient,
  businessId: string,
  identities: BookingIdentity[],
  deps: BookingGoalFireDeps = {}
): Promise<BookingGoalFireResult> {
  const applyGoal = deps.applyGoal ?? applyGoalEvent;
  const findByEmails = deps.findByEmails ?? findContactsByEmails;

  const seedNumbers = new Set<string>();
  const seedEmails = new Set<string>();
  for (const identity of identities) {
    const phone = bookingPhoneE164(identity.phone ?? undefined);
    if (phone) seedNumbers.add(phone);
    const email = (identity.email ?? "").trim().toLowerCase();
    if (email) seedEmails.add(email);
  }

  // Email → contact primary number (one contacts scan per call).
  if (seedEmails.size > 0) {
    const linked = await findByEmails(businessId, [...seedEmails], db);
    for (const link of linked.values()) seedNumbers.add(link.customerE164);
  }

  // Fan out over the matched contact rows' full number sets, then fire.
  const fireNumbers = new Set<string>();
  for (const seed of seedNumbers) {
    for (const n of await contactNumbersFor(db, businessId, seed)) fireNumbers.add(n);
  }
  const result: BookingGoalFireResult = { goalsFired: 0, jumpedRuns: 0 };
  for (const number of fireNumbers) {
    result.goalsFired += 1;
    const { jumpedRuns } = await applyGoal(db, businessId, number, {
      kind: "appointment_booked"
    });
    result.jumpedRuns += jumpedRuns;
  }

  // Knowledge graph (kg-source: booking): the calendar system is
  // authoritative that this person booked. One ingest per ORIGINAL identity
  // (not the alias fan-out — dedupe happens in resolution anyway); a
  // phone-only identity creates/resolves a phone-named node that later
  // contact ingests enrich. Never-throws, mode-gated inside.
  /* c8 ignore next -- production default; tests inject */
  const ingest = deps.ingestBookingEvent ?? ingestBooking;
  const bookedOn = new Date().toISOString().slice(0, 10);
  for (const identity of identities) {
    const phone = bookingPhoneE164(identity.phone ?? undefined);
    const email = (identity.email ?? "").trim().toLowerCase();
    if (!phone && !email) continue;
    await ingest(businessId, {
      name: null,
      phoneE164: phone,
      email: email || null,
      detail: `appointment booked (${bookedOn})`
    });
  }

  return result;
}
