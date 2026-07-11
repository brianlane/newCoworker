/**
 * Gemini spend-velocity watchdog (admin alert).
 *
 * Every 10 minutes (pg_cron → this function, see migration
 * 20260821000001_spend_velocity_alerts.sql):
 *   1. Read the admin config (admin_platform_settings /
 *      'chat_spend_velocity_alert'): enabled toggle, threshold, window.
 *   2. Snapshot every business's current-period Gemini spend
 *      (owner_chat_model_spend) into chat_spend_velocity_snapshots.
 *   3. Compute per-business rolling-window deltas (pure logic in
 *      _shared/spend_velocity.ts) and email the platform admin for any
 *      business that spent MORE than the threshold inside the window.
 *   4. Dedupe via chat_spend_velocity_alerts (one alert per business per
 *      window; the row is claimed BEFORE the email and released on a send
 *      failure so the next tick retries).
 *   5. Prune snapshots older than 48h.
 *
 * Secrets: SUPABASE_*, INTERNAL_CRON_SECRET (bearer), RESEND_API_KEY,
 * MAILER_EMAIL; alert recipient = ADMIN_ALERT_EMAIL ?? ADMIN_EMAIL ??
 * CONTACT_EMAIL.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  SPEND_VELOCITY_SETTINGS_KEY,
  computeVelocityBreaches,
  formatSpendVelocityEmail,
  latestSpendPerBusiness,
  parseSpendVelocityConfig,
  type SnapshotRow,
  type SpendRow
} from "../_shared/spend_velocity.ts";

const SNAPSHOT_RETENTION_HOURS = 48;

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
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Config. A missing/malformed row degrades to the defaults (enabled,
  //    $3 / 120 min) via parseSpendVelocityConfig.
  const { data: settingsRow, error: settingsErr } = await supabase
    .from("admin_platform_settings")
    .select("value")
    .eq("key", SPEND_VELOCITY_SETTINGS_KEY)
    .maybeSingle();
  if (settingsErr) {
    console.error("spend-velocity: settings read failed", settingsErr);
    return new Response("Settings read failed", { status: 500 });
  }
  const config = parseSpendVelocityConfig(settingsRow?.value ?? null);
  if (!config.enabled) {
    return new Response(JSON.stringify({ ok: true, enabled: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const now = new Date();
  const windowStartIso = new Date(now.getTime() - config.windowMinutes * 60_000).toISOString();

  // 2. Current spend rows (cap the lookback so a years-old stale period row
  //    never masquerades as current — 62 days safely covers one monthly
  //    quota window plus slack).
  const lookbackIso = new Date(now.getTime() - 62 * 24 * 60 * 60 * 1000).toISOString();
  const { data: spendRows, error: spendErr } = await supabase
    .from("owner_chat_model_spend")
    .select("business_id, period_start, spend_micros")
    .gte("period_start", lookbackIso);
  if (spendErr) {
    console.error("spend-velocity: spend read failed", spendErr);
    return new Response("Spend read failed", { status: 500 });
  }
  const current = latestSpendPerBusiness((spendRows ?? []) as SpendRow[]);

  // 3. Window snapshots + recent alerts, then the pure breach computation.
  const { data: snapRows, error: snapErr } = await supabase
    .from("chat_spend_velocity_snapshots")
    .select("business_id, period_start, spend_micros, captured_at")
    .gte("captured_at", windowStartIso);
  if (snapErr) {
    console.error("spend-velocity: snapshot read failed", snapErr);
    return new Response("Snapshot read failed", { status: 500 });
  }
  const { data: alertRows, error: alertErr } = await supabase
    .from("chat_spend_velocity_alerts")
    .select("business_id, alerted_at")
    .gte("alerted_at", windowStartIso);
  if (alertErr) {
    console.error("spend-velocity: alert read failed", alertErr);
    return new Response("Alert read failed", { status: 500 });
  }

  const breaches = computeVelocityBreaches({
    current,
    snapshots: (snapRows ?? []) as SnapshotRow[],
    recentAlerts: alertRows ?? [],
    config,
    now
  });

  // 4. Alert. Claim the dedupe row first; release it if the email fails so
  //    the next tick retries instead of silently dropping the alert.
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>";
  const adminTo = (
    Deno.env.get("ADMIN_ALERT_EMAIL") ??
    Deno.env.get("ADMIN_EMAIL") ??
    Deno.env.get("CONTACT_EMAIL") ??
    ""
  ).trim();

  let sent = 0;
  let failed = 0;
  let raced = 0;
  for (const breach of breaches) {
    // ATOMIC claim (unique on business + window-length time bucket): two
    // overlapping invocations can't both pass — the loser gets NULL and
    // skips. See spend_velocity_try_claim_alert in the migration.
    const { data: claimId, error: claimErr } = await supabase.rpc(
      "spend_velocity_try_claim_alert",
      {
        p_business_id: breach.businessId,
        p_delta_micros: breach.deltaMicros,
        p_threshold_micros: config.thresholdMicros,
        p_window_minutes: config.windowMinutes
      }
    );
    if (claimErr) {
      console.error("spend-velocity: alert claim failed", breach.businessId, claimErr);
      failed += 1;
      continue;
    }
    if (claimId === null || claimId === undefined) {
      raced += 1;
      continue;
    }

    const release = async (reason: string) => {
      failed += 1;
      const { error: releaseErr } = await supabase
        .from("chat_spend_velocity_alerts")
        .delete()
        .eq("id", claimId);
      if (releaseErr) {
        console.error("spend-velocity: claim release failed", breach.businessId, releaseErr);
      }
      await telemetryRecord(supabase, "chat_spend_velocity_alert_failed", {
        business_id: breach.businessId,
        delta_micros: breach.deltaMicros,
        reason
      });
    };

    // EVERYTHING between claim and confirmed send lives inside this try:
    // a thrown fetch/DB exception must release the claim, otherwise the
    // dedupe row silently swallows the alert until the window ends
    // (Bugbot High on PR #504).
    try {
      if (!adminTo || !resendKey) {
        console.warn(
          "spend-velocity: alert email unconfigured (ADMIN_ALERT_EMAIL / RESEND_API_KEY)"
        );
        await release(adminTo ? "resend_key_missing" : "admin_email_missing");
        continue;
      }

      const { data: biz } = await supabase
        .from("businesses")
        .select("name")
        .eq("id", breach.businessId)
        .maybeSingle();
      const email = formatSpendVelocityEmail({
        breach,
        config,
        businessName: (biz?.name as string | undefined) ?? null
      });

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to: [adminTo], subject: email.subject, text: email.text })
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("spend-velocity: resend failed", res.status, body.slice(0, 300));
        await release(`resend_http_${res.status}`);
        continue;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("spend-velocity: send threw", breach.businessId, message);
      await release(`send_exception:${message.slice(0, 120)}`);
      continue;
    }
    sent += 1;
    await telemetryRecord(supabase, "chat_spend_velocity_alert_sent", {
      business_id: breach.businessId,
      delta_micros: breach.deltaMicros,
      threshold_micros: config.thresholdMicros,
      window_minutes: config.windowMinutes
    });
  }

  // 2b. Snapshot AFTER computing so this tick's rows never serve as their
  //     own baseline. Failures here only widen detection latency one tick.
  if (current.length > 0) {
    const { error: insErr } = await supabase.from("chat_spend_velocity_snapshots").insert(
      current.map((row) => ({
        business_id: row.business_id,
        period_start: row.period_start,
        spend_micros: row.spend_micros
      }))
    );
    if (insErr) {
      console.error("spend-velocity: snapshot insert failed", insErr);
    }
  }

  // 5. Prune.
  const pruneBeforeIso = new Date(
    now.getTime() - SNAPSHOT_RETENTION_HOURS * 60 * 60 * 1000
  ).toISOString();
  const { error: pruneErr } = await supabase
    .from("chat_spend_velocity_snapshots")
    .delete()
    .lt("captured_at", pruneBeforeIso);
  if (pruneErr) {
    console.error("spend-velocity: prune failed", pruneErr);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      enabled: true,
      businesses: current.length,
      breaches: breaches.length,
      sent,
      failed,
      raced
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
