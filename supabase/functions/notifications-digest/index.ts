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
//   NOTIFICATIONS_UNSUBSCRIBE_SECRET (optional; enables one-click unsubscribe)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function buildUnsubscribeUrl(businessId: string, appUrl: string): Promise<string | null> {
  const secret = (Deno.env.get("NOTIFICATIONS_UNSUBSCRIBE_SECRET") ?? "").trim();
  if (!secret) return null;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `v1.${businessId}.${issuedAt}`;
  const sig = base64UrlEncode(await hmacSha256(secret, payload));
  const token = `${payload}.${sig}`;
  return `${appUrl.replace(/\/$/, "")}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
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

function buildDigestText(opts: {
  businessName: string;
  logs: LogRow[];
  notifs: NotifSkim[];
  dashboardUrl: string;
  unsubscribeUrl: string | null;
}): { subject: string; text: string; activitySummary: string } {
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
    `Open the dashboard: ${opts.dashboardUrl}`
  ];
  if (opts.unsubscribeUrl) {
    lines.push("", "---", `Don't want these emails? Unsubscribe with one click: ${opts.unsubscribeUrl}`);
  }
  return {
    subject,
    text: lines.join("\n"),
    activitySummary: `${opts.logs.length} events (${urgent} urgent)`
  };
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
  const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com";

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

    const { data: logRows } = await supa
      .from("coworker_logs")
      .select("task_type, status, created_at")
      .eq("business_id", t.business_id)
      .gte("created_at", since);
    const logs = ((logRows ?? []) as LogRow[]).filter((l) => l.task_type !== "provisioning");

    const { data: notifRows } = await supa
      .from("notifications")
      .select("kind, status, created_at")
      .eq("business_id", t.business_id)
      .gte("created_at", since);
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

    const unsubscribeUrl = await buildUnsubscribeUrl(t.business_id, appUrl);
    const dashboardUrl = `${appUrl.replace(/\/$/, "")}/dashboard`;
    const { subject, text, activitySummary } = buildDigestText({
      businessName: t.business_name ?? "your business",
      logs,
      notifs,
      dashboardUrl,
      unsubscribeUrl
    });

    const headers: Record<string, string> = {};
    if (unsubscribeUrl) {
      headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

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
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {})
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
