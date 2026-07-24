// Supabase Edge Function: notifications-digest
//
// Daily + weekly digest sender. Scheduled by pg_cron (see migrations
// 20260509000001_schedule_notifications_digest_cron.sql and
// 20260612000000_weekly_digest.sql) and authenticated with
// INTERNAL_CRON_SECRET via the shared `_shared/cron_auth` helper. The cron
// body carries `{"window":"daily"}` or `{"window":"weekly"}` (missing =
// daily, for backward compatibility with the original schedule).
//
// For every business where the matching notification_preferences toggle
// (email_digest / email_digest_weekly) is true and a resolvable email exists
// (preferences.alert_email > businesses.owner_email > ADMIN_EMAIL), build an
// activity digest and send via Resend. Activity is aggregated from the REAL
// activity tables — dashboard_chat_jobs, sms_inbound_jobs (inbound + cached
// replies), sms_outbound_log, voice_call_transcripts, ai_flow_runs,
// customer_memories — plus coworker_logs (urgent alerts) and notifications
// (delivered count). The original implementation counted only coworker_logs,
// which nothing but voice captures writes to, so every digest skipped with
// "no_activity". One `notifications` row per business (kind=digest,
// channel=email) is recorded with sent/failed/skipped status.
//
// Skipped reasons:
//   - email_digest_disabled / email_digest_weekly_disabled: toggle is off
//   - unsubscribed: notification_preferences.unsubscribed_at is set
//   - no_email: no recipient could be resolved
//   - no_activity: nothing happened in the window
//   - no_customer_facing_activity: digest_customer_facing_only is on and the
//     window held only routine activity (background AiFlow runs, dashboard
//     chat, owner-directed sends) with no customer texts/calls, new
//     customers, or urgent alerts
//   - resend_unconfigured: RESEND_API_KEY missing
//
// Required Edge Function Secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   INTERNAL_CRON_SECRET
//   RESEND_API_KEY
//   MAILER_EMAIL
//   CONTACT_EMAIL (optional)
//   ADMIN_EMAIL (fallback recipient)
//   NEXT_PUBLIC_APP_URL (for unsubscribe URL + dashboard link)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { buildBrandedEmailHtml, type BrandedBodyBlock } from "../_shared/branded_email_html.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import {
  buildDigestEmailModel,
  buildDigestEventLinks,
  groupSmsThreads,
  hasCustomerFacingDigestActivity,
  hasDigestActivity,
  isRenderableSmsSender,
  smsCounterpartFromPayload,
  windowLabel,
  type DigestActivity,
  type DigestAiFlowRun,
  type DigestCallRow,
  type DigestCustomerRow,
  type DigestSmsMessage,
  type DigestWindow
} from "../_shared/digest_builder.ts";

// See ai-flow-worker: ReturnType<typeof createClient> mis-resolves vs the real
// createClient() call, so use a permissive client type for helper params.
type SupaClient = SupabaseClient<any, any, any>;

type DigestTarget = {
  business_id: string;
  business_name: string | null;
  owner_email: string | null;
  alert_email: string | null;
  /** Per-window recipient overrides; null = alert_email → owner_email chain. */
  digest_email_daily: string | null;
  digest_email_weekly: string | null;
  email_digest: boolean;
  email_digest_weekly: boolean;
  /** When true, send only for windows with customer-facing activity. */
  digest_customer_facing_only: boolean;
  unsubscribed_at: string | null;
};

// Plain `?bid=<businessId>` parameter — no HMAC. UUID v4 is unguessable and
// the unsubscribe action is a one-click flag the owner can re-enable from the
// dashboard. See src/app/api/notifications/unsubscribe/route.ts for the
// matching handler / threat-model rationale.
function buildUnsubscribeUrl(businessId: string, appUrl: string): string {
  return `${appUrl}/api/notifications/unsubscribe?bid=${encodeURIComponent(businessId)}`;
}

async function recordDigestRow(
  supa: SupaClient,
  businessId: string,
  status: "sent" | "failed" | "skipped",
  summary: string,
  payload: Record<string, unknown>,
  reason?: string
): Promise<void> {
  const { error } = await supa.from("notifications").insert({
    id: crypto.randomUUID(),
    business_id: businessId,
    delivery_channel: "email",
    status,
    kind: "digest",
    summary,
    payload: reason ? { ...payload, reason } : payload
  });
  if (error) console.error("digest.insert", status, error);
}

/**
 * Aggregate one business's activity for the window from the real tables.
 * Returns the activity plus the first query error encountered (if any) so
 * the caller records a `failed` digest row instead of silently treating a
 * broken query as "no activity".
 */
async function fetchActivity(
  supa: SupaClient,
  businessId: string,
  sinceIso: string
): Promise<{ activity: DigestActivity; error: string | null }> {
  const [
    chatRes,
    smsInCountRes,
    repliesCountRes,
    outLogCountRes,
    outLogCustomerCountRes,
    smsJobRowsRes,
    outLogRowsRes,
    callsRes,
    flowsRes,
    custRes,
    logRes,
    notifRes
  ] = await Promise.all([
      supa
        .from("dashboard_chat_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso),
      // Exact totals (head counts) drive the email subject, summary, roll-up
      // labels, and hasDigestActivity — these must reflect the FULL window, not
      // the capped row sets used for per-thread links below.
      supa
        .from("sms_inbound_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso),
      // Outbound = coworker replies + worker-initiated sends
      // (sms_outbound_log). Both filter on real timestamps, unlike the
      // previous daily_usage.sms_sent sum whose calendar-day usage_date
      // granularity let a daily digest absorb up to a full extra UTC day of
      // sends outside the rolling window.
      //
      // Replies are detected via assistant_reply_text (durable, written at
      // send time, never cleared) — NOT rowboat_reply_cached, which is a
      // transient Telnyx retry buffer nulled after every successful send.
      // The window filters on updated_at because the send-time write bumps
      // it; created_at would miss backlogged jobs received before the window
      // but answered inside it.
      supa
        .from("sms_inbound_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .not("assistant_reply_text", "is", null)
        .gte("updated_at", sinceIso),
      supa
        .from("sms_outbound_log")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso),
      // Customer-directed subset of the same log, for the
      // digest_customer_facing_only gate: owner pages (owner_notify /
      // owner_alert) and roster offers (agent_offer) are texts the owner or
      // team already saw in real time, not customer traffic.
      supa
        .from("sms_outbound_log")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .not("source", "in", '("owner_notify","owner_alert","agent_offer")')
        .gte("created_at", sinceIso),
      // Rows for per-conversation deep links. Reading the reply ("sent") side
      // from the SAME inbound rows as the received side means a thread's
      // received/sent tallies can never skew against each other (no split
      // capped queries). Capped well beyond realistic daily/weekly volume;
      // when exceeded, per-thread DETAIL is best-effort while the exact totals
      // above and the index roll-up stay authoritative.
      supa
        .from("sms_inbound_jobs")
        .select("payload, created_at, assistant_reply_text, updated_at")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(400),
      supa
        .from("sms_outbound_log")
        .select("to_e164, created_at")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(500),
      supa
        .from("voice_call_transcripts")
        .select("caller_e164, status, started_at")
        .eq("business_id", businessId)
        .gte("started_at", sinceIso)
        .order("started_at", { ascending: false })
        .limit(50),
      supa
        .from("ai_flow_runs")
        .select("status, created_at, context, ai_flows(name)")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(25),
      supa
        .from("contacts")
        // Only real customer profiles are "new customer" digest items — folded
        // manual contacts (other/service/tester) are not new customers.
        .select("display_name, customer_e164")
        .eq("business_id", businessId)
        .eq("type", "customer")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(25),
      supa
        .from("coworker_logs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "urgent_alert")
        .gte("created_at", sinceIso),
      supa
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "sent")
        .gte("created_at", sinceIso)
    ]);

  const firstError =
    (chatRes.error && `dashboard_chat_jobs: ${chatRes.error.message}`) ||
    (smsInCountRes.error && `sms_inbound_jobs (count): ${smsInCountRes.error.message}`) ||
    (repliesCountRes.error &&
      `sms_inbound_jobs (replies count): ${repliesCountRes.error.message}`) ||
    (outLogCountRes.error && `sms_outbound_log (count): ${outLogCountRes.error.message}`) ||
    (outLogCustomerCountRes.error &&
      `sms_outbound_log (customer count): ${outLogCustomerCountRes.error.message}`) ||
    (smsJobRowsRes.error && `sms_inbound_jobs (rows): ${smsJobRowsRes.error.message}`) ||
    (outLogRowsRes.error && `sms_outbound_log (rows): ${outLogRowsRes.error.message}`) ||
    (callsRes.error && `voice_call_transcripts: ${callsRes.error.message}`) ||
    (flowsRes.error && `ai_flow_runs: ${flowsRes.error.message}`) ||
    (custRes.error && `customer_memories: ${custRes.error.message}`) ||
    (logRes.error && `coworker_logs: ${logRes.error.message}`) ||
    (notifRes.error && `notifications: ${notifRes.error.message}`) ||
    null;

  // Exact totals from head counts (full window, uncapped).
  const smsInbound = smsInCountRes.count ?? 0;
  const smsOutbound = (repliesCountRes.count ?? 0) + (outLogCountRes.count ?? 0);
  // AI replies always answer a customer text, so they count as
  // customer-directed alongside the filtered outbound-log subset.
  const smsOutboundCustomer =
    (repliesCountRes.count ?? 0) + (outLogCustomerCountRes.count ?? 0);

  const jobRows = (smsJobRowsRes.data ?? []) as Array<{
    payload: Record<string, unknown> | null;
    created_at: string;
    assistant_reply_text: string | null;
    updated_at: string;
  }>;
  const outLogRows = (outLogRowsRes.data ?? []) as Array<{
    to_e164: string | null;
    created_at: string;
  }>;

  // Build per-conversation threads (best-effort detail capped to the row sets
  // above). Each inbound job is the customer's received text; if that same job
  // carries an assistant reply it is also one sent text to the same customer —
  // reading both sides off the one row keeps a thread's tallies self-consistent.
  // The reply is only counted as "sent" when its updated_at falls in the digest
  // window, matching the authoritative smsOutbound head count (a job received
  // in-window but answered later must not inflate the thread's sent tally).
  // Worker-initiated sends come from sms_outbound_log.to_e164.
  const sinceMs = Date.parse(sinceIso);
  const smsMessages: DigestSmsMessage[] = [];
  for (const r of jobRows) {
    const cp = smsCounterpartFromPayload(r.payload);
    if (!cp) continue;
    smsMessages.push({ counterpart: cp, direction: "inbound", at: r.created_at });
    if (
      typeof r.assistant_reply_text === "string" &&
      r.assistant_reply_text.length > 0 &&
      Date.parse(r.updated_at) >= sinceMs
    ) {
      smsMessages.push({ counterpart: cp, direction: "outbound", at: r.updated_at });
    }
  }
  for (const r of outLogRows) {
    const cp = r.to_e164;
    if (cp && isRenderableSmsSender(cp)) {
      smsMessages.push({ counterpart: cp, direction: "outbound", at: r.created_at });
    }
  }
  const smsThreads = groupSmsThreads(smsMessages);

  const aiFlowRuns: DigestAiFlowRun[] = (
    (flowsRes.data ?? []) as Array<{
      status: string;
      created_at: string;
      context: Record<string, unknown> | null;
      ai_flows: { name: string } | { name: string }[] | null;
    }>
  ).map((r) => {
    const flow = Array.isArray(r.ai_flows) ? r.ai_flows[0] : r.ai_flows;
    return {
      flowName: flow?.name ?? "AiFlow",
      status: r.status,
      created_at: r.created_at,
      context: r.context ?? {}
    };
  });

  const activity: DigestActivity = {
    chatTurns: chatRes.count ?? 0,
    smsInbound,
    smsOutbound,
    smsOutboundCustomer,
    smsThreads,
    calls: (callsRes.data ?? []) as DigestCallRow[],
    aiFlowRuns,
    newCustomers: (custRes.data ?? []) as DigestCustomerRow[],
    urgentAlerts: logRes.count ?? 0,
    notificationsDelivered: notifRes.count ?? 0
  };

  return { activity, error: firstError };
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await assertCronAuth(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  let window: DigestWindow = "daily";
  try {
    const body = await req.json();
    if (body && body.window === "weekly") window = "weekly";
  } catch {
    // Empty / non-JSON body — the original daily cron posts '{}'.
  }
  const digestLabel = window === "weekly" ? "Weekly digest" : "Daily digest";

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const supa = createClient(supabaseUrl, serviceKey);

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>";
  const replyTo = Deno.env.get("CONTACT_EMAIL");
  const adminEmail = (Deno.env.get("ADMIN_EMAIL") ?? "").trim() || null;
  // Strip trailing slash once so every downstream URL (`${appUrl}/dashboard`,
  // `${appUrl}/api/notifications/unsubscribe?bid=…`) is well-formed.
  const appUrl = (Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com").replace(
    /\/$/,
    ""
  );

  // Pull every business + its prefs in one shot. The RLS bypass via service
  // role makes this fine; we hand-filter the digest toggle after the join so
  // a business without a prefs row defaults-on (matches the
  // `notification_preferences` schema defaults).
  const { data: businessRows, error: bizErr } = await supa
    .from("businesses")
    .select("id, name, owner_email, status");
  if (bizErr) {
    console.error("digest.list_businesses", bizErr);
    return new Response("List failed", { status: 500 });
  }

  const businesses = (businessRows ?? []) as Array<{
    id: string;
    name: string | null;
    owner_email: string | null;
    status: string;
  }>;
  const liveBusinesses = businesses.filter((b) => b.status !== "wiped");
  if (liveBusinesses.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, window, sent: 0, skipped: 0, failed: 0, total: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const ids = liveBusinesses.map((b) => b.id);
  const { data: prefsRows } = await supa
    .from("notification_preferences")
    .select(
      "business_id, alert_email, digest_email_daily, digest_email_weekly, email_digest, email_digest_weekly, digest_customer_facing_only, unsubscribed_at"
    )
    .in("business_id", ids);
  type PrefsRow = {
    business_id: string;
    alert_email: string | null;
    digest_email_daily: string | null;
    digest_email_weekly: string | null;
    email_digest: boolean;
    email_digest_weekly: boolean;
    digest_customer_facing_only: boolean | null;
    unsubscribed_at: string | null;
  };
  const prefsByBiz = new Map<string, Omit<PrefsRow, "business_id">>();
  for (const row of (prefsRows ?? []) as PrefsRow[]) {
    prefsByBiz.set(row.business_id, {
      alert_email: row.alert_email,
      digest_email_daily: row.digest_email_daily,
      digest_email_weekly: row.digest_email_weekly,
      email_digest: row.email_digest,
      email_digest_weekly: row.email_digest_weekly,
      digest_customer_facing_only: row.digest_customer_facing_only,
      unsubscribed_at: row.unsubscribed_at
    });
  }

  const targets: DigestTarget[] = liveBusinesses.map((b) => {
    const prefs = prefsByBiz.get(b.id);
    return {
      business_id: b.id,
      business_name: b.name,
      owner_email: b.owner_email,
      // Default-on when no prefs row exists (matches table defaults).
      email_digest: prefs ? prefs.email_digest : true,
      email_digest_weekly: prefs ? prefs.email_digest_weekly : true,
      // Default-off (matches table default): full-activity gating unchanged.
      digest_customer_facing_only: prefs?.digest_customer_facing_only ?? false,
      alert_email: prefs?.alert_email ?? null,
      digest_email_daily: prefs?.digest_email_daily ?? null,
      digest_email_weekly: prefs?.digest_email_weekly ?? null,
      unsubscribed_at: prefs?.unsubscribed_at ?? null
    };
  });

  const windowMs = window === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of targets) {
    const toggleOn = window === "weekly" ? t.email_digest_weekly : t.email_digest;
    // Window-specific recipient override first, then the legacy chain.
    const windowOverride = window === "weekly" ? t.digest_email_weekly : t.digest_email_daily;
    const fallbackRecipient = t.alert_email ?? t.owner_email ?? adminEmail;
    if (!toggleOn || t.unsubscribed_at) {
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        digestLabel,
        { window, recipient: windowOverride ?? fallbackRecipient },
        t.unsubscribed_at
          ? "unsubscribed"
          : window === "weekly"
            ? "email_digest_weekly_disabled"
            : "email_digest_disabled"
      );
      skipped += 1;
      continue;
    }

    const recipient = (windowOverride ?? fallbackRecipient ?? "").trim();
    if (!recipient) {
      await recordDigestRow(supa, t.business_id, "skipped", digestLabel, { window }, "no_email");
      skipped += 1;
      continue;
    }
    if (!resendKey) {
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        digestLabel,
        { window, recipient },
        "resend_unconfigured"
      );
      skipped += 1;
      continue;
    }

    const { activity, error: activityErr } = await fetchActivity(supa, t.business_id, since);
    if (activityErr) {
      console.error("digest.activity_query_failed", t.business_id, activityErr);
      await recordDigestRow(
        supa,
        t.business_id,
        "failed",
        digestLabel,
        { window, recipient },
        `activity_query_failed: ${activityErr}`
      );
      failed += 1;
      continue;
    }

    const sendWorthy = t.digest_customer_facing_only
      ? hasCustomerFacingDigestActivity(activity)
      : hasDigestActivity(activity);
    if (!sendWorthy) {
      // Distinguish "nothing at all happened" from "only routine background
      // activity happened" so the notifications row explains the skip.
      const reason =
        t.digest_customer_facing_only && hasDigestActivity(activity)
          ? "no_customer_facing_activity"
          : "no_activity";
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        digestLabel,
        { window, recipient },
        reason
      );
      skipped += 1;
      continue;
    }

    const unsubscribeUrl = buildUnsubscribeUrl(t.business_id, appUrl);
    const dashboardUrl = `${appUrl}/dashboard`;
    const model = buildDigestEmailModel({
      window,
      businessName: t.business_name ?? "your business",
      activity
    });

    const textLines: string[] = [model.intro, ""];
    const bodyBlocks: BrandedBodyBlock[] = [{ kind: "text", text: model.intro }];
    for (const section of model.sections) {
      textLines.push(`${section.heading}:`);
      for (const line of section.lines) textLines.push(`  • ${line}`);
      textLines.push("");
      bodyBlocks.push({
        kind: "text",
        text: [`${section.heading}:`, ...section.lines.map((l) => `• ${l}`)].join("\n")
      });
    }
    textLines.push(`Open the dashboard: ${dashboardUrl}`);
    textLines.push("");
    textLines.push("---");
    textLines.push(`Don't want these emails? Unsubscribe: ${unsubscribeUrl}`);
    const text = textLines.join("\n");

    const html = buildBrandedEmailHtml({
      siteUrl: appUrl,
      documentTitle: model.subject,
      heading: `${windowLabel(window).title}: ${t.business_name ?? "your business"}`,
      bodyBlocks,
      cta: { label: "Open dashboard", href: dashboardUrl },
      unsubscribeUrl,
      recipientEmail: recipient
    });

    const headers: Record<string, string> = {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    };

    // NB: the Resend REST API uses snake_case in the JSON body
    // (https://resend.com/docs/api-reference/emails/send-email) — `reply_to`,
    // not `replyTo`. The Resend SDK in src/lib/email/client.ts uses the
    // camelCase form because the SDK transforms it internally; direct REST
    // calls (here + supabase/functions/notifications/index.ts) must stick
    // to snake_case or the header is silently dropped.
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: model.subject,
        text,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        headers
      })
    });

    // Per-event deep links so the dashboard notification expands into the
    // actual events the digest counted.
    const events = buildDigestEventLinks(activity);

    if (res.ok) {
      await recordDigestRow(supa, t.business_id, "sent", model.subject, {
        window,
        recipient,
        activitySummary: model.activitySummary,
        events
      });
      sent += 1;
    } else {
      const body = await res.text().catch(() => "");
      console.error("digest.resend", t.business_id, res.status, body.slice(0, 500));
      await recordDigestRow(
        supa,
        t.business_id,
        "failed",
        model.subject,
        { window, recipient, activitySummary: model.activitySummary, events },
        `resend_${res.status}`
      );
      failed += 1;
    }
  }

  return new Response(
    JSON.stringify({ ok: failed === 0, window, sent, skipped, failed, total: targets.length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
