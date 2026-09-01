/**
 * Weekly Telnyx outbound-capacity review (pg_cron -> this function, Mondays
 * 15:00 UTC; see migration 20260822144118).
 *
 * Counts the last 14 days of REAL capacity refusals (carrier channel-limit
 * 403s + the platform gate's pre-dial blocks) and the fleet's committed
 * per-tenant carrier caps vs the granted account pool
 * (admin_platform_settings key telnyx_capacity), then emails the platform
 * admin a ready-to-send Telnyx raise request when either signal trips.
 * Dedupe rides voice_capacity_alerts with kind=capacity_monitor on a
 * week-long bucket, claim-before-send, so a cron double-fire cannot
 * double-email and a send failure retries next run.
 *
 * Secrets: SUPABASE_*, INTERNAL_CRON_SECRET, RESEND_API_KEY, MAILER_EMAIL,
 * ADMIN_ALERT_EMAIL (fallbacks ADMIN_EMAIL / CONTACT_EMAIL).
 * TELNYX_ACCOUNT_CHANNEL_LIMIT is only the fallback if the settings row
 * is missing.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { readTelnyxCapacityConfig } from "../_shared/platform_capacity.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { VOICE_RES_LIMITS } from "../_shared/voice_reservation_limits.ts";
import { resolveEnterpriseVoiceReservation } from "../_shared/enterprise_limits.ts";
import {
  sendVoiceCapacityAlertOnce,
  type CapacityAlertSupabase
} from "../_shared/voice_capacity_alert.ts";
import {
  CAPACITY_MONITOR_BUCKET_MINUTES,
  CAPACITY_MONITOR_LOOKBACK_DAYS,
  evaluateCapacityHeadroom,
  formatCapacityMonitorEmail,
  suggestedPoolRaise
} from "../_shared/voice_capacity_monitor.ts";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await assertCronAuth(req))) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const sinceIso = new Date(
    Date.now() - CAPACITY_MONITOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { count: carrierRejections, error: rejErr } = await supabase
    .from("telemetry_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "voice_outbound_dial_failed")
    .eq("payload->>capacity", "true")
    .gte("created_at", sinceIso);
  if (rejErr) {
    console.error("voice-capacity-monitor: rejection count failed", rejErr);
    return json(500, { ok: false, error: "rejection_count_failed" });
  }

  const { count: platformBlocks, error: blockErr } = await supabase
    .from("telemetry_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "voice_outbound_blocked")
    .eq("payload->>reason", "platform_capacity")
    .gte("created_at", sinceIso);
  if (blockErr) {
    console.error("voice-capacity-monitor: block count failed", blockErr);
    return json(500, { ok: false, error: "block_count_failed" });
  }

  // Committed per-tenant carrier caps: every tenant with a DID contends for
  // the pool. Tiers resolve exactly like the reservation gate does.
  const { data: routeRows, error: routesErr } = await supabase
    .from("telnyx_voice_routes")
    .select("business_id");
  if (routesErr) {
    console.error("voice-capacity-monitor: routes read failed", routesErr);
    return json(500, { ok: false, error: "routes_read_failed" });
  }
  const businessIds = [...new Set((routeRows ?? []).map((r) => String(r.business_id)))];
  const tenantCaps: number[] = [];
  if (businessIds.length > 0) {
    const { data: bizRows, error: bizErr } = await supabase
      .from("businesses")
      .select("id, tier, enterprise_limits")
      .in("id", businessIds);
    if (bizErr) {
      console.error("voice-capacity-monitor: businesses read failed", bizErr);
      return json(500, { ok: false, error: "businesses_read_failed" });
    }
    for (const row of bizRows ?? []) {
      const tier = String((row as { tier?: unknown }).tier ?? "starter");
      if (tier === "enterprise") {
        tenantCaps.push(
          resolveEnterpriseVoiceReservation((row as { enterprise_limits?: unknown }).enterprise_limits)
            .maxConcurrent
        );
      } else if (tier === "standard") {
        tenantCaps.push(VOICE_RES_LIMITS.standard.maxConcurrentCalls);
      } else {
        tenantCaps.push(VOICE_RES_LIMITS.starter.maxConcurrentCalls);
      }
    }
  }

  const capacityConfig = await readTelnyxCapacityConfig(supabase, (name) => Deno.env.get(name));
  const inputs = {
    carrierRejections: carrierRejections ?? 0,
    platformBlocks: platformBlocks ?? 0,
    tenantCaps,
    accountLimit: capacityConfig.accountChannelLimit
  };
  const verdict = evaluateCapacityHeadroom(inputs);

  if (!verdict.alert) {
    return json(200, { ok: true, alert: false, ...inputs });
  }

  const email = formatCapacityMonitorEmail({
    verdict,
    inputs,
    suggestedPool: suggestedPoolRaise(verdict.committedCaps, inputs.accountLimit)
  });
  const result = await sendVoiceCapacityAlertOnce(
    supabase as unknown as CapacityAlertSupabase,
    {
      businessId: null,
      flowId: null,
      toE164: "fleet",
      httpStatus: 0,
      telnyxCode: null,
      telnyxTitle: null,
      connectionId: null
    },
    (name) => Deno.env.get(name),
    fetch,
    {
      kind: "capacity_monitor",
      bucketMinutes: CAPACITY_MONITOR_BUCKET_MINUTES,
      email
    }
  );
  await telemetryRecord(supabase, "voice_capacity_monitor_alert", {
    result,
    ...inputs,
    reasons: verdict.reasons
  });
  return json(200, { ok: true, alert: true, result, ...inputs });
});
