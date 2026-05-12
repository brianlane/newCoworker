// Supabase Edge Function: notifications-digest
//
// Daily digest sender. Scheduled by pg_cron (see migration
// 20260509000001_schedule_notifications_digest_cron.sql) and authenticated
// with INTERNAL_CRON_SECRET via the shared `_shared/cron_auth` helper.
//
// For every business where notification_preferences.email_digest is true and
// a resolvable email exists (preferences.alert_email > businesses.owner_email
// > ADMIN_EMAIL), build a 24h activity digest from coworker_logs +
// notifications and send via Resend. One `notifications` row per business
// (kind=digest, channel=email) is recorded with sent/failed/skipped status so
// the dashboard reflects the digest delivery state.
//
// Skipped reasons:
//   - email_digest_disabled: toggle is off
//   - unsubscribed: notification_preferences.unsubscribed_at is set
//   - no_email: no recipient could be resolved
//   - no_activity: nothing happened in the last 24h, suppress to keep the
//     digest meaningful
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildBrandedEmailHtml, type BrandedBodyBlock } from "../_shared/branded_email_html.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";

type SupaClient = ReturnType<typeof createClient>;

type DigestTarget = {
  business_id: string;
  business_name: string | null;
  owner_email: string | null;
  alert_email: string | null;
  email_digest: boolean;
  unsubscribed_at: string | null;
};

type LogRow = { task_type: string; status: string; created_at: string };
type NotifSkim = { kind: string | null; status: string; created_at: string };

// Plain `?bid=<businessId>` parameter — no HMAC. UUID v4 is unguessable and
// the unsubscribe action is a one-click flag the owner can re-enable from the
// dashboard. See src/app/api/notifications/unsubscribe/route.ts for the
// matching handler / threat-model rationale.
function buildUnsubscribeUrl(businessId: string, appUrl: string): string {
  // appUrl is normalized at the call site (trailing slash stripped); we keep
  // the helper signature explicit so callers can't accidentally pass a
  // partially-formed URL.
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

function buildDigestEmail(opts: {
  businessName: string;
  logs: LogRow[];
  notifs: NotifSkim[];
  dashboardUrl: string;
  unsubscribeUrl: string;
  appUrl: string;
  recipientEmail: string;
}): { subject: string; text: string; html: string; activitySummary: string } {
  const counts: Record<string, number> = {};
  for (const l of opts.logs) {
    counts[l.task_type] = (counts[l.task_type] ?? 0) + 1;
  }
  const urgent = opts.logs.filter((l) => l.status === "urgent_alert").length;
  const taskLines = Object.entries(counts)
    .map(([k, v]) => `  • ${k}: ${v}`)
    .join("\n");
  const unread = opts.notifs.filter((n) => n.status === "sent").length;
  const subject = `Daily summary — ${opts.businessName} (${opts.logs.length} events)`;
  const lines = [
    `Hi — here's a quick rundown from your AI Coworker over the last 24 hours.`,
    "",
    `Total events: ${opts.logs.length}`,
    urgent > 0 ? `Urgent alerts: ${urgent}` : "Urgent alerts: 0",
    `Notifications delivered: ${unread}`,
    "",
    taskLines.length > 0 ? `Breakdown:\n${taskLines}` : "No activity to break down.",
    "",
    `Open the dashboard: ${opts.dashboardUrl}`,
    "",
    "---",
    `Don't want these emails? Unsubscribe with one click: ${opts.unsubscribeUrl}`
  ];
  const text = lines.join("\n");
  const activitySummary = `${opts.logs.length} events (${urgent} urgent)`;

  const bodyBlocks: BrandedBodyBlock[] = [
    { kind: "text", text: `Hi — here's a quick rundown from your AI Coworker over the last 24 hours.` },
    {
      kind: "text",
      text: [
        `Total events: ${opts.logs.length}`,
        urgent > 0 ? `Urgent alerts: ${urgent}` : "Urgent alerts: 0",
        `Notifications delivered: ${unread}`
      ].join("\n")
    }
  ];
  if (taskLines.length > 0) {
    bodyBlocks.push({ kind: "text", text: `Breakdown:\n${taskLines}` });
  } else {
    bodyBlocks.push({ kind: "text", text: "No activity to break down." });
  }

  const siteUrl = opts.appUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl,
    documentTitle: subject,
    heading: subject,
    bodyBlocks,
    cta: { label: "Open dashboard", href: opts.dashboardUrl },
    unsubscribeUrl: opts.unsubscribeUrl,
    recipientEmail: opts.recipientEmail
  });

  return { subject, text, html, activitySummary };
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
  // role makes this fine; we hand-filter `email_digest` after the join so a
  // business without a prefs row defaults-on (matches the
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
      JSON.stringify({ ok: true, sent: 0, skipped: 0, failed: 0, total: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const ids = liveBusinesses.map((b) => b.id);
  const { data: prefsRows } = await supa
    .from("notification_preferences")
    .select("business_id, alert_email, email_digest, unsubscribed_at")
    .in("business_id", ids);
  const prefsByBiz = new Map<string, { alert_email: string | null; email_digest: boolean; unsubscribed_at: string | null }>();
  for (const row of (prefsRows ?? []) as Array<{
    business_id: string;
    alert_email: string | null;
    email_digest: boolean;
    unsubscribed_at: string | null;
  }>) {
    prefsByBiz.set(row.business_id, {
      alert_email: row.alert_email,
      email_digest: row.email_digest,
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
      alert_email: prefs?.alert_email ?? null,
      unsubscribed_at: prefs?.unsubscribed_at ?? null
    };
  });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of targets) {
    if (!t.email_digest || t.unsubscribed_at) {
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        "Daily digest",
        { recipient: t.alert_email ?? t.owner_email ?? adminEmail },
        t.unsubscribed_at ? "unsubscribed" : "email_digest_disabled"
      );
      skipped += 1;
      continue;
    }

    const recipient = (t.alert_email ?? t.owner_email ?? adminEmail ?? "").trim();
    if (!recipient) {
      await recordDigestRow(supa, t.business_id, "skipped", "Daily digest", {}, "no_email");
      skipped += 1;
      continue;
    }
    if (!resendKey) {
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        "Daily digest",
        { recipient },
        "resend_unconfigured"
      );
      skipped += 1;
      continue;
    }

    // Per-business activity pulls. Both queries can fail independently
    // (timeout, RLS misconfiguration, etc.); without surfacing the error
    // we'd treat every failure as "no activity" and silently swallow the
    // problem. Record a `failed` digest row instead so the dashboard
    // shows the operator something went wrong.
    const { data: logRows, error: logErr } = await supa
      .from("coworker_logs")
      .select("task_type, status, created_at")
      .eq("business_id", t.business_id)
      .gte("created_at", since);
    const { data: notifRows, error: notifErr } = await supa
      .from("notifications")
      .select("kind, status, created_at")
      .eq("business_id", t.business_id)
      .gte("created_at", since);

    if (logErr || notifErr) {
      const reason = logErr
        ? `coworker_logs_query_failed: ${logErr.message}`
        : `notifications_query_failed: ${(notifErr as { message: string }).message}`;
      console.error("digest.activity_query_failed", t.business_id, reason);
      await recordDigestRow(
        supa,
        t.business_id,
        "failed",
        "Daily digest",
        { recipient },
        reason
      );
      failed += 1;
      continue;
    }

    const logs = ((logRows ?? []) as LogRow[]).filter((l) => l.task_type !== "provisioning");
    const notifs = (notifRows ?? []) as NotifSkim[];

    if (logs.length === 0) {
      await recordDigestRow(
        supa,
        t.business_id,
        "skipped",
        "Daily digest",
        { recipient },
        "no_activity"
      );
      skipped += 1;
      continue;
    }

    const unsubscribeUrl = buildUnsubscribeUrl(t.business_id, appUrl);
    const dashboardUrl = `${appUrl}/dashboard`;
    const { subject, text, html, activitySummary } = buildDigestEmail({
      businessName: t.business_name ?? "your business",
      logs,
      notifs,
      dashboardUrl,
      unsubscribeUrl,
      appUrl,
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
        subject,
        text,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        headers
      })
    });

    if (res.ok) {
      await recordDigestRow(supa, t.business_id, "sent", subject, {
        recipient,
        activitySummary
      });
      sent += 1;
    } else {
      const body = await res.text().catch(() => "");
      console.error("digest.resend", t.business_id, res.status, body.slice(0, 500));
      await recordDigestRow(
        supa,
        t.business_id,
        "failed",
        subject,
        { recipient, activitySummary },
        `resend_${res.status}`
      );
      failed += 1;
    }
  }

  return new Response(
    JSON.stringify({ ok: failed === 0, sent, skipped, failed, total: targets.length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
