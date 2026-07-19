/**
 * backfill-calendly-booking-goals.ts — one-time appointment_booked catch-up
 * for Calendly bookings that predate the booking-goal observers.
 *
 * The 1/min sweep (PR #742) and the invitee.created webhook (PR #746) only
 * observe bookings created while they were running; anyone who booked BEFORE
 * they deployed still sits in a parked follow-up run getting nudged (Tim
 * Tsai, KYP Ads, Jul 18-19 2026). This one-shot lists the business's active
 * Calendly bookings over a wide window and fires the exact same goal
 * machinery the sweep uses (`fireBookingGoalsForInvitees`), fast-forwarding
 * every parked run whose lead already booked.
 *
 * Idempotent: a run that already jumped has no matching goal ahead and
 * no-ops; re-running just re-fires no-op events.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/backfill-calendly-booking-goals.ts --business <uuid>            # dry-run
 *   npx tsx scripts/oneshot/backfill-calendly-booking-goals.ts --business <uuid> --apply    # fire
 *   # optional: --days 14 (how far BACK booking creation may reach; default 14)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID = businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}
const daysArgIdx = process.argv.indexOf("--days");
const BACK_DAYS = Math.max(1, Number(daysArgIdx !== -1 ? process.argv[daysArgIdx + 1] : 14) || 14);
/** Upcoming-start horizon; matches the sweep's created-scan forward reach. */
const FORWARD_DAYS = 90;

const { createClient } = await import("@supabase/supabase-js");
const { resolveCalendarConnection } = await import("../../src/lib/voice-tools/connections.ts");
const { calendlyRequest } = await import("../../src/lib/calendar-tools/calendly.ts");
const {
  fireBookingGoalsForInvitees,
  inviteePhoneE164,
  contactNumbersFor,
  BOOKING_GOAL_RUN_STATUSES
} = await import("../../src/lib/ai-flows/calendly-booking-goals.ts");
const { findContactsByEmails } = await import("../../src/lib/db/contact-emails.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const conn = await resolveCalendarConnection(BUSINESS_ID);
if (!conn || conn.provider !== "calendly") {
  console.error("[oneshot] business does not resolve to a Calendly calendar connection");
  process.exit(1);
}

const userRes = await calendlyRequest(BUSINESS_ID, conn, { endpoint: "/users/me", method: "GET" });
const userUri = (userRes?.data as { resource?: { uri?: string } } | undefined)?.resource?.uri;
if (typeof userUri !== "string" || !userUri) {
  console.error("[oneshot] Calendly refused /users/me — token rejected?");
  process.exit(1);
}

const nowMs = Date.now();
const dayMs = 24 * 60 * 60_000;
type RawEvent = { uri?: string; name?: string; start_time?: string; created_at?: string };
type RawInvitee = { status?: string; email?: string; text_reminder_number?: string; name?: string };

// Active bookings with a FUTURE start (an appointment that already happened
// must not silently skip a live nurture run), listed regardless of when the
// booking was CREATED — that is exactly the gap the sweep's lookback leaves.
const listRes = await calendlyRequest(BUSINESS_ID, conn, {
  endpoint: "/scheduled_events",
  method: "GET",
  params: {
    user: userUri,
    status: "active",
    sort: "start_time:asc",
    count: "100",
    min_start_time: new Date(nowMs).toISOString(),
    max_start_time: new Date(nowMs + FORWARD_DAYS * dayMs).toISOString()
  }
});
if (!listRes) {
  console.error("[oneshot] Calendly refused the events listing");
  process.exit(1);
}
const events = ((listRes.data as { collection?: RawEvent[] })?.collection ?? []).filter(
  (e): e is RawEvent & { uri: string } => typeof e?.uri === "string" && e.uri.length > 0
);
console.log(`[oneshot] ${events.length} active upcoming booking(s) on Calendly`);

const minCreatedMs = nowMs - BACK_DAYS * dayMs;
const allInvitees: RawInvitee[] = [];
for (const ev of events) {
  const createdMs = Date.parse(ev.created_at ?? "");
  if (Number.isFinite(createdMs) && createdMs < minCreatedMs) {
    console.log(`[oneshot]   skip "${ev.name}" (created ${ev.created_at} — beyond --days ${BACK_DAYS})`);
    continue;
  }
  const uuid = ev.uri.slice(ev.uri.lastIndexOf("/") + 1);
  const invRes = await calendlyRequest(BUSINESS_ID, conn, {
    endpoint: `/scheduled_events/${encodeURIComponent(uuid)}/invitees`,
    method: "GET",
    params: { count: "10" }
  });
  if (!invRes) {
    console.error(`[oneshot]   invitee fetch refused for "${ev.name}" — skipping event`);
    continue;
  }
  const invitees = ((invRes.data as { collection?: RawInvitee[] })?.collection ?? []).filter(
    (i) => i?.status !== "canceled"
  );
  for (const i of invitees) {
    console.log(
      `[oneshot]   booking "${ev.name}" start=${ev.start_time} created=${ev.created_at} ` +
        `invitee="${i.name ?? "?"}" email=${i.email ?? "-"} phone=${i.text_reminder_number ?? "-"}`
    );
    allInvitees.push(i);
  }
}

if (allInvitees.length === 0) {
  console.log("[oneshot] no invitees inside the window — nothing to fire.");
  process.exit(0);
}

// Dry-run preview: resolve invitees → fire numbers exactly like
// fireBookingGoalsForInvitees, then show which parked runs each would jump.
const seedNumbers = new Set<string>();
const seedEmails = new Set<string>();
for (const i of allInvitees) {
  const phone = inviteePhoneE164(i.text_reminder_number);
  if (phone) seedNumbers.add(phone);
  const email = (i.email ?? "").trim().toLowerCase();
  if (email) seedEmails.add(email);
}
if (seedEmails.size > 0) {
  const linked = await findContactsByEmails(BUSINESS_ID, [...seedEmails], db as never);
  for (const link of linked.values()) seedNumbers.add(link.customerE164);
}
const fireNumbers = new Set<string>();
for (const seed of seedNumbers) {
  for (const n of await contactNumbersFor(db as never, BUSINESS_ID, seed)) fireNumbers.add(n);
}

console.log(`[oneshot] fire set (${fireNumbers.size} number(s)):`, [...fireNumbers].join(", "));

let previewJumpable = 0;
for (const number of fireNumbers) {
  const { data: runRows, error } = await db
    .from("ai_flow_runs")
    .select("id, flow_id, status, current_step, created_at")
    .eq("business_id", BUSINESS_ID)
    .in("status", [...BOOKING_GOAL_RUN_STATUSES])
    .or(
      `context->trigger->>from.eq.${number},context->vars->>lead_phone.eq.${number},context->waiting_reply->>from.eq.${number},context->waiting_call->>to.eq.${number}`
    )
    .limit(25);
  if (error) {
    console.error(`[oneshot]   run preview failed for ${number}:`, error.message);
    continue;
  }
  for (const r of (runRows ?? []) as Array<{
    id: string;
    flow_id: string;
    status: string;
    current_step: number;
  }>) {
    previewJumpable += 1;
    console.log(
      `[oneshot]   candidate run ${r.id} (flow ${r.flow_id}) status=${r.status} step=${r.current_step} — would receive appointment_booked`
    );
  }
}
console.log(
  `[oneshot] ${previewJumpable} parked run(s) match the fire set (a run only jumps if a matching goal is AHEAD of its cursor).`
);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to fire the goal events.");
  process.exit(0);
}

const fired = await fireBookingGoalsForInvitees(db as never, BUSINESS_ID, allInvitees);
console.log(
  `[oneshot] fired ${fired.goalsFired} goal event(s); ${fired.jumpedRuns} run(s) fast-forwarded past their remaining follow-ups.`
);

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    back_days: BACK_DAYS,
    invitees: allInvitees.length,
    goals_fired: fired.goalsFired,
    jumped_runs: fired.jumpedRuns
  }
});

console.log("[oneshot] applied.");
