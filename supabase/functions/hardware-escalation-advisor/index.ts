/**
 * Hardware-escalation advisor cron (daily).
 *
 * Scheduled by `schedule_hardware_escalation_advisor.sql`. Scans every
 * active starter/standard tenant for sustained load (see
 * `_shared/hardware_escalation.ts` for the signal definitions), then:
 *
 *   - writes a per-tenant `system_logs` row (level=warn) so the flag shows
 *     up on that business's admin page (the "monitoring" surface), and
 *   - emails ONE digest to the ops inbox listing every flagged tenant with
 *     the recommended next box size and a deep link to the admin panel's
 *     migrate-size control.
 *
 * Escalation itself stays manual — this only advises. Dedupe: at most one
 * email per tenant per ISO week via the `mark_usage_cap_alert` guard
 * (kind `hardware_escalation_advice`), rolled back on send failure so the
 * next run retries.
 *
 * Enterprise tenants are skipped: their hardware is custom-managed and
 * their entitlements are per-business overrides.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import { VOICE_RES_LIMITS } from "../_shared/voice_reservation_limits.ts";
import {
  SMS_MONTHLY_CAP_STARTER,
  SMS_MONTHLY_CAP_STANDARD
} from "../_shared/sms_monthly_limits.ts";
import {
  ADVISOR_WINDOW_DAYS,
  DEFAULT_THRESHOLDS,
  ON_BOX_ERROR_SOURCES,
  buildEscalationAdviceEmail,
  evaluateEscalationSignals,
  weeklyPeriodKey,
  type AdvisorBusiness,
  type BusinessAdvice,
  type DailyUsageRow
} from "../_shared/hardware_escalation.ts";

const WINDOW_DAYS = ADVISOR_WINDOW_DAYS;

function isoDaysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
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
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>";
  // Same default as the app's opsNotificationEmail() (src/lib/email).
  const opsEmail = Deno.env.get("OPS_NOTIFICATION_EMAIL") ?? "team@newcoworker.com";
  const siteUrl = (Deno.env.get("APP_BASE_URL") ?? "https://www.newcoworker.com").replace(/\/$/, "");

  const supabase = createClient(supabaseUrl, serviceKey);
  const now = new Date();
  const periodKey = weeklyPeriodKey(now);

  // Fleet scan: active tenants only. `wiped` boxes have no hardware; paused
  // tenants can't generate load.
  const { data: bizRows, error: bizErr } = await supabase
    .from("businesses")
    .select("id, name, tier, vps_size, status, is_paused")
    .in("tier", ["starter", "standard"])
    .in("status", ["online", "high_load"]);
  if (bizErr) {
    console.error("businesses select failed", bizErr);
    return new Response("select failed", { status: 500 });
  }
  const businesses = ((bizRows ?? []) as Array<AdvisorBusiness & { status: string; is_paused: boolean | null }>)
    .filter((b) => !b.is_paused);

  if (businesses.length === 0) {
    await telemetryRecord(supabase, "hardware_escalation_advisor", {
      scanned: 0,
      flagged: 0,
      emailed: 0
    });
    return new Response(JSON.stringify({ ok: true, scanned: 0, flagged: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const ids = businesses.map((b) => b.id);
  const windowStartDate = isoDaysAgo(WINDOW_DAYS, now).slice(0, 10);
  const monthStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  // One fetch covers both windows: the month start is at most ~31 days back.
  const fetchFromDate = windowStartDate < monthStartDate ? windowStartDate : monthStartDate;

  const { data: usageRows, error: usageErr } = await supabase
    .from("daily_usage")
    .select("business_id, usage_date, voice_minutes_used, sms_sent, peak_concurrent_calls")
    .in("business_id", ids)
    .gte("usage_date", fetchFromDate);
  if (usageErr) {
    console.error("daily_usage select failed", usageErr);
    return new Response("select failed", { status: 500 });
  }

  const { data: errRows, error: logsErr } = await supabase
    .from("system_logs")
    .select("business_id")
    .in("business_id", ids)
    .in("source", [...ON_BOX_ERROR_SOURCES])
    .eq("level", "error")
    .gte("created_at", isoDaysAgo(WINDOW_DAYS, now));
  if (logsErr) {
    console.error("system_logs select failed", logsErr);
    return new Response("select failed", { status: 500 });
  }
  const errorCounts = new Map<string, number>();
  for (const row of (errRows ?? []) as Array<{ business_id: string }>) {
    errorCounts.set(row.business_id, (errorCounts.get(row.business_id) ?? 0) + 1);
  }

  const usageByBiz = new Map<string, DailyUsageRow[]>();
  const smsMonthToDate = new Map<string, number>();
  for (const row of (usageRows ?? []) as DailyUsageRow[]) {
    if (row.usage_date >= windowStartDate) {
      const list = usageByBiz.get(row.business_id) ?? [];
      list.push(row);
      usageByBiz.set(row.business_id, list);
    }
    if (row.usage_date >= monthStartDate) {
      smsMonthToDate.set(
        row.business_id,
        (smsMonthToDate.get(row.business_id) ?? 0) + row.sms_sent
      );
    }
  }

  const flagged: BusinessAdvice[] = [];
  for (const biz of businesses) {
    const limits = VOICE_RES_LIMITS[biz.tier];
    const advice = evaluateEscalationSignals({
      business: biz,
      usageRows: usageByBiz.get(biz.id) ?? [],
      monthToDateSms: smsMonthToDate.get(biz.id) ?? 0,
      onBoxErrorCount: errorCounts.get(biz.id) ?? 0,
      limits: {
        maxConcurrentCalls: limits.maxConcurrentCalls,
        voiceIncludedSecondsPerStripePeriod: limits.voiceIncludedSecondsPerStripePeriod,
        smsPerMonth: biz.tier === "starter" ? SMS_MONTHLY_CAP_STARTER : SMS_MONTHLY_CAP_STANDARD
      },
      thresholds: DEFAULT_THRESHOLDS
    });
    if (advice) flagged.push(advice);
  }

  // Weekly dedupe per tenant: claim the guard BEFORE sending, roll back on
  // send failure (same contract as cap_alerts.ts).
  const toEmail: BusinessAdvice[] = [];
  for (const advice of flagged) {
    const { data, error } = await supabase.rpc("mark_usage_cap_alert", {
      p_business_id: advice.businessId,
      p_cap_kind: "hardware_escalation_advice",
      p_period_key: periodKey
    });
    if (error) {
      console.error("mark_usage_cap_alert failed", advice.businessId, error.message);
      continue;
    }
    if (data !== true) continue; // already advised this week
    toEmail.push(advice);
    // Admin-page visibility while the condition persists (once per week,
    // matching the email cadence).
    await systemLog(supabase, {
      businessId: advice.businessId,
      source: "platform",
      level: "warn",
      event: "hardware_escalation_advice",
      message:
        `Sustained load: ${advice.signals.map((s) => s.kind).join(", ")} — ` +
        (advice.recommendedSize
          ? `consider migrating ${advice.currentSize} → ${advice.recommendedSize}`
          : `already on ${advice.currentSize} (largest box)`),
      payload: { signals: advice.signals, period_key: periodKey }
    });
  }

  let emailed = 0;
  if (toEmail.length > 0) {
    const unmarkAll = async (): Promise<void> => {
      for (const advice of toEmail) {
        const { error } = await supabase.rpc("unmark_usage_cap_alert", {
          p_business_id: advice.businessId,
          p_cap_kind: "hardware_escalation_advice",
          p_period_key: periodKey
        });
        if (error) console.error("unmark_usage_cap_alert failed", advice.businessId, error.message);
      }
    };

    if (!resendKey) {
      console.warn("RESEND_API_KEY unset; skipping escalation digest");
      await unmarkAll();
    } else {
      const { subject, text } = buildEscalationAdviceEmail(toEmail, siteUrl);
      // try/catch, not just !res.ok: a thrown fetch (network/DNS) must also
      // roll back the weekly claims or the digest silently skips a week.
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ from, to: [opsEmail], subject, text })
        });
        if (!res.ok) {
          const body = await res.text();
          console.error("Resend escalation digest failed", res.status, body.slice(0, 500));
          await unmarkAll();
        } else {
          emailed = toEmail.length;
        }
      } catch (err) {
        console.error("Resend escalation digest threw", err);
        await unmarkAll();
      }
    }
  }

  await telemetryRecord(supabase, "hardware_escalation_advisor", {
    scanned: businesses.length,
    flagged: flagged.length,
    emailed,
    period_key: periodKey
  });

  return new Response(
    JSON.stringify({ ok: true, scanned: businesses.length, flagged: flagged.length, emailed }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
