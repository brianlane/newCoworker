/**
 * Telnyx Messaging inbound → verify, at-least-once webhook handling, INSERT sms_inbound_jobs (§10).
 * STOP/HELP keywords: auto-reply when TELNYX_API_KEY + messaging env are set (carrier compliance).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { telnyxMessagingPhoneString } from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  inboundSmsBody,
  isHelpKeyword,
  isStartKeyword,
  isStopKeyword,
  telnyxSendSms
} from "../_shared/telnyx_sms_compliance.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import { evaluateSmsTrigger, isExecutableDefinition } from "../_shared/ai_flows/engine.ts";
import type {
  AiFlowDefinition,
  CorrelationMessage
} from "../_shared/ai_flows/types.ts";

const MAX_BODY = 256 * 1024;

/** A matched AiFlow plus the trigger-extracted vars for the enqueued run. */
type MatchedAiFlow = {
  id: string;
  def: AiFlowDefinition;
  url: string | null;
  windowText: string;
};

type AiFlowEval = { suppress: boolean; matched: MatchedAiFlow[] };

/**
 * Evaluate enabled AiFlow triggers for a business against the inbound message
 * plus a correlation window of the sender's recent messages (so a "text then
 * link" two-SMS lead still matches). Pure matching is delegated to the tested
 * engine; this only does the DB reads. NEVER throws — the caller treats any
 * failure as "no flows matched" so the inbound SMS path is never broken.
 */
async function evaluateAiFlows(
  supabase: ReturnType<typeof createClient>,
  businessId: string,
  current: { from: string; text: string; nowMs: number }
): Promise<AiFlowEval> {
  const { data: flowRows, error: flowErr } = await supabase
    .from("ai_flows")
    .select("id, definition")
    .eq("business_id", businessId)
    .eq("enabled", true);
  if (flowErr) {
    console.error("ai_flows load", flowErr);
    return { suppress: false, matched: [] };
  }
  const flows = (flowRows ?? []) as Array<{ id: string; definition: unknown }>;
  if (flows.length === 0) return { suppress: false, matched: [] };

  // Widest correlation window any flow asks for (default 10), so a single jobs
  // read serves them all; each flow still filters to its own window in-engine.
  let maxWindow = 10;
  for (const f of flows) {
    const cw = (f.definition as { trigger?: { correlationWindowMinutes?: number } })?.trigger
      ?.correlationWindowMinutes;
    if (typeof cw === "number" && cw > maxWindow) maxWindow = cw;
  }

  const messages: CorrelationMessage[] = [];
  // Bound the read by the widest window any flow asks for (the cutoff was
  // computed but previously unused), and raise the row cap so a single sender's
  // earlier "text then link" message isn't pushed out of the slice by other
  // senders' traffic before we filter to this sender below.
  const cutoffIso = new Date(current.nowMs - maxWindow * 60_000).toISOString();
  const { data: recentRows } = await supabase
    .from("sms_inbound_jobs")
    .select("payload, created_at")
    .eq("business_id", businessId)
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(200);
  const recent = (recentRows ?? []) as Array<{
    payload: Record<string, unknown>;
    created_at: string;
  }>;
  // Oldest-first so the engine's windowText reads in chronological order.
  for (const row of [...recent].reverse()) {
    const env = row.payload as { data?: { payload?: Record<string, unknown> } };
    const p = env?.data?.payload ?? {};
    const rFrom = normalizeE164(telnyxMessagingPhoneString(p, "from"));
    if (rFrom !== current.from) continue;
    const atMs = Date.parse(row.created_at);
    messages.push({
      text: inboundSmsBody(p),
      from: rFrom,
      atMs: Number.isFinite(atMs) ? atMs : current.nowMs
    });
  }
  // The current inbound is newest (it isn't in sms_inbound_jobs yet).
  messages.push({ text: current.text, from: current.from, atMs: current.nowMs });

  const matched: MatchedAiFlow[] = [];
  for (const f of flows) {
    if (!isExecutableDefinition(f.definition)) continue;
    const def = f.definition;
    const res = evaluateSmsTrigger(def.trigger, { messages, nowMs: current.nowMs });
    if (res.matched) {
      matched.push({ id: f.id, def, url: res.url, windowText: res.windowText });
    }
  }
  const suppress = matched.some((m) => m.def.options?.suppressDefaultReply === true);
  return { suppress, matched };
}

/**
 * Evaluate AiFlow triggers and enqueue one ai_flow_run per matched flow.
 * Runs FIRST (before stamping the inbound job) so the default Coworker reply is
 * only suppressed when an automation is actually queued to handle it. Returns
 * whether a flow that requested suppression has a queued run. Fully
 * failure-isolated: never throws, so the inbound SMS path is never broken.
 * Called from BOTH the normal enqueue path and the Safe-Mode forward path, so a
 * lead automation still starts even when the customer reply is handled manually.
 */
async function evaluateAndEnqueueAiFlows(
  supabase: ReturnType<typeof createClient>,
  businessId: string,
  ctx: { from: string | null; to: string; eventId: string; bodyText: string }
): Promise<{ suppressingRunQueued: boolean }> {
  let evalRes: AiFlowEval = { suppress: false, matched: [] };
  try {
    evalRes = await evaluateAiFlows(supabase, businessId, {
      from: ctx.from ?? "",
      text: ctx.bodyText,
      nowMs: Date.now()
    });
  } catch (e) {
    console.error("ai_flow trigger eval", e);
    return { suppressingRunQueued: false };
  }
  if (evalRes.matched.length === 0) return { suppressingRunQueued: false };

  let suppressingRunQueued = false;
  try {
    for (const m of evalRes.matched) {
      const { error: runErr } = await supabase.from("ai_flow_runs").insert({
        flow_id: m.id,
        business_id: businessId,
        status: "queued",
        context: {
          trigger: {
            url: m.url,
            windowText: m.windowText,
            from: ctx.from ?? "",
            to: ctx.to,
            event_id: ctx.eventId
          }
        },
        current_step: 0,
        dedupe_key: ctx.eventId
      });
      // 23505 = a prior webhook already queued it, which still counts as queued.
      const queued = !runErr || (runErr as { code?: string }).code === "23505";
      if (runErr && (runErr as { code?: string }).code !== "23505") {
        console.error("ai_flow_runs insert", runErr);
      }
      if (queued && m.def.options?.suppressDefaultReply === true) {
        suppressingRunQueued = true;
      }
    }
    await telemetryRecord(supabase, "ai_flow_runs_enqueued", {
      business_id: businessId,
      event_id: ctx.eventId,
      count: evalRes.matched.length,
      suppressed_reply: suppressingRunQueued
    });
  } catch (e) {
    console.error("ai_flow_runs enqueue", e);
  }
  return { suppressingRunQueued };
}

const HELP_REPLY_TEXT =
  "New Coworker: For help, use your business dashboard or contact support. Msg&data rates may apply. Reply STOP to opt out.";
const STOP_REPLY_TEXT =
  "You're opted out of New Coworker marketing SMS for this number. You may still get transactional messages.";
const START_REPLY_TEXT =
  "You're subscribed to New Coworker SMS for this number. Reply STOP to opt out. Msg&data rates may apply.";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const publicKey = Deno.env.get("TELNYX_PUBLIC_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const telnyxApiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  const messagingProfileId = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
  const smsFromE164 = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";

  if (!publicKey || !supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_sms_inbound"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const clientIp = telnyxWebhookClientIp(req);
  const rate = await telnyxWebhookRateAllow(
    supabase,
    clientIp,
    "telnyx_sms_inbound",
    readTelnyxWebhookRateLimits((k) => Deno.env.get(k))
  );
  if (!rate.ok) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "rate",
      route: "telnyx_sms_inbound",
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
      route: "telnyx_sms_inbound"
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
      route: "telnyx_sms_inbound",
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
    // Outbound DLR observability: log delivery_failed / sending_failed reasons
    // for outbound replies. Telnyx accepts the message (HTTP 200 + id) and
    // then the carrier silently drops it for unregistered A2P (10DLC),
    // policy violations, or destination-unreachable. Without surfacing the
    // `to[].status` from message.finalized we have no way to tell a "queued"
    // message apart from a "delivery_failed" one. Telemetry-only for now —
    // we don't fail the webhook on outbound DLRs.
    if (eventType === "message.finalized" || eventType === "message.sent") {
      const payload = (data?.payload ?? {}) as Record<string, unknown>;
      const recipients = Array.isArray(payload.to)
        ? (payload.to as Array<Record<string, unknown>>)
        : [];
      for (const recipient of recipients) {
        const status = typeof recipient.status === "string" ? recipient.status : "";
        if (status && status !== "delivered" && status !== "queued" && status !== "sent" && status !== "sending") {
          await telemetryRecord(supabase, "telnyx_sms_outbound_dlr", {
            event_id: eventId,
            event_type: eventType,
            outbound_message_id:
              typeof (payload.id as string | undefined) === "string"
                ? (payload.id as string)
                : null,
            recipient_e164: typeof recipient.phone_number === "string"
              ? (recipient.phone_number as string)
              : null,
            recipient_status: status,
            recipient_carrier:
              typeof recipient.carrier === "string" ? (recipient.carrier as string) : null,
            errors: Array.isArray(payload.errors) ? payload.errors : null
          });
        }
      }
      return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (eventType !== "message.received") {
      return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payload = (data?.payload ?? {}) as Record<string, unknown>;
    const to = normalizeE164(telnyxMessagingPhoneString(payload, "to"));
    const from = normalizeE164(telnyxMessagingPhoneString(payload, "from"));

    if (!to) {
      return new Response(JSON.stringify({ ok: true, skip: "no_to" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const bodyNorm = inboundSmsBody(payload).trim().toUpperCase();
    const canAutoReply = Boolean(telnyxApiKey && messagingProfileId && smsFromE164 && from);

    // Route lookup: compliance keyword handling must persist opt-out/in state keyed by
    // business + sender, so resolve the business here before the keyword branches. If
    // the DID isn't routed, we still auto-reply (carrier compliance applies per-DID),
    // just without DB persistence.
    const { data: route } = await supabase
      .from("telnyx_voice_routes")
      .select("business_id")
      .eq("to_e164", to)
      .maybeSingle();
    const businessId = (route?.business_id as string | undefined) ?? null;

    // Compliance auto-reply retry semantics:
    //   - If the opt-out/opt-in persist RPC fails, or the outbound auto-reply fails,
    //     return 503 so Telnyx retries the webhook. The inbound-event dedupe RPC keeps
    //     the outer handler idempotent (mark_complete is skipped on non-2xx response
    //     below), and `Idempotency-Key` on the Telnyx send dedupes the reply on Telnyx
    //     side if the webhook is retried after a successful send but a later failure.
    //   - Silently returning 200 on send failure would drop STOP/HELP/START confirmations
    //     without any retry — a carrier-compliance miss.
    const stopReplyIdem = `${eventId}:compliance-stop`;
    const helpReplyIdem = `${eventId}:compliance-help`;
    const startReplyIdem = `${eventId}:compliance-start`;

    if (isStopKeyword(bodyNorm)) {
      // CTIA / A2P 10DLC: STOP must suppress further messages until START. Persist the
      // opt-out BEFORE sending the confirmation reply so a crash between reply+persist
      // never re-messages an opted-out sender. The confirmation reply itself is allowed
      // under carrier rules even though downstream traffic is suppressed.
      if (businessId && from) {
        const { error: optErr } = await supabase.rpc("sms_set_opt_out", {
          p_business_id: businessId,
          p_sender_e164: from,
          p_kind: "stop"
        });
        if (optErr) {
          console.error("sms_set_opt_out", optErr);
          await telemetryRecord(supabase, "sms_compliance_persist_failed", {
            keyword: "stop",
            event_id: eventId,
            business_id: businessId,
            error: optErr.message
          });
          return new Response(JSON.stringify({ ok: false, error: "opt_out_persist_failed" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: STOP_REPLY_TEXT,
          idempotencyKey: stopReplyIdem
        });
        if (!send.ok) {
          console.error("compliance STOP reply", send.status, send.body.slice(0, 300));
          await telemetryRecord(supabase, "sms_compliance_reply_failed", {
            keyword: "stop",
            event_id: eventId,
            status: send.status
          });
          return new Response(JSON.stringify({ ok: false, error: "compliance_reply_failed" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else {
        console.warn("telnyx-sms-inbound: STOP without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_stop_keyword", {
        to,
        event_id: eventId,
        business_id: businessId,
        persisted: Boolean(businessId && from)
      });
      return new Response(JSON.stringify({ ok: true, compliance: "stop" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (isHelpKeyword(bodyNorm)) {
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: HELP_REPLY_TEXT,
          idempotencyKey: helpReplyIdem
        });
        if (!send.ok) {
          console.error("compliance HELP reply", send.status, send.body.slice(0, 300));
          await telemetryRecord(supabase, "sms_compliance_reply_failed", {
            keyword: "help",
            event_id: eventId,
            status: send.status
          });
          return new Response(JSON.stringify({ ok: false, error: "compliance_reply_failed" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else {
        console.warn("telnyx-sms-inbound: HELP without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_help_keyword", { to, event_id: eventId });
      return new Response(JSON.stringify({ ok: true, compliance: "help" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (isStartKeyword(bodyNorm)) {
      if (businessId && from) {
        const { error: clrErr } = await supabase.rpc("sms_clear_opt_out", {
          p_business_id: businessId,
          p_sender_e164: from
        });
        if (clrErr) {
          console.error("sms_clear_opt_out", clrErr);
          await telemetryRecord(supabase, "sms_compliance_persist_failed", {
            keyword: "start",
            event_id: eventId,
            business_id: businessId,
            error: clrErr.message
          });
          return new Response(JSON.stringify({ ok: false, error: "opt_in_persist_failed" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: START_REPLY_TEXT,
          idempotencyKey: startReplyIdem
        });
        if (!send.ok) {
          console.error("compliance START reply", send.status, send.body.slice(0, 300));
          await telemetryRecord(supabase, "sms_compliance_reply_failed", {
            keyword: "start",
            event_id: eventId,
            status: send.status
          });
          return new Response(JSON.stringify({ ok: false, error: "compliance_reply_failed" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else {
        console.warn("telnyx-sms-inbound: START without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_start_keyword", {
        to,
        event_id: eventId,
        business_id: businessId,
        cleared: Boolean(businessId && from)
      });
      return new Response(JSON.stringify({ ok: true, compliance: "start" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (!businessId) {
      return new Response(JSON.stringify({ ok: true, skip: "unrouted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // route_to_team agent reply: a teammate currently being offered a lead texts
    // back 1 (claim) or 2 (reject). Intercept BEFORE the customer path so their
    // reply is never treated as a customer message or given a Coworker reply.
    // Matched to the pending offer by (business_id, awaiting_agent_e164) — the
    // indexed column the worker stamped when it paused. 1/2 don't collide with
    // STOP/HELP/START keywords (handled above), so compliance still runs first.
    if (from) {
      const replyBody = inboundSmsBody(payload).trim();
      if (replyBody === "1" || replyBody === "2") {
        const { data: offerRow } = await supabase
          .from("ai_flow_runs")
          .select("id, context")
          .eq("business_id", businessId)
          .eq("status", "awaiting_agent")
          .eq("awaiting_agent_e164", from)
          .order("respond_by_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        const offer = offerRow as
          | { id: string; context: Record<string, unknown> | null }
          | null;
        if (offer) {
          const claimed = replyBody === "1";
          const prevRouting =
            offer.context?.routing && typeof offer.context.routing === "object"
              ? { ...(offer.context.routing as Record<string, unknown>) }
              : {};
          prevRouting.last_event = claimed ? "claim" : "reject";
          prevRouting.reply_from = from;
          const nextContext = { ...(offer.context ?? {}), routing: prevRouting };
          // Guard on status so we never clobber a row the escalation sweep just
          // re-queued (the offer deadline and this reply can race).
          const { data: resumedRows, error: resumeErr } = await supabase
            .from("ai_flow_runs")
            .update({
              status: "queued",
              awaiting_agent_e164: null,
              respond_by_at: null,
              context: nextContext,
              updated_at: new Date().toISOString()
            })
            .eq("id", offer.id)
            .eq("status", "awaiting_agent")
            .select("id");
          if (resumeErr) {
            console.error("ai_flow_runs resume from agent reply", resumeErr);
            return new Response(
              JSON.stringify({ ok: false, error: "agent_resume_failed" }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }
          // Lost the race (sweep already re-queued it): fall through to normal
          // handling rather than double-acking.
          if ((resumedRows ?? []).length > 0) {
            const ack = claimed
              ? "Got it — you've claimed this lead. We'll send you the details."
              : "Okay — routing this lead to the next agent. Thanks!";
            if (canAutoReply) {
              const send = await telnyxSendSms({
                apiKey: telnyxApiKey,
                messagingProfileId,
                fromE164: smsFromE164,
                toE164: from,
                text: ack,
                idempotencyKey: `${eventId}:agent-ack`
              });
              if (!send.ok) {
                console.error("agent offer ack reply", send.status, send.body.slice(0, 300));
              }
            }
            await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
              business_id: businessId,
              run_id: offer.id,
              event_id: eventId,
              decision: claimed ? "claim" : "reject"
            });
            return new Response(
              JSON.stringify({ ok: true, agent_offer: claimed ? "claimed" : "rejected" }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
      }
    }

    // CTIA compliance gate: refuse to enqueue (and therefore refuse to auto-reply via
    // Rowboat) for senders who have already sent STOP. This is a hard-stop; no job row
    // is created so the worker never attempts an outbound reply.
    if (from) {
      const { data: optedRaw, error: optLookErr } = await supabase.rpc("sms_is_opted_out", {
        p_business_id: businessId,
        p_sender_e164: from
      });
      if (optLookErr) {
        console.error("sms_is_opted_out", optLookErr);
      } else if (optedRaw === true) {
        await telemetryRecord(supabase, "sms_inbound_suppressed_opt_out", {
          business_id: businessId,
          event_id: eventId
        });
        return new Response(JSON.stringify({ ok: true, skip: "opted_out" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Kill switch + Safe Mode gate (§CustomerChannelGate):
    //   is_paused           → drop the message, no reply, no forward.
    //   safe_mode + forward → forward the text to the owner's cell and stop.
    //   safe_mode w/o fwd   → treated as kill switch (fail-safe; the API
    //                         prevents this state but protects against
    //                         direct DB edits).
    // Runs AFTER STOP/HELP/START compliance so carrier-required auto-replies
    // always fire, and AFTER the opt-out check so we never forward messages
    // from suppressed senders.
    const { data: bizRow } = await supabase
      .from("businesses")
      .select("is_paused, customer_channels_enabled")
      .eq("id", businessId)
      .maybeSingle();
    const biz = bizRow as
      | { is_paused?: boolean; customer_channels_enabled?: boolean }
      | null;

    if (biz?.is_paused || biz?.customer_channels_enabled === false) {
      const { data: settingsRow } = await supabase
        .from("business_telnyx_settings")
        .select(
          "forward_to_e164, telnyx_messaging_profile_id, telnyx_sms_from_e164"
        )
        .eq("business_id", businessId)
        .maybeSingle();
      const settings = settingsRow as
        | {
            forward_to_e164?: string | null;
            telnyx_messaging_profile_id?: string | null;
            telnyx_sms_from_e164?: string | null;
          }
        | null;

      const gate = evaluateCustomerChannelGate({
        isPaused: Boolean(biz?.is_paused),
        customerChannelsEnabled: biz?.customer_channels_enabled !== false,
        forwardToE164: settings?.forward_to_e164 ?? null
      });

      if (gate.kind === "paused") {
        await telemetryRecord(supabase, "sms_inbound_killswitch", {
          business_id: businessId,
          event_id: eventId,
          is_paused: Boolean(biz?.is_paused),
          had_forward: Boolean((settings?.forward_to_e164 ?? "").trim())
        });
        return new Response(
          JSON.stringify({ ok: true, skip: "paused" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (gate.kind === "safe_mode_forward") {
        // Label is "[Safe Mode]" — Safe Mode is NOT the kill switch (paused path
        // is handled above), so saying "paused" would mislead the owner reading
        // the forwarded text on their phone.
        //
        // Mirror the worker's truncation contract (§sms-inbound-worker) so an
        // oversized MMS body cannot produce a multi-segment owner SMS or get
        // rejected outright by Telnyx:
        //   inbound body: cap to 1000 chars
        //   final forwarded text: cap to 1600 chars (Telnyx SMS limit)
        const rawBody = inboundSmsBody(payload).slice(0, 1000);
        const forwardText =
          `[Safe Mode] From ${from ?? "unknown"}: ${rawBody}`.slice(0, 1600);
        // Per-tenant settings override env fallbacks. `fwdFrom` may legitimately
        // be empty when the tenant relies on the messaging profile's number
        // pool — telnyxSendSms omits `from` when the string is empty.
        const fwdFrom =
          (settings?.telnyx_sms_from_e164 && settings.telnyx_sms_from_e164.trim()) ||
          smsFromE164;
        const fwdProfile =
          (settings?.telnyx_messaging_profile_id &&
            settings.telnyx_messaging_profile_id.trim()) ||
          messagingProfileId;
        // DO NOT require `fwdFrom` — profile-only sends are valid on Telnyx and
        // requiring it here would silently drop inbound customer SMS whenever
        // TELNYX_SMS_FROM_E164 is unset. The gate only needs api key + profile
        // + destination.
        const canForward = Boolean(telnyxApiKey && fwdProfile && gate.forwardToE164);
        if (canForward) {
          const send = await telnyxSendSms({
            apiKey: telnyxApiKey,
            messagingProfileId: fwdProfile,
            fromE164: fwdFrom,
            toE164: gate.forwardToE164,
            text: forwardText,
            idempotencyKey: `${eventId}:safe-mode-forward`
          });
          if (!send.ok) {
            console.error("sms_inbound safe mode forward", send.status, send.body.slice(0, 300));
            await telemetryRecord(supabase, "sms_inbound_safe_mode_forward_failed", {
              business_id: businessId,
              event_id: eventId,
              status: send.status
            });
            return new Response(
              JSON.stringify({ ok: false, error: "safe_mode_forward_failed" }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }
          await telemetryRecord(supabase, "sms_inbound_safe_mode_forwarded", {
            business_id: businessId,
            event_id: eventId,
            forwarded: true
          });
          // Safe Mode only changes how the CUSTOMER reply is handled (owner does
          // it manually); owner-configured lead automations must still start, so
          // enqueue any matched AiFlow runs. Evaluate BEFORE persisting the job
          // below (the engine appends the current message itself, so persisting
          // first would double-count it in the correlation window). The kill
          // switch (is_paused) above already stopped everything, and the worker
          // re-checks is_paused before any side effect.
          await evaluateAndEnqueueAiFlows(supabase, businessId, {
            from,
            to,
            eventId,
            bodyText: inboundSmsBody(payload)
          });
          // Persist the inbound as an already-`done` job so it still appears in
          // the AiFlow correlation window + audit trail for FUTURE messages
          // (a multi-message "text then link" flow must see this part later).
          // status='done' means the sms-inbound-worker never claims it, so there
          // is no double-forward and no AI reply.
          const { error: smJobErr } = await supabase.from("sms_inbound_jobs").insert({
            business_id: businessId,
            telnyx_event_id: eventId,
            payload: envelope as unknown as Record<string, unknown>,
            status: "done",
            suppress_reply: true,
            outbound_idempotency_key: crypto.randomUUID()
          });
          if (smJobErr && (smJobErr as { code?: string }).code !== "23505") {
            console.error("safe mode inbound persist", smJobErr);
          }
          return new Response(
            JSON.stringify({ ok: true, skip: "safe_mode_forwarded" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // Fallthrough: Safe Mode is on but forwarding credentials aren't
        // available (e.g. `TELNYX_API_KEY` unset, no messaging profile). We
        // must NOT short-circuit with `{ ok: true, skip: "safe_mode_forwarded",
        // forwarded: false }` — that silently drops the customer's message.
        // Instead, drop through to the regular enqueue path so:
        //   1. the inbound is persisted in sms_inbound_jobs (audit trail),
        //   2. the worker re-evaluates the gate with the same canForward
        //      check, and
        //   3. if still not forwardable, the worker dead-letters the job with
        //      `safe_mode_missing_telnyx_env` instead of pretending success.
        console.warn(
          "telnyx-sms-inbound: safe mode forward deferred to worker — missing send config"
        );
        await telemetryRecord(supabase, "sms_inbound_safe_mode_forward_deferred", {
          business_id: businessId,
          event_id: eventId,
          has_api_key: Boolean(telnyxApiKey),
          has_profile: Boolean(fwdProfile),
          has_forward_to: Boolean(gate.forwardToE164)
        });
        // Fallthrough — enqueue below.
      }
    }

    // Evaluate AiFlow triggers + enqueue runs up front so we only suppress the
    // default Coworker reply when an automation is actually queued to handle it.
    const { suppressingRunQueued } = await evaluateAndEnqueueAiFlows(supabase, businessId, {
      from,
      to,
      eventId,
      bodyText: inboundSmsBody(payload)
    });

    const { error } = await supabase.from("sms_inbound_jobs").insert({
      business_id: businessId,
      telnyx_event_id: eventId,
      payload: envelope as unknown as Record<string, unknown>,
      status: "pending",
      // Only suppress when a flow that requested it actually has a queued run.
      suppress_reply: suppressingRunQueued,
      outbound_idempotency_key: crypto.randomUUID()
    });

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Duplicate event: the first delivery already created the job. If THIS
        // delivery is the one that managed to queue a suppressing flow (e.g. the
        // first delivery's run insert failed and stamped suppress_reply=false),
        // promote the existing still-pending job to suppressed so it doesn't get
        // a normal Coworker reply alongside the AiFlow. Only touch pending rows
        // so we never race the worker after it has claimed the job.
        if (suppressingRunQueued) {
          await supabase
            .from("sms_inbound_jobs")
            .update({ suppress_reply: true })
            .eq("business_id", businessId)
            .eq("telnyx_event_id", eventId)
            .eq("status", "pending");
        }
        return new Response(JSON.stringify({ ok: true, duplicate_job: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      console.error("sms queue insert", error);
      return new Response("Queue error", { status: 500 });
    }

    await telemetryRecord(supabase, "sms_inbound_enqueued", { business_id: businessId, event_id: eventId });

    return new Response(JSON.stringify({ ok: true, enqueued: true }), {
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
