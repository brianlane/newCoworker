/**
 * Voice-bridge health cron.
 *
 * Scheduled every 5 minutes by `schedule_voice_bridge_health_alerts.sql`.
 * Alerts on:
 *   - Stale bridge heartbeats (`business_telnyx_settings.bridge_last_heartbeat_at` > threshold).
 *   - Stuck `voice_settlements` rows (`finalized_at IS NULL` with old `first_signal_at`).
 *
 * Always records a `voice_bridge_health_check` telemetry event. Optionally
 * POSTs a Slack-compatible webhook when `ALERT_WEBHOOK_URL` is set AND at
 * least one issue is detected.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  DEFAULT_BRIDGE_STALE_SECONDS,
  DEFAULT_SETTLEMENT_STUCK_SECONDS,
  computeStaleBridges,
  computeStuckSettlements,
  formatAlertSummary,
  parsePositiveInt,
  postWebhook,
  type AlertPayload
} from "../_shared/voice_bridge_health.ts";

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

  const bridgeStaleSeconds = parsePositiveInt(
    Deno.env.get("VOICE_HEALTH_BRIDGE_STALE_SECONDS"),
    DEFAULT_BRIDGE_STALE_SECONDS
  );
  const settlementStuckSeconds = parsePositiveInt(
    Deno.env.get("VOICE_HEALTH_SETTLEMENT_STUCK_SECONDS"),
    DEFAULT_SETTLEMENT_STUCK_SECONDS
  );

  const nowMs = Date.now();

  // Pull all tenants with voice wired up. We scan in-memory because the
  // active fleet is small (< 10_000 rows) and the alternative (server-side
  // timestamp filter) requires a more brittle PostgREST clause when
  // `bridge_last_heartbeat_at` is NULL. computeStaleBridges handles both.
  const { data: bridgeRows, error: bridgeErr } = await supabase
    .from("business_telnyx_settings")
    .select("business_id, bridge_last_heartbeat_at, telnyx_connection_id");
  if (bridgeErr) {
    console.error("business_telnyx_settings select failed", bridgeErr);
    await telemetryRecord(supabase, "voice_bridge_health_error", {
      stage: "select_bridges",
      error: bridgeErr.message
    });
    return new Response("select failed", { status: 500 });
  }

  // Unfinalized settlements only — RLS is service-role so no further filter needed.
  const { data: settleRows, error: settleErr } = await supabase
    .from("voice_settlements")
    .select("call_control_id, business_id, first_signal_at, finalized_at")
    .is("finalized_at", null);
  if (settleErr) {
    console.error("voice_settlements select failed", settleErr);
    await telemetryRecord(supabase, "voice_bridge_health_error", {
      stage: "select_settlements",
      error: settleErr.message
    });
    return new Response("select failed", { status: 500 });
  }

  const staleBridges = computeStaleBridges(
    (bridgeRows ?? []) as Array<{
      business_id: string;
      bridge_last_heartbeat_at: string | null;
      telnyx_connection_id: string | null;
    }>,
    nowMs,
    bridgeStaleSeconds
  );
  const stuckSettlements = computeStuckSettlements(
    (settleRows ?? []) as Array<{
      call_control_id: string;
      business_id: string;
      first_signal_at: string | null;
      finalized_at: string | null;
    }>,
    nowMs,
    settlementStuckSeconds
  );

  const alert: AlertPayload = {
    generated_at: new Date(nowMs).toISOString(),
    stale_bridges: staleBridges,
    stuck_settlements: stuckSettlements,
    thresholds: {
      bridge_stale_seconds: bridgeStaleSeconds,
      settlement_stuck_seconds: settlementStuckSeconds
    }
  };

  await telemetryRecord(supabase, "voice_bridge_health_check", {
    stale_bridges: staleBridges.length,
    stuck_settlements: stuckSettlements.length,
    bridge_stale_seconds: bridgeStaleSeconds,
    settlement_stuck_seconds: settlementStuckSeconds,
    summary: formatAlertSummary(alert)
  });

  const hasIssue = staleBridges.length > 0 || stuckSettlements.length > 0;
  const webhookUrl = Deno.env.get("ALERT_WEBHOOK_URL") ?? "";
  let webhookResult: { ok: boolean; status: number; error?: string } | null = null;
  if (hasIssue && webhookUrl) {
    webhookResult = await postWebhook(
      (url, init) => fetch(url, init),
      webhookUrl,
      alert
    );
    if (!webhookResult.ok) {
      await telemetryRecord(supabase, "voice_bridge_health_webhook_failed", {
        status: webhookResult.status,
        error: webhookResult.error ?? null
      });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      stale_bridges: staleBridges.length,
      stuck_settlements: stuckSettlements.length,
      webhook: webhookResult,
      summary: formatAlertSummary(alert)
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
