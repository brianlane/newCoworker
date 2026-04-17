/**
 * §4.1: Email owners when included-pool headroom drops below threshold (default 300s).
 * Uses voice_list_low_balance_alert_targets; clears low_balance_alert_armed after send.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";

const THRESHOLD_SEC = 300;

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
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>";
  const replyTo = Deno.env.get("CONTACT_EMAIL");

  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { error: syncErr } = await supabase.rpc("voice_sync_low_balance_alert_armed", {
    p_threshold_seconds: THRESHOLD_SEC
  });
  if (syncErr) {
    console.error("voice_sync_low_balance_alert_armed", syncErr);
    return new Response("Re-arm sync failed", { status: 500 });
  }

  const { data: rows, error } = await supabase.rpc("voice_list_low_balance_alert_targets", {
    p_threshold_seconds: THRESHOLD_SEC
  });

  if (error) {
    console.error("voice_list_low_balance_alert_targets", error);
    return new Response("Query failed", { status: 500 });
  }

  const targets = (rows ?? []) as Array<{
    business_id: string;
    owner_email: string;
    stripe_period_start: string;
    included_headroom_seconds: number;
  }>;

  let sent = 0;
  let skipped = 0;

  for (const t of targets) {
    const to = (t.owner_email ?? "").trim();
    if (!to) {
      skipped += 1;
      continue;
    }

    if (!resendKey) {
      console.warn("RESEND_API_KEY unset; skipping low-balance email for", t.business_id);
      skipped += 1;
      continue;
    }

    const subject = "Voice included minutes running low";
    const text = [
      `Your included voice pool for the current billing period has less than ${THRESHOLD_SEC} seconds remaining`,
      `(about ${Math.max(0, t.included_headroom_seconds)} seconds of headroom right now).`,
      "",
      "Consider purchasing bonus voice seconds or upgrading your plan if you expect heavy call volume.",
      "",
      `Business ID: ${t.business_id}`
    ].join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Resend low-balance email failed", res.status, body.slice(0, 500));
      skipped += 1;
      continue;
    }

    const { error: markErr } = await supabase.rpc("voice_mark_low_balance_alerts_sent", {
      p_business_id: t.business_id,
      p_stripe_period_start: t.stripe_period_start
    });
    if (markErr) {
      // Critical: if we can't flip low_balance_alert_armed off after a successful send,
      // the next cron run will re-send the same email. Surface this so the next send is
      // skipped rather than counted: re-run of the cron will try the mark again, and the
      // email has already been delivered, so we'd rather silently skip + telemetry than
      // spam the owner.
      console.error(
        "voice_mark_low_balance_alerts_sent failed after email delivery",
        t.business_id,
        markErr
      );
      await telemetryRecord(supabase, "voice_low_balance_mark_failed", {
        business_id: t.business_id,
        stripe_period_start: t.stripe_period_start,
        error: markErr.message
      });
      skipped += 1;
      continue;
    }
    sent += 1;
  }

  await telemetryRecord(supabase, "voice_low_balance_alerts", { sent, skipped, candidates: targets.length });

  return new Response(JSON.stringify({ ok: true, sent, skipped, candidates: targets.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
