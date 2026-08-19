/**
 * Voice-bridge health cron.
 *
 * Scheduled every 5 minutes by `schedule_voice_bridge_health_alerts.sql`.
 * Alerts on:
 *   - Stale bridge heartbeats (`business_telnyx_settings.bridge_last_heartbeat_at` > threshold).
 *   - Stuck `voice_settlements` rows (`finalized_at IS NULL` with old `first_signal_at`).
 *
 * Always records a `voice_bridge_health_check` telemetry event.
 *
 * On a detected issue it EMAILS the admin, and additionally POSTs a
 * Slack-compatible webhook when `ALERT_WEBHOOK_URL` is set.
 *
 * The email exists because the webhook never did anything. `ALERT_WEBHOOK_URL`
 * has never been set in this project, so from the day this shipped its only
 * output was rows nobody reads, while it advertised itself (and is documented
 * in docs/VOICE-ROLLOUT.md) as paging on a dead bridge. A stale bridge means
 * that tenant's inbound calls are failing right now.
 *
 * Email is throttled to one per VOICE_HEALTH_ALERT_THROTTLE_MINUTES (default
 * 60). This sweep runs every 5 minutes and re-detects the same stale bridge
 * each time, so unthrottled it would send twelve mails an hour until someone
 * muted the thread, and a muted alert is the same as no alert. The webhook
 * keeps its original per-run behavior, which is what a chat channel expects.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  resolveAdminAlertConfig,
  sendAdminAlertEmail,
  shouldSendAdminAlert
} from "../_shared/admin_alert_email.ts";
import {
  DEFAULT_BRIDGE_STALE_SECONDS,
  DEFAULT_SETTLEMENT_STUCK_SECONDS,
  computeStaleBridges,
  computeStuckSettlements,
  formatAlertEmailBody,
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
    .select(
      "business_id, bridge_last_heartbeat_at, telnyx_connection_id, bridge_stale_alert_muted"
    );
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
      bridge_stale_alert_muted: boolean | null;
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

  // Per-tenant rows so a dead bridge shows up on that client's admin page,
  // not just in the fleet-wide webhook. Re-emitted each 5-min sweep while the
  // condition persists; retention prunes the history.
  for (const bridge of staleBridges) {
    await systemLog(supabase, {
      businessId: bridge.business_id,
      source: "voice",
      level: "error",
      event: "voice_bridge_stale",
      message: `Voice bridge heartbeat stale (last: ${bridge.bridge_last_heartbeat_at ?? "never"}), inbound calls will fail`,
      payload: {
        last_heartbeat_at: bridge.bridge_last_heartbeat_at,
        threshold_seconds: bridgeStaleSeconds
      }
    });
  }
  for (const settlement of stuckSettlements) {
    await systemLog(supabase, {
      businessId: settlement.business_id,
      source: "voice",
      level: "warn",
      event: "voice_settlement_stuck",
      message: `Voice settlement unfinalized since ${settlement.first_signal_at ?? "unknown"}`,
      payload: {
        call_control_id: settlement.call_control_id,
        first_signal_at: settlement.first_signal_at,
        threshold_seconds: settlementStuckSeconds
      }
    });
  }

  const hasIssue = staleBridges.length > 0 || stuckSettlements.length > 0;

  // Email the admin, throttled. This is the path that actually reaches a
  // person; the webhook below is optional and, in this project, unset.
  let emailResult: string | null = null;
  if (hasIssue) {
    const throttleMinutes = parsePositiveInt(
      Deno.env.get("VOICE_HEALTH_ALERT_THROTTLE_MINUTES"),
      60
    );
    // Last send is read back from our own telemetry rather than a new table:
    // one row per send, already retained, and a duplicate email costs far
    // less than a migration for bookkeeping.
    let lastSentAt: string | null = null;
    const { data: priorRows } = await supabase
      .from("telemetry_events")
      .select("created_at")
      .eq("event_type", "voice_bridge_health_email_sent")
      .order("created_at", { ascending: false })
      .limit(1);
    const prior = (priorRows ?? [])[0] as { created_at?: string } | undefined;
    if (prior?.created_at) lastSentAt = prior.created_at;

    if (!shouldSendAdminAlert(lastSentAt, nowMs, throttleMinutes)) {
      emailResult = "throttled";
    } else {
      const config = resolveAdminAlertConfig((name) => Deno.env.get(name));
      if (!config) {
        emailResult = "unconfigured";
        console.error("voice-bridge-health-alerts: issue detected but no alert email configured");
        await telemetryRecord(supabase, "voice_bridge_health_email_unconfigured", {
          stale_bridges: staleBridges.length,
          stuck_settlements: stuckSettlements.length
        });
      } else {
        emailResult = await sendAdminAlertEmail((url, init) => fetch(url, init), config, {
          subject:
            `Voice bridge health: ${staleBridges.length} stale, ` +
            `${stuckSettlements.length} stuck settlements`,
          // The EMAIL body, not the chat blurb: it names the affected
          // tenants. formatAlertSummary is counts only, which is fine beside
          // Slack attachments and useless in a mail that has none.
          text: formatAlertEmailBody(alert)
        });
        // Stamped only on a real send, so a failed one retries next tick
        // instead of being throttled out for the next hour.
        if (emailResult === "sent") {
          await telemetryRecord(supabase, "voice_bridge_health_email_sent", {
            stale_bridges: staleBridges.length,
            stuck_settlements: stuckSettlements.length
          });
        } else {
          await telemetryRecord(supabase, "voice_bridge_health_email_failed", {
            stale_bridges: staleBridges.length,
            stuck_settlements: stuckSettlements.length
          });
        }
      }
    }
  }

  // The webhook stays, unchanged and still optional, for anyone who does set
  // ALERT_WEBHOOK_URL. Unlike the email it is NOT throttled: a chat channel
  // is expected to show a condition persisting.
  const webhookUrl = Deno.env.get("ALERT_WEBHOOK_URL") ?? "";
  let webhookResult: { ok: boolean; status: number; error?: string } | null = null;
  if (hasIssue && webhookUrl) {
    webhookResult = await postWebhook((url, init) => fetch(url, init), webhookUrl, alert);
    if (!webhookResult.ok) {
      await telemetryRecord(supabase, "voice_bridge_health_webhook_failed", {
        status: webhookResult.status,
        error: webhookResult.error ?? null
      });
    }
  }

  // Keep webhook error details out of the HTTP response — they may contain
  // upstream provider messages (Slack/Discord) or caught exception strings
  // which CodeQL flags as potential information exposure. The full
  // `webhookResult` (including `error`) is already captured server-side via
  // the `voice_bridge_health_webhook_failed` telemetry event above.
  const webhookResponse = webhookResult
    ? { ok: webhookResult.ok, status: webhookResult.status }
    : null;

  return new Response(
    JSON.stringify({
      ok: true,
      stale_bridges: staleBridges.length,
      stuck_settlements: stuckSettlements.length,
      email: emailResult,
      webhook: webhookResponse,
      summary: formatAlertSummary(alert)
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
