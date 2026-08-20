/**
 * Owner-only employee performance metrics, BizBlasts'
 * StaffPerformanceService leaderboard translated to the data newCoworker
 * actually has (no bookings/revenue): lead-routing outcomes from AiFlow
 * `context.routing` and forwarded calls from voice transcripts.
 *
 * Per roster member over the trailing window:
 *   - offered, runs where an offer verifiably reached them. Derived
 *     from the union of `routing.offered_log` (who was actually texted an
 *     offer), the current live `routing.offered`, AND `routing.claimed_by`.
 *     The claimed_by leg matters: the engine only finalizes a claim for a
 *     member who WAS offered the lead ("1" claims live/late/yank offers;
 *     see late_claim.ts), but the claim finalization does not append to
 *     offered_log, and runs predating the offered_log bookkeeping
 *     (2026-07-06, #387) never carry it at all, counting offered_log alone
 *     made Offered undercount and read LOWER than Claimed. This union keeps
 *     the invariant offered ≥ claimed for every member on every run.
 *   - claimed, runs they hold (claimed_by)
 *   - claimRate, claimed / offered (≤ 100% by the invariant above)
 *   - medianClaimMs, median run-start → claim time across their claimed
 *     runs. REAL where the run carries `routing.claimed_at_ms` (stamped at
 *     every claim site since the claim-clock work); runs from before the
 *     stamp fall back to run-start → last-update, which is approximate
 *     (updated_at moves again if steps run after the claim).
 *     `medianClaimExact` says which kind a member's median is, so the UI
 *     can label honestly instead of promising a stopwatch it lacks.
 *   - claimedNoTouch48h, claims (newest CLAIM_TOUCH_LEAD_LIMIT, once their
 *     48h grace has fully elapsed) where NO platform-visible touch reached
 *     that lead within 48h of the claim. A touch is a forwarded call the
 *     lead was on (voice_call_transcripts, call_kind=forwarded; missed rows
 *     are excluded at the shared scan layer), an outbound SMS to the lead
 *     (sms_outbound_log, any source, so an automated post-claim text counts
 *     as platform contact), or an outbound email logged to the lead's
 *     address (email_log). Platform-visible ONLY, by construction: a
 *     teammate calling from their personal cell leaves no record here, and
 *     the card says so in plain words. Conversation auto-replies
 *     (sms_inbound_jobs.assistant_reply_text) are not scanned: those record
 *     the LEAD texting us, not outreach to the lead. Where the claim moment
 *     is approximate (legacy runs), the touch window opens at RUN START
 *     rather than the estimated claim, biasing toward "touched", a false
 *     accusation is worse than a missed one.
 *   - forwardedCalls, answered calls the voice line handed to them
 *     (voice_call_transcripts.forwarded_to_e164, missed excluded at the
 *     shared scan layer).
 *
 * Every query here is explicitly capped (PostgREST silently truncates
 * un-limited selects at 1000 rows); a capped touch scan can lose the OLDEST
 * touches and overcount no-touch claims, so the caps sit far above current
 * tenant volumes.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ANALYTICS_CALL_SCAN_LIMIT,
  fetchTranscriptRows
} from "@/lib/analytics/dashboard-analytics";
import { listTeamMembers } from "@/lib/db/employees";
import { taskLeadPhone } from "@/lib/ai-flows/tasks";
import { routingOfContext } from "../../../supabase/functions/_shared/ai_flows/routing";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmployeePerformanceRow = {
  memberId: string;
  name: string;
  e164: string;
  active: boolean;
  offered: number;
  claimed: number;
  /** claimed / offered; null when never offered. */
  claimRate: number | null;
  /** Median ms from run start to the claim across claimed runs; null when unclaimed. */
  medianClaimMs: number | null;
  /** True when EVERY duration behind medianClaimMs came from a real claim stamp. */
  medianClaimExact: boolean;
  /** Elapsed-grace claims with no platform-visible touch to the lead within 48h. */
  claimedNoTouch48h: number;
  forwardedCalls: number;
};

export const EMPLOYEE_PERFORMANCE_WINDOW_DAYS = 30;

/** Run rows scanned per window, far above current per-tenant volumes. */
export const EMPLOYEE_RUN_SCAN_LIMIT = 2000;

/** How long a claim has to show a touch before it counts against the claimer. */
export const CLAIM_TOUCH_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Newest claims evaluated for follow-through per window. Also bounds the
 * contact-identity lookup's filter list (the tasks route uses the same size
 * for the same reason: the phones travel in the query string).
 */
export const CLAIM_TOUCH_LEAD_LIMIT = 200;

/** Touch rows scanned per source (SMS / email), newest first. */
export const TOUCH_SCAN_LIMIT = 2000;

/** Middle value (mean of the middle pair for even counts); null for []. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One claim to check for follow-through. */
type ClaimRecord = {
  claimerE164: string;
  leadPhone: string;
  /** When the claim happened (epoch ms), exact stamp or approximation. */
  claimMs: number;
  /** Where the touch window opens: the claim itself, or run start for legacy rows. */
  touchFromMs: number;
};

/** The lead's reachable identity: every number and email a touch could target. */
type LeadIdentity = { numbers: Set<string>; emails: Set<string> };

/**
 * Leaderboard rows for every roster member (active first, then by claims).
 * Members with zero activity still appear, an owner scanning the card
 * should see who ISN'T taking leads, not just who is.
 */
export async function getEmployeePerformance(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; days?: number } = {}
): Promise<EmployeePerformanceRow[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const days = opts.days ?? EMPLOYEE_PERFORMANCE_WINDOW_DAYS;
  const nowMs = now.getTime();
  const cutoffIso = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

  const members = await listTeamMembers(businessId, db);
  if (members.length === 0) return [];
  const memberPhones = new Set(members.map((m) => m.phone_e164));

  type RunRow = {
    context: Record<string, unknown> | null;
    created_at: string;
    updated_at: string | null;
  };
  type CallRow = {
    forwarded_to_e164: string | null;
    caller_e164: string | null;
    started_at: string;
  };
  const [runsRes, callRows] = await Promise.all([
    db
      .from("ai_flow_runs")
      .select("context, created_at, updated_at")
      .eq("business_id", businessId)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(EMPLOYEE_RUN_SCAN_LIMIT),
    fetchTranscriptRows<CallRow>(businessId, db, {
      columns: ["forwarded_to_e164", "caller_e164", "started_at"],
      filter: { startIso: cutoffIso },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getEmployeePerformance calls"
    })
  ]);
  if (runsRes.error) {
    throw new Error(`getEmployeePerformance runs: ${runsRes.error.message}`);
  }

  const offered = new Map<string, number>();
  const claimed = new Map<string, number>();
  const claimDurations = new Map<string, Array<{ ms: number; exact: boolean }>>();
  // Runs arrive newest-first, so this list is newest-claims-first by
  // construction and the evaluation cap below keeps the most recent ones.
  const claimRecords: ClaimRecord[] = [];
  for (const run of ((runsRes.data as RunRow[] | null) ?? [])) {
    const routing = routingOfContext(run.context);
    if (!routing) continue;
    // Everyone this run's offer verifiably reached (see module doc): the
    // offer log, plus a live un-answered offer, plus the claimer, a claim
    // is itself proof an offer reached them, including on runs that predate
    // the offered_log bookkeeping.
    const offeredSet = new Set(routing.offered_log ?? []);
    if (routing.offered) offeredSet.add(routing.offered);
    if (routing.claimed_by) offeredSet.add(routing.claimed_by);
    for (const e164 of offeredSet) {
      offered.set(e164, (offered.get(e164) ?? 0) + 1);
    }
    if (routing.claimed_by) {
      claimed.set(routing.claimed_by, (claimed.get(routing.claimed_by) ?? 0) + 1);
      const start = Date.parse(run.created_at);
      const stamp = routing.claimed_at_ms;
      const approxEnd = run.updated_at ? Date.parse(run.updated_at) : NaN;
      // Turnaround: the real stamp when the run carries one, else the legacy
      // run-start → last-update approximation. Either way the duration must
      // be positive to mean anything.
      const end = typeof stamp === "number" ? stamp : approxEnd;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const list = claimDurations.get(routing.claimed_by) ?? [];
        list.push({ ms: end - start, exact: typeof stamp === "number" });
        claimDurations.set(routing.claimed_by, list);
      }
      // Follow-through record: only for roster members (off-roster claimers
      // never render a row) and only when the run names its lead. context is
      // non-null here: routingOfContext above already required it.
      const leadPhone = taskLeadPhone(run.context as Record<string, unknown>);
      const claimMs = typeof stamp === "number" ? stamp : approxEnd;
      if (memberPhones.has(routing.claimed_by) && leadPhone && Number.isFinite(claimMs)) {
        claimRecords.push({
          claimerE164: routing.claimed_by,
          leadPhone,
          claimMs,
          // Legacy rows only estimate WHEN the claim landed, so their touch
          // window opens at run start: a touch anywhere in the run's life
          // clears them, biasing toward "touched" (see module doc).
          touchFromMs:
            typeof stamp === "number"
              ? claimMs
              : Number.isFinite(start)
                ? start
                : claimMs
        });
      }
    }
  }

  const forwarded = new Map<string, number>();
  // Forwarded rows double as TOUCH evidence: the lead (caller) was on a call
  // a human answered. Keyed by the lead's number.
  const callTouches = new Map<string, number[]>();
  for (const call of callRows) {
    if (!call.forwarded_to_e164) continue;
    forwarded.set(call.forwarded_to_e164, (forwarded.get(call.forwarded_to_e164) ?? 0) + 1);
    const at = Date.parse(call.started_at);
    if (call.caller_e164 && Number.isFinite(at)) {
      const list = callTouches.get(call.caller_e164) ?? [];
      list.push(at);
      callTouches.set(call.caller_e164, list);
    }
  }

  const noTouch = await countClaimsWithNoTouch(db, businessId, {
    claims: claimRecords.slice(0, CLAIM_TOUCH_LEAD_LIMIT),
    callTouches,
    cutoffIso,
    nowMs
  });

  const rows: EmployeePerformanceRow[] = members.map((m) => {
    const offers = offered.get(m.phone_e164) ?? 0;
    const claims = claimed.get(m.phone_e164) ?? 0;
    const durations = claimDurations.get(m.phone_e164) ?? [];
    return {
      memberId: m.id,
      name: m.name,
      e164: m.phone_e164,
      active: m.active,
      offered: offers,
      claimed: claims,
      // offered ⊇ claimed per run (the claimer always counts as offered),
      // so this can never exceed 100%.
      claimRate: offers === 0 ? null : claims / offers,
      medianClaimMs: median(durations.map((d) => d.ms)),
      medianClaimExact: durations.length > 0 && durations.every((d) => d.exact),
      claimedNoTouch48h: noTouch.get(m.phone_e164) ?? 0,
      forwardedCalls: forwarded.get(m.phone_e164) ?? 0
    };
  });
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.claimed - a.claimed;
  });
  return rows;
}

/**
 * Per-claimer count of elapsed-grace claims with zero platform-visible
 * touches. Fetches the leads' contact identities (aliases + email) and the
 * window's outbound SMS / email logs, then checks each claim's 48h window;
 * forwarded-call touches ride in from the transcript scan the caller
 * already ran.
 */
async function countClaimsWithNoTouch(
  db: SupabaseClient,
  businessId: string,
  args: {
    claims: ClaimRecord[];
    callTouches: Map<string, number[]>;
    cutoffIso: string;
    nowMs: number;
  }
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  // Only claims whose 48h grace has fully elapsed are judged: a claim made
  // this morning has not had its chance yet, so it is pending, not guilty.
  const due = args.claims.filter((c) => args.nowMs >= c.claimMs + CLAIM_TOUCH_WINDOW_MS);
  if (due.length === 0) return counts;

  const leadPhones = [...new Set(due.map((c) => c.leadPhone))];
  type ContactRow = {
    customer_e164: string;
    alias_e164s: string[] | null;
    email: string | null;
  };
  // E.164 values are strictly `+digits`, so they are safe inside the
  // PostgREST filter string (the tasks route builds the same lookup).
  // `ov` = array overlap on alias_e164s: a claimed run can be keyed on a
  // merged-away number whose surviving contact holds the email.
  const list = leadPhones.join(",");
  const contactsRes = await db
    .from("contacts")
    .select("customer_e164, alias_e164s, email")
    .eq("business_id", businessId)
    .or(`customer_e164.in.(${list}),alias_e164s.ov.{${list}}`)
    .limit(CLAIM_TOUCH_LEAD_LIMIT);
  if (contactsRes.error) {
    throw new Error(`getEmployeePerformance contacts: ${contactsRes.error.message}`);
  }
  const contacts = ((contactsRes.data as ContactRow[] | null) ?? []);

  // Identity per claimed lead phone: the contact's primary + aliases and its
  // email when a contact row exists, else just the phone itself.
  const identities = new Map<string, LeadIdentity>();
  for (const phone of leadPhones) {
    const contact = contacts.find(
      (c) => c.customer_e164 === phone || (c.alias_e164s ?? []).includes(phone)
    );
    const numbers = new Set<string>([phone]);
    const emails = new Set<string>();
    if (contact) {
      numbers.add(contact.customer_e164);
      for (const alias of contact.alias_e164s ?? []) numbers.add(alias);
      if (contact.email?.trim()) emails.add(contact.email.trim().toLowerCase());
    }
    identities.set(phone, { numbers, emails });
  }

  const allNumbers = [...new Set([...identities.values()].flatMap((i) => [...i.numbers]))];
  const allEmails = new Set([...identities.values()].flatMap((i) => [...i.emails]));

  // Outbound SMS to any of the leads' numbers since the window opened.
  // Claims (and therefore their touch windows) start inside the window, so
  // the window's log covers every judgeable touch.
  type SmsRow = { to_e164: string; created_at: string };
  const smsRes = await db
    .from("sms_outbound_log")
    .select("to_e164, created_at")
    .eq("business_id", businessId)
    .in("to_e164", allNumbers)
    .gte("created_at", args.cutoffIso)
    .order("created_at", { ascending: false })
    .limit(TOUCH_SCAN_LIMIT);
  if (smsRes.error) {
    throw new Error(`getEmployeePerformance sms touches: ${smsRes.error.message}`);
  }
  const smsTouches = new Map<string, number[]>();
  for (const row of ((smsRes.data as SmsRow[] | null) ?? [])) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    const listForNumber = smsTouches.get(row.to_e164) ?? [];
    listForNumber.push(at);
    smsTouches.set(row.to_e164, listForNumber);
  }

  // Outbound email is matched in memory (lowercased) rather than filtered
  // server-side: to_email is stored as typed, and a case-mismatched filter
  // would silently miss real touches.
  const emailTouches = new Map<string, number[]>();
  if (allEmails.size > 0) {
    type EmailRow = { to_email: string | null; created_at: string };
    const emailRes = await db
      .from("email_log")
      .select("to_email, created_at")
      .eq("business_id", businessId)
      .eq("direction", "outbound")
      .gte("created_at", args.cutoffIso)
      .order("created_at", { ascending: false })
      .limit(TOUCH_SCAN_LIMIT);
    if (emailRes.error) {
      throw new Error(`getEmployeePerformance email touches: ${emailRes.error.message}`);
    }
    for (const row of ((emailRes.data as EmailRow[] | null) ?? [])) {
      const to = row.to_email?.trim().toLowerCase();
      const at = Date.parse(row.created_at);
      if (!to || !allEmails.has(to) || !Number.isFinite(at)) continue;
      const listForEmail = emailTouches.get(to) ?? [];
      listForEmail.push(at);
      emailTouches.set(to, listForEmail);
    }
  }

  const touchedWithin = (times: number[] | undefined, from: number, until: number) =>
    (times ?? []).some((t) => t > from && t <= until);

  for (const claim of due) {
    const identity = identities.get(claim.leadPhone)!;
    const until = claim.claimMs + CLAIM_TOUCH_WINDOW_MS;
    let touched = false;
    for (const number of identity.numbers) {
      if (
        touchedWithin(smsTouches.get(number), claim.touchFromMs, until) ||
        touchedWithin(args.callTouches.get(number), claim.touchFromMs, until)
      ) {
        touched = true;
        break;
      }
    }
    if (!touched) {
      for (const email of identity.emails) {
        if (touchedWithin(emailTouches.get(email), claim.touchFromMs, until)) {
          touched = true;
          break;
        }
      }
    }
    if (!touched) {
      counts.set(claim.claimerE164, (counts.get(claim.claimerE164) ?? 0) + 1);
    }
  }
  return counts;
}
