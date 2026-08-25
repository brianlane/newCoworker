/**
 * Provider-neutral `appointment_booked` goal firing.
 *
 * The fan-out here was born in the Calendly booking-goal sweep
 * (calendly-booking-goals.ts) and is now shared by every off-platform
 * booking observer, the Calendly sweep/webhook/precheck AND the Vagaro
 * webhook/precheck, so the providers cannot drift:
 *
 *   - a booked person's phone (normalized to E.164) and email both seed the
 *     firing set; emails resolve through the business's contacts to that
 *     contact's primary number (a booking form often collects email but no
 *     phone);
 *   - every seed number is fanned out over its matched contact row's
 *     primary + merged aliases (the same fan-out the update_contact tag
 *     hook does, runs match the EXACT number they were triggered with,
 *     which after a profile merge may be any of them);
 *   - `applyGoalEvent` fires once per unique number, fast-forwarding parked
 *     runs past their remaining nudges.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { findContactsByEmails } from "@/lib/db/contact-emails";
import { ingestBooking } from "@/lib/memory/graph-deterministic";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import { applyGoalEvent } from "../../../supabase/functions/_shared/ai_flows/goal_events";
import {
  isE164,
  normalizeNanpToE164
} from "../../../supabase/functions/_shared/ai_flows/engine";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * A booked person's phone as a provider reports it → E.164 (already-E.164
 * kept as-is, loose NANP normalized, anything else null), the same
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
  /**
   * The booked person's name, used ONLY by the last-resort fallback below
   * when phone and email both fail to identify them.
   */
  name?: string | null;
};

/**
 * Statuses whose runs are still able to send. The name fallback is scoped to
 * these on purpose: see {@link activeRunNumbersByLeadName}.
 */
const LIVE_RUN_STATUSES = ["awaiting_reply", "queued", "running"] as const;

/** Bound on the live-run scan; a business has a handful of parked runs. */
const LIVE_RUN_SCAN_LIMIT = 500;

/**
 * Collapse a name for comparison: trimmed, whitespace-collapsed, lowercased.
 * Returns null for anything with fewer than two tokens.
 *
 * The two-token rule is the safety property, not a nicety. Real bookings
 * arrive as "Ahmet", "Joy", "Arif", "Minh" (all live KYP Ads bookings in
 * August 2026), and matching a lead on a bare first name would collide
 * constantly.
 */
export function normalizeLeadName(raw: string | null | undefined): string | null {
  const collapsed = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!collapsed) return null;
  return collapsed.split(" ").length >= 2 ? collapsed : null;
}

/**
 * Last-resort identification: the lead numbers of LIVE runs whose
 * `lead_name` equals this booking's name.
 *
 * Why this exists. A lead who books under a different email than their lead
 * form captured, with no phone on the booking, is invisible to both
 * identification paths: the precheck narrows Calendly by the contact's
 * email and falls back to the invitee's SMS-reminder number, and the seeding
 * above resolves the booking's email through contacts. Patricia Jones
 * (2026-08-19) booked as kissmediagroup@gmail.com with no phone while her
 * lead record said paojones@hotmail.com, and the nudge ladder sold to her
 * for three days after she had already booked. Four of KYP Ads' 37 August
 * bookings had that same mismatch.
 *
 * Why scoping to LIVE runs is what makes it safe. This can only ever reach
 * someone who has a run that is still able to message them, so a wrong match
 * cannot create a contact, start a flow, assign an owner, or touch anyone
 * who is not mid-ladder. The worst case is that we STOP nudging a lead we
 * could have kept nudging, which is a far better error than the one it
 * replaces: continuing to sell to someone who already booked.
 *
 * Names are compared in JS after one bounded scan, exact case-insensitive
 * equality, the same shape as findContactsByEmails, so no ILIKE wildcard can
 * widen the match.
 */
export async function activeRunNumbersByLeadName(
  db: SupabaseClient,
  businessId: string,
  name: string | null | undefined
): Promise<string[]> {
  const wanted = normalizeLeadName(name);
  if (!wanted) return [];
  try {
    const { data, error } = await db
      .from("ai_flow_runs")
      .select("context")
      .eq("business_id", businessId)
      .in("status", [...LIVE_RUN_STATUSES])
      .limit(LIVE_RUN_SCAN_LIMIT);
    if (error) {
      logger.warn("booking goal fire: live-run name scan failed", {
        businessId,
        error: error.message
      });
      return [];
    }
    const numbers = new Set<string>();
    for (const row of (data ?? []) as Array<{ context?: { vars?: Record<string, unknown> } }>) {
      const vars = row.context?.vars ?? {};
      if (normalizeLeadName(String(vars.lead_name ?? "")) !== wanted) continue;
      const phone = bookingPhoneE164(String(vars.lead_phone ?? ""));
      if (phone) numbers.add(phone);
    }
    return [...numbers];
  } catch (err) {
    logger.warn("booking goal fire: live-run name scan threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

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
  /** Injectable audit-log writer (tests). */
  recordLog?: typeof recordSystemLog;
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
  const recordAudit = deps.recordLog ?? recordSystemLog;

  const seedNumbers = new Set<string>();
  const seedEmails = new Set<string>();
  for (const identity of identities) {
    const phone = bookingPhoneE164(identity.phone ?? undefined);
    if (phone) seedNumbers.add(phone);
    const email = (identity.email ?? "").trim().toLowerCase();
    if (email) seedEmails.add(email);
  }

  // Email → contact primary number (one contacts scan per call).
  const linkedEmails =
    seedEmails.size > 0 ? await findByEmails(businessId, [...seedEmails], db) : new Map();
  for (const link of linkedEmails.values()) seedNumbers.add(link.customerE164);

  // Last resort, per identity: an identity that phone and email BOTH failed
  // to place is matched by name against live runs. Deliberately last, so it
  // never competes with a real identifier, and per-identity, so one
  // well-identified invitee on a multi-invitee booking does not suppress the
  // fallback for an unidentified one.
  const nameMatched: Array<{ name: string; number: string }> = [];
  for (const identity of identities) {
    if (bookingPhoneE164(identity.phone ?? undefined)) continue;
    const email = (identity.email ?? "").trim().toLowerCase();
    if (email && linkedEmails.has(email)) continue;
    const name = identity.name ?? null;
    if (!name) continue;
    for (const number of await activeRunNumbersByLeadName(db, businessId, name)) {
      seedNumbers.add(number);
      nameMatched.push({ name, number });
    }
  }
  // Loud on purpose. This is the one path that identifies a person by
  // something other than a unique key, so every use has to be auditable
  // rather than silently trusted.
  if (nameMatched.length > 0) {
    await recordAudit({
      businessId,
      level: "warn",
      source: "ai_flows",
      event: "ai_flow_booking_goal_name_match",
      message:
        `Matched ${nameMatched.length} booking(s) to a lead by NAME because the ` +
        "booking carried no phone and its email did not match any contact",
      payload: { matches: nameMatched }
    });
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
  // (not the alias fan-out, dedupe happens in resolution anyway); a
  // phone-only identity creates/resolves a phone-named node that later
  // contact ingests enrich. The fact value is deliberately DATE-FREE: the
  // goal fan-out doesn't carry the appointment's actual date (a delayed
  // Calendly sweep fires later than the booking), and the graph records
  // the durable relationship, "this person books with us", while the
  // calendar stays the authoritative per-event log; the fact row's
  // stated_at carries recency. Never-throws, mode-gated inside.
  /* c8 ignore next -- production default; tests inject */
  const ingest = deps.ingestBookingEvent ?? ingestBooking;
  for (const identity of identities) {
    const phone = bookingPhoneE164(identity.phone ?? undefined);
    const email = (identity.email ?? "").trim().toLowerCase();
    if (!phone && !email) continue;
    await ingest(businessId, {
      name: null,
      phoneE164: phone,
      email: email || null,
      detail: "appointment booked"
    });
  }

  return result;
}
