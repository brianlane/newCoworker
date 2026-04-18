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

  // Atomic claim: `voice_claim_low_balance_alert_targets` both reads the eligible rows
  // and flips `low_balance_alert_armed = false` in a single UPDATE…RETURNING (via a
  // CTE with `FOR UPDATE SKIP LOCKED`). Two overlapping cron runs can therefore never
  // see the same row as armed. On email-send failure we call
  // `voice_rearm_low_balance_alert_target` to re-arm just that owner so the next run
  // retries them without re-notifying owners that were successfully emailed in this
  // batch. This replaces the previous list → send → mark pattern, which could
  // duplicate emails when crons overlapped or when the mark RPC failed post-send.
  const { data: rows, error } = await supabase.rpc("voice_claim_low_balance_alert_targets", {
    p_threshold_seconds: THRESHOLD_SEC
  });

  if (error) {
    console.error("voice_claim_low_balance_alert_targets", error);
    return new Response("Claim failed", { status: 500 });
  }

  const targets = (rows ?? []) as Array<{
    business_id: string;
    owner_email: string;
    stripe_period_start: string;
    included_headroom_seconds: number;
  }>;

  let sent = 0;
  let skipped = 0;
  let rearmed = 0;

  const rearm = async (t: { business_id: string; stripe_period_start: string }, reason: string): Promise<void> => {
    const { error: rearmErr } = await supabase.rpc("voice_rearm_low_balance_alert_target", {
      p_business_id: t.business_id,
      p_stripe_period_start: t.stripe_period_start
    });
    if (rearmErr) {
      console.error("voice_rearm_low_balance_alert_target", t.business_id, rearmErr);
      await telemetryRecord(supabase, "voice_low_balance_rearm_failed", {
        business_id: t.business_id,
        stripe_period_start: t.stripe_period_start,
        reason,
        error: rearmErr.message
      });
      return;
    }
    rearmed += 1;
  };

  for (const t of targets) {
    const to = (t.owner_email ?? "").trim();
    if (!to) {
      // Row was claimed (disarmed) but we can't email — put it back so the next run
      // can retry if owner_email is populated by then.
      await rearm(t, "no_owner_email");
      skipped += 1;
      continue;
    }

    if (!resendKey) {
      console.warn("RESEND_API_KEY unset; skipping low-balance email for", t.business_id);
      await rearm(t, "resend_key_missing");
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
      await rearm(t, `resend_http_${res.status}`);
      skipped += 1;
      continue;
    }

    sent += 1;
  }

  await telemetryRecord(supabase, "voice_low_balance_alerts", {
    sent,
    skipped,
    rearmed,
    candidates: targets.length
  });

  return new Response(
    JSON.stringify({ ok: true, sent, skipped, rearmed, candidates: targets.length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
