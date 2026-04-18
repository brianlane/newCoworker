/**
 * Telnyx call hangup / end → record telnyx_ended_at for §9.1 settlement (signal1 of 2).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";

const MAX_BODY = 256 * 1024;

/** Hangup / ended only — avoid `call.cost` (may fire multiple times or off teardown timing). */
const END_EVENTS = new Set(["call.hangup", "call.ended"]);

function parseCallDurationSeconds(payload: Record<string, unknown>): number | null {
  const v = payload["call_duration"];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const publicKey = Deno.env.get("TELNYX_PUBLIC_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!publicKey || !supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_call_end"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_call_end"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const clientIp = telnyxWebhookClientIp(req);
  const rate = await telnyxWebhookRateAllow(
    supabase,
    clientIp,
    "telnyx_voice_call_end",
    readTelnyxWebhookRateLimits((k) => Deno.env.get(k))
  );
  if (!rate.ok) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "rate",
      route: "telnyx_voice_call_end",
      detail: rate.raw
    });
    return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });
  }

  const v = await verifyTelnyxWebhook(
    rawBody,
    header(req, "telnyx-signature-ed25519"),
    header(req, "telnyx-timestamp"),
    publicKey
  );
  if (!v.ok) {
    await telemetryRecord(supabase, "telnyx_webhook_signature_reject", {
      class: v.reason,
      route: "telnyx_voice_call_end"
    });
    return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  let envelope: { data?: { id?: string; event_type?: string; payload?: Record<string, unknown> } };
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const data = envelope.data;
  const eventId = data?.id;
  const eventType = data?.event_type ?? "";
  if (!eventId) {
    return new Response("Missing event id", { status: 400 });
  }

  const { data: beginRaw, error: beginErr } = await supabase.rpc("telnyx_webhook_try_begin", {
    p_event_id: eventId,
    p_event_type: eventType
  });
  if (beginErr) {
    console.error("telnyx_webhook_try_begin", beginErr);
    return new Response("Webhook begin error", { status: 500 });
  }
  const begin = beginRaw as { status?: string } | null;
  if (begin?.status === "done") {
    return new Response(
      JSON.stringify({ ok: true, duplicate: true, webhook_complete: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (begin?.status === "busy") {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "concurrent_claim",
      route: "telnyx_voice_call_end",
      event_id: eventId
    });
    return new Response(JSON.stringify({ ok: false, error: "event_in_flight" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (begin?.status !== "work") {
    console.error("telnyx_webhook_try_begin unexpected", beginRaw);
    return new Response("Webhook begin state error", { status: 500 });
  }

  const response = await (async (): Promise<Response> => {
  if (!END_EVENTS.has(eventType)) {
    return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const payload = data?.payload ?? {};
  const callControlId = String(payload["call_control_id"] ?? "");
  if (!callControlId) {
    return new Response(JSON.stringify({ ok: true, skip: "no_call_control_id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: resv, error: resvErr } = await supabase
    .from("voice_reservations")
    .select("business_id, id")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (resvErr) {
    console.error("voice_reservations", resvErr);
    return new Response("DB error", { status: 500 });
  }

  const businessId = resv?.business_id as string | undefined;
  if (!businessId) {
    return new Response(JSON.stringify({ ok: true, skip: "unknown_call" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const nowIso = new Date().toISOString();
  const reportedDurationSec = parseCallDurationSeconds(payload);
  const { data: existing, error: existingErr } = await supabase
    .from("voice_settlements")
    .select("call_control_id, first_signal_at, telnyx_reported_duration_seconds")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (existingErr) {
    console.error("voice_settlements select", existingErr);
    return new Response("DB error", { status: 500 });
  }

  const existingRow = existing as {
    first_signal_at?: string;
    telnyx_reported_duration_seconds?: number | null;
  } | null;

  const firstAt = existingRow?.first_signal_at ?? nowIso;

  let mergedReported: number | undefined;
  if (reportedDurationSec != null) {
    const prev = existingRow?.telnyx_reported_duration_seconds;
    if (typeof prev === "number" && Number.isFinite(prev) && prev >= 0) {
      // Telnyx may emit multiple hangup/end events; take the minimum reported duration (conservative for metering).
      mergedReported = Math.min(prev, reportedDurationSec);
    } else {
      mergedReported = reportedDurationSec;
    }
  }

  const settlementRow: Record<string, unknown> = {
    call_control_id: callControlId,
    business_id: businessId,
    reservation_id: resv?.id ?? null,
    telnyx_ended_at: nowIso,
    first_signal_at: firstAt
  };
  if (mergedReported != null) {
    settlementRow.telnyx_reported_duration_seconds = mergedReported;
  }

  const { error: upsertErr } = await supabase.from("voice_settlements").upsert(settlementRow, {
    onConflict: "call_control_id"
  });

  if (upsertErr) {
    console.error("voice_settlements upsert", upsertErr);
    return new Response("Settlement write failed", { status: 500 });
  }

  const { error: finErr, data: fin } = await supabase.rpc("voice_try_finalize_settlement", {
    p_call_control_id: callControlId,
    p_allow_one_sided: false
  });
  if (finErr) {
    console.error("voice_try_finalize_settlement", finErr);
    return new Response("Finalize RPC failed", { status: 500 });
  }
  const finJson = fin as { ok?: boolean; billable_seconds?: number } | null;
  if (finJson?.ok === true && typeof finJson.billable_seconds === "number") {
    await telemetryRecord(supabase, "voice_call_settlement_finalized", {
      call_control_id: callControlId,
      billable_seconds: finJson.billable_seconds
    });
  }

  return new Response(JSON.stringify({ ok: true, call_control_id: callControlId, finalize: finJson }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  })();

  if (response.ok) {
    const { error: mErr } = await supabase.rpc("telnyx_webhook_mark_complete", { p_event_id: eventId });
    if (mErr) console.error("telnyx_webhook_mark_complete", mErr);
  }
  return response;
});
