/**
 * Channel liveness: the reads, and the fleet-wide judgement over them.
 *
 * WRITES NOTHING, by construction. This module does not import
 * `recordSystemLog` at all, so "the read-only half" is a property of the
 * file rather than a promise in a comment. `./channel-liveness-sweep.ts`
 * wraps `reportChannelLiveness` to raise the admin rows, and
 * `debug/channel-liveness-report.ts` calls it bare as the calibration
 * instrument; both therefore run one fleet query, one residency skip, one
 * per-tenant isolation and one judgement, so the report can never drift
 * from the alarm.
 *
 * The judgement itself lives in `./channel-liveness.ts` and is pure. This
 * file gathers, per tenant, how many alerts each channel carried and the
 * newest proof a HUMAN acted on that channel.
 *
 * THE SIGNAL MUST BELONG TO THE AUDIENCE. Every reply-based read here is
 * filtered to the tenant's own alert audience (owner numbers plus the
 * active AiFlow roster), never to "anyone at all". That filter is not
 * defensive tidiness, it is the difference between a working check and a
 * broken one: KYP Ads has five WhatsApp threads, four of them leads, and
 * the newest lead message is hours old while the OWNER's thread has never
 * carried an inbound message in its life. An unfiltered
 * `last_user_message_at` read declares WhatsApp live on the one tenant
 * whose WhatsApp has been dead on Meta billing error 131042 for weeks.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { logger } from "@/lib/logger";
import {
  LIVENESS_CHANNELS,
  LIVENESS_WINDOW_DAYS,
  judgeAudience,
  judgeChannel,
  usableSignal,
  type AudienceJudgement,
  type ChannelEvidence,
  type LivenessChannel
} from "./channel-liveness";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * States that mean the owner did not read it and will not.
 * Mirrors `debug/email-delivery-report.ts`; kept as one list so the report
 * and the alarm cannot disagree about what a failure is.
 */
const EMAIL_FAILURE_STATES = ["bounced", "complained", "failed"] as const;

/**
 * When `recordNotificationEmail` went live in production (the Vercel deploy
 * of PR #1628, 2026-08-26T05:37:47Z).
 *
 * Alert emails sent before this have no `email_log` row at all, so they can
 * never acquire a receipt. Counting them as unreceipted would be correct
 * arithmetic and a misleading verdict, so the email leg only counts sends
 * from this instant forward. Until the 30-day window clears it, most
 * tenants' email legs answer `undecidable`, which is the truth.
 */
const EMAIL_RECEIPTS_LIVE_AT = "2026-08-26T05:37:47Z";

type BusinessRow = {
  id: string;
  name: string;
  data_residency_mode: string | null;
};

/** The people a tenant's alerts are aimed at, as addresses we can match on. */
type AlertAudience = {
  /** E.164, owner numbers plus every active roster phone. */
  phones: string[];
  /** Lowercased owner and roster email addresses. */
  emails: string[];
};

function windowStartIso(nowMs: number): string {
  return new Date(nowMs - LIVENESS_WINDOW_DAYS * 86_400_000).toISOString();
}

/** WhatsApp's `psid` is the E.164 digits with no leading `+`. */
function bareDigits(phone: string): string {
  return phone.replace(/^\+/, "");
}

function newest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * The tenant's alert audience.
 *
 * `businessOwnerNumbers` is the same three-source resolver the dashboard
 * uses to RECOGNIZE the owner (businesses.phone, the Safe Mode forward
 * cell, the notification alert phone), reused rather than re-derived so
 * this cannot grow a fourth opinion about which number is the owner's.
 */
async function loadAlertAudience(
  businessId: string,
  db: SupabaseClient
): Promise<AlertAudience> {
  const [ownerNumbers, bizRes, prefsRes, rosterRes] = await Promise.all([
    businessOwnerNumbers(businessId, db),
    db.from("businesses").select("owner_email").eq("id", businessId).maybeSingle(),
    db
      .from("notification_preferences")
      .select("alert_email")
      .eq("business_id", businessId)
      .maybeSingle(),
    db
      .from("ai_flow_team_members")
      .select("phone_e164, email")
      .eq("business_id", businessId)
      .eq("active", true)
  ]);

  const phones = new Set<string>(ownerNumbers);
  const emails = new Set<string>();
  const push = (set: Set<string>, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) set.add(value.trim().toLowerCase());
  };
  push(emails, (bizRes.data as { owner_email?: string } | null)?.owner_email);
  push(emails, (prefsRes.data as { alert_email?: string } | null)?.alert_email);
  for (const m of (rosterRes.data as { phone_e164?: string; email?: string }[] | null) ?? []) {
    if (typeof m.phone_e164 === "string" && m.phone_e164.trim().length > 0) {
      phones.add(m.phone_e164.trim());
    }
    push(emails, m.email);
  }
  return { phones: [...phones], emails: [...emails] };
}

/**
 * Alerts recorded `sent` per channel inside the window.
 *
 * Counted with `head: true, count: "exact"` rather than by fetching and
 * tallying, because an un-limited PostgREST select silently truncates at
 * 1000 rows and a truncated count here reads as a quiet month, which is
 * precisely the false negative this whole feature exists to prevent.
 */
async function countSendsByChannel(
  businessId: string,
  sinceIso: string,
  db: SupabaseClient
): Promise<Record<LivenessChannel, number>> {
  const out = {} as Record<LivenessChannel, number>;
  await Promise.all(
    LIVENESS_CHANNELS.map(async (channel) => {
      const { count, error } = await db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("delivery_channel", channel)
        .eq("status", "sent")
        .gte("created_at", sinceIso);
      if (error) throw new Error(`countSendsByChannel(${channel}): ${error.message}`);
      out[channel] = count ?? 0;
    })
  );
  return out;
}

/**
 * Newest inbound text from someone in the alert audience.
 *
 * `staff_kind` is stamped by the inbound worker as `owner` or `team` when
 * the sender matches a known staff number; anything else is a customer and
 * proves nothing about whether our alerts are landing. The audience filter
 * on top of that is what keeps a departed teammate's number from vouching
 * for a roster they are no longer on.
 */
async function lastStaffSmsAt(
  businessId: string,
  audience: AlertAudience,
  db: SupabaseClient
): Promise<string | null> {
  if (audience.phones.length === 0) return null;
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("created_at")
    .eq("business_id", businessId)
    .in("staff_kind", ["owner", "team"])
    .in("customer_e164", audience.phones)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`lastStaffSmsAt: ${error.message}`);
  return usableSignal((data as { created_at?: string }[] | null)?.[0]?.created_at ?? null);
}

/**
 * Newest inbound WhatsApp message from someone in the alert audience.
 *
 * Matched on `psid` (the WhatsApp id, which is the E.164 digits without the
 * `+`) and on `contact_phone` when the row carries one, because in practice
 * `contact_phone` is null on every WhatsApp thread on the fleet and `psid`
 * is the only identity present.
 */
async function lastOwnerWhatsappAt(
  businessId: string,
  audience: AlertAudience,
  db: SupabaseClient
): Promise<{ at: string | null; attributed: boolean }> {
  if (audience.phones.length === 0) return { at: null, attributed: false };
  const { data, error } = await db
    .from("messenger_conversations")
    .select("psid, contact_phone, last_user_message_at")
    .eq("business_id", businessId)
    .eq("platform", "whatsapp");
  if (error) throw new Error(`lastOwnerWhatsappAt: ${error.message}`);
  const digits = new Set(audience.phones.map(bareDigits));
  let at: string | null = null;
  let matched = false;
  for (const row of (data as
    | { psid?: string; contact_phone?: string; last_user_message_at?: string }[]
    | null) ?? []) {
    const rowDigits = [row.psid, row.contact_phone]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(bareDigits);
    if (!rowDigits.some((d) => digits.has(d))) continue;
    matched = true;
    at = newest(at, usableSignal(row.last_user_message_at ?? null));
  }
  return { at, attributed: matched };
}

/**
 * Newest message from somebody in the alert audience, on one team-chat
 * channel.
 *
 * ONE function for every channel on the shared pipeline, and the `channel`
 * filter is what makes it safe: these rows all live in one table now, so
 * without the pin a live Telegram thread would certify Slack as healthy.
 * That is the same shape of bug as reading the newest WhatsApp thread
 * instead of the owner's own.
 *
 * Three ways a row can belong to the audience, because the channels prove
 * identity differently. `is_owner` is stamped by the pipeline when the
 * platform matched the speaker to the tenant owner. The email cross-check
 * widens it to roster members present under their own address, which is how
 * Slack and Google Chat identify people. The phone cross-check does the
 * same for Telegram, where enrolment records the number Telegram verified
 * rather than an address.
 */
async function lastAudienceMessageAt(
  businessId: string,
  channel: "slack" | "telegram" | "teams",
  audience: AlertAudience,
  db: SupabaseClient
): Promise<string | null> {
  const { data, error } = await db
    .from("coworker_conversations")
    .select("is_owner, user_email, user_phone_e164, last_user_message_at")
    .eq("business_id", businessId)
    .eq("channel", channel);
  if (error) throw new Error(`lastAudienceMessageAt(${channel}): ${error.message}`);
  const emails = new Set(audience.emails);
  const phones = new Set(audience.phones.map(bareDigits));
  let at: string | null = null;
  for (const row of (data as
    | {
        is_owner?: boolean;
        user_email?: string;
        user_phone_e164?: string;
        last_user_message_at?: string;
      }[]
    | null) ?? []) {
    const isAudience =
      row.is_owner === true ||
      (typeof row.user_email === "string" && emails.has(row.user_email.toLowerCase())) ||
      (typeof row.user_phone_e164 === "string" && phones.has(bareDigits(row.user_phone_e164)));
    if (!isAudience) continue;
    at = newest(at, usableSignal(row.last_user_message_at ?? null));
  }
  return at;
}

/**
 * Newest dashboard read, and whether we can prove who made it.
 *
 * `read_by_actor` arrived with the notification-actor migration; every row
 * stamped before it is `null` and stays that way, so the dashboard signal
 * degrades gracefully from strong to soft rather than disappearing. An
 * `admin` read is DISCARDED outright, not merely marked weak: a support
 * session opening a tenant's notifications is us, and letting it vouch for
 * the owner is how this check would come to certify its own investigators.
 *
 * `isdistinct` (IS DISTINCT FROM), NOT `neq`. This is the whole read, and
 * `neq` breaks it silently: `read_by_actor <> 'admin'` evaluates to NULL,
 * not TRUE, for a NULL actor, so PostgREST would drop every row stamped
 * before the migration. Today that is EVERY row on the fleet, which means
 * the dashboard signal this check was calibrated against would vanish the
 * moment the migration landed, and KYP Ads, whose only live-looking channel
 * is one legacy dashboard read, would flip straight from `degraded` to
 * `dark`. IS DISTINCT FROM is the NULL-safe form and is TRUE for both a NULL
 * actor and any non-admin value. Same operator, same reason, as the AMD
 * resolution sweep's resolved-state filters.
 */
async function lastDashboardReadAt(
  businessId: string,
  db: SupabaseClient
): Promise<{ at: string | null; attributed: boolean }> {
  const { data, error } = await db
    .from("notifications")
    .select("read_at, read_by_actor")
    .eq("business_id", businessId)
    .not("read_at", "is", null)
    .filter("read_by_actor", "isdistinct", "admin")
    .order("read_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`lastDashboardReadAt: ${error.message}`);
  const row = (data as { read_at?: string; read_by_actor?: string | null }[] | null)?.[0];
  return {
    at: usableSignal(row?.read_at ?? null),
    attributed: row?.read_by_actor === "owner"
  };
}

/**
 * Newest owner/teammate tap on a notification short link.
 *
 * The strongest signal in the system: it proves a specific human opened a
 * specific alert that arrived on a specific channel. Recorded by the
 * `sms_link_click` RPC into its own table, deliberately outside
 * `sms_link_clicks` and outside everything `sms_links.tracked` protects, so
 * an owner tapping his own alert can never inflate the lead engagement
 * funnel. Untracked links are only ever created by the `owner_notify` send
 * paths, so every row here is already an alert-audience click.
 *
 * TWO FILTERS, both load-bearing:
 *
 *  - `likely_prefetch` is EXCLUDED. Messaging apps and carrier security
 *    scanners fetch every link within seconds of delivery, in production on
 *    essentially every send. Counting those as attention would manufacture a
 *    perfect, permanent liveness signal for a channel nobody reads, which is
 *    the exact failure this feature exists to end, only harder to spot.
 *  - `channel` is pinned rather than assumed. Every row is `sms` today, and
 *    a second shortener would otherwise silently start answering for SMS.
 */
async function lastNotificationLinkClickAt(
  businessId: string,
  channel: LivenessChannel,
  db: SupabaseClient
): Promise<string | null> {
  const { data, error } = await db
    .from("notification_link_clicks")
    .select("clicked_at")
    .eq("business_id", businessId)
    // Filtered by channel, never assumed. That column exists precisely so
    // this read can say WHICH channel the click proves, and assuming is how
    // the WhatsApp leg of this same check first read a lead's message as the
    // owner's.
    .eq("channel", channel)
    .eq("likely_prefetch", false)
    .order("clicked_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`lastNotificationLinkClickAt(${channel}): ${error.message}`);
  return usableSignal((data as { clicked_at?: string }[] | null)?.[0]?.clicked_at ?? null);
}

/** Receipt tally for alert emails sent to the audience inside the window. */
async function emailReceiptTally(
  businessId: string,
  sinceIso: string,
  audience: AlertAudience,
  db: SupabaseClient
): Promise<{ receipted: number; hardFailures: number }> {
  if (audience.emails.length === 0) return { receipted: 0, hardFailures: 0 };
  // Receipts can only exist from the deploy instant forward, so the window
  // start is whichever of the two is LATER.
  const from = sinceIso > EMAIL_RECEIPTS_LIVE_AT ? sinceIso : EMAIL_RECEIPTS_LIVE_AT;
  const { data, error } = await db
    .from("email_log")
    .select("delivery_status")
    .eq("business_id", businessId)
    .eq("direction", "outbound")
    .eq("source", "notification")
    .in("to_email", audience.emails)
    .gte("created_at", from)
    .limit(1000);
  if (error) throw new Error(`emailReceiptTally: ${error.message}`);
  const rows = (data as { delivery_status?: string | null }[] | null) ?? [];
  const failures = new Set<string>(EMAIL_FAILURE_STATES);
  let receipted = 0;
  let hardFailures = 0;
  for (const r of rows) {
    if (!r.delivery_status) continue;
    receipted += 1;
    if (failures.has(r.delivery_status)) hardFailures += 1;
  }
  return { receipted, hardFailures };
}

/**
 * Everything the judgement needs about one tenant, gathered in one pass.
 *
 * The SMS leg takes the newer of two independent signals: a staff reply and
 * an owner link tap. They are different acts (answering us versus opening
 * what we sent) and either one proves a human was there, so ignoring the
 * newer of the two would only ever manufacture silence.
 */
async function gatherChannelEvidence(
  businessId: string,
  nowMs: number,
  db: SupabaseClient
): Promise<ChannelEvidence[]> {
  const sinceIso = windowStartIso(nowMs);
  const audience = await loadAlertAudience(businessId, db);
  const [sends, smsReply, linkClick, pushClick, whatsapp, slack, telegram, teams, dashboard, email] =
    await Promise.all([
      countSendsByChannel(businessId, sinceIso, db),
      lastStaffSmsAt(businessId, audience, db),
      lastNotificationLinkClickAt(businessId, "sms", db),
      lastNotificationLinkClickAt(businessId, "push", db),
      lastOwnerWhatsappAt(businessId, audience, db),
      lastAudienceMessageAt(businessId, "slack", audience, db),
      lastAudienceMessageAt(businessId, "telegram", audience, db),
      lastAudienceMessageAt(businessId, "teams", audience, db),
      lastDashboardReadAt(businessId, db),
      emailReceiptTally(businessId, sinceIso, audience, db)
    ]);

  return [
    {
      channel: "sms",
      sends: sends.sms,
      lastHumanSignalAt: newest(smsReply, linkClick),
      attributed: true,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "email",
      sends: sends.email,
      lastHumanSignalAt: null,
      attributed: true,
      receipted: email.receipted,
      hardFailures: email.hardFailures
    },
    {
      channel: "dashboard",
      sends: sends.dashboard,
      lastHumanSignalAt: dashboard.at,
      attributed: dashboard.attributed,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "whatsapp",
      sends: sends.whatsapp,
      lastHumanSignalAt: whatsapp.at,
      attributed: whatsapp.attributed,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "slack",
      sends: sends.slack,
      lastHumanSignalAt: slack,
      attributed: true,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "telegram",
      sends: sends.telegram,
      lastHumanSignalAt: telegram,
      // Attributed with confidence: nobody reaches this surface at all
      // without a recorded binding to the owner or an active roster row.
      attributed: true,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "teams",
      sends: sends.teams,
      lastHumanSignalAt: teams,
      // Attributed with confidence: an activity only reaches a turn at all
      // once the platform has matched it to the owner or an active roster
      // row, by Microsoft-supplied address or a recorded binding.
      attributed: true,
      receipted: 0,
      hardFailures: 0
    },
    {
      channel: "push",
      sends: sends.push,
      lastHumanSignalAt: pushClick,
      /**
       * Unconditionally attributed, and this is the STRONGEST attribution in
       * the whole check. The other channels hedge: read_at carried no actor
       * before 20260828..., and messenger_conversations is mostly lead
       * threads. A push receipt is written from a notificationclick on a
       * subscription bound to an authenticated user row, so there is no
       * ambiguity about whether the person who tapped is in the alert
       * audience. They are, by construction.
       */
      attributed: true,
      receipted: 0,
      hardFailures: 0
    }
  ];
}

/**
 * Why this tenant cannot be judged, or null when it can.
 *
 * A `vps` residency tenant is SKIPPED, never judged. `notifications` and
 * `email_log` are both residency-moved AND centrally purged, and the purge
 * predicate deletes READ notifications specifically, so a central read for
 * such a tenant returns a systematically thinned set: fewer sends than
 * really happened and, worse, the read_at signal preferentially destroyed.
 * That reads as "quiet and unread", which this check would report as dark.
 * Refusing to answer is the only honest option until these reads are routed
 * through `@/lib/residency/read`, and the refusal is reported so the silence
 * cannot look like a clean bill of health.
 */
function residencySkipReason(business: BusinessRow): string | null {
  if (business.data_residency_mode === "vps") {
    return "vps residency: notifications/email_log are purged centrally, so a central read would under-count sends and lose read receipts";
  }
  return null;
}

/**
 * One tenant's outcome.
 *
 * A discriminated union rather than three nullable fields, so "skipped but
 * also judged" and "no error and no judgement either" cannot be constructed.
 * The nullable shape needed a defensive `?? "no judgement"` at every reader
 * for a state this loop can never produce, which is a branch nobody can test
 * and nobody can reason about.
 */
export type LivenessTenantReport =
  | { business: BusinessRow; outcome: "skipped"; reason: string }
  | { business: BusinessRow; outcome: "judged"; judgement: AudienceJudgement }
  | { business: BusinessRow; outcome: "failed"; error: string };

/**
 * Judge the whole fleet and WRITE NOTHING.
 *
 * This is the shared half of the feature. `sweepChannelLiveness` wraps it to
 * raise the admin rows, and `debug/channel-liveness-report.ts` calls it bare
 * as the calibration instrument. Both therefore run the identical fleet
 * query, the identical residency skip, the identical per-tenant isolation
 * and the identical judgement, so the report cannot drift from the alarm: if
 * the report prints SILENT, that is exactly what the sweep would have
 * written. A second copy of this loop in the debug script was the obvious
 * shape and would have been free to rot in precisely the direction that
 * makes an operator trust a stale answer.
 *
 * One tenant's failure never costs the rest of the fleet: it lands in that
 * row's `error` and the loop continues.
 */
export async function reportChannelLiveness(
  opts: { now?: number; client?: SupabaseClient; businessId?: string } = {}
): Promise<LivenessTenantReport[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const nowMs = opts.now ?? Date.now();

  let query = db
    .from("businesses")
    .select("id, name, data_residency_mode")
    .eq("status", "online");
  if (opts.businessId) query = query.eq("id", opts.businessId);
  const { data, error } = await query;
  if (error) throw new Error(`reportChannelLiveness: ${error.message}`);

  const out: LivenessTenantReport[] = [];
  for (const business of (data as BusinessRow[] | null) ?? []) {
    const reason = residencySkipReason(business);
    if (reason) {
      out.push({ business, outcome: "skipped", reason });
      continue;
    }
    try {
      const evidence = await gatherChannelEvidence(business.id, nowMs, db);
      out.push({
        business,
        outcome: "judged",
        judgement: judgeAudience(evidence.map((e) => judgeChannel(e, nowMs)))
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("channel-liveness: tenant failed", { businessId: business.id, error });
      out.push({ business, outcome: "failed", error });
    }
  }
  return out;
}
