/**
 * Telnyx Messaging inbound → verify, at-least-once webhook handling, INSERT sms_inbound_jobs (§10).
 * STOP/HELP keywords: auto-reply when TELNYX_API_KEY + messaging env are set (carrier compliance).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import {
  telnyxMessagingParticipants,
  telnyxMessagingPhoneString
} from "../_shared/telnyx_messaging_payload.ts";
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
import { parseClaimWithTimeframe } from "../_shared/ai_flows/claim_timeframe.ts";
import {
  APPROVAL_OPTION_DECISIONS,
  approvalOptionForReply,
  parseStoredApprovalOptions
} from "../_shared/ai_flows/approval_options.ts";
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
  supabase: SupabaseClient<any, any, any>,
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
    // Only SMS-triggered flows react to an inbound text; manual / schedule /
    // email flows are started elsewhere (Run-now route, worker cron sweep,
    // mailbox poller).
    if (def.trigger.channel !== "sms") continue;
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
/** E.164-normalized, de-duped thread roster (sender + every `to`) for group replies. */
function normalizedParticipants(payload: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of telnyxMessagingParticipants(payload)) {
    const n = normalizeE164(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function evaluateAndEnqueueAiFlows(
  supabase: SupabaseClient<any, any, any>,
  businessId: string,
  ctx: {
    from: string | null;
    to: string;
    eventId: string;
    bodyText: string;
    /** Every E.164 number in the thread (sender + all `to`), for group replies. */
    participants: string[];
  }
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
            // The full thread roster (sender + every `to`). More than two
            // numbers means a group MMS — a send_sms { replyToGroup } step
            // posts back to everyone except our own DID.
            participants: ctx.participants,
            group: ctx.participants.length > 2,
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

/**
 * How long after a lead was last offered/handed back a teammate may still
 * claim it with "86". Bounds a stray "86" from reviving an ancient lead.
 */
const LATE_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a teammate/owner offer reply (claim "1", pass "2", "86" late-claim,
 * "<n>, <eta>", or an owner approval digit) to `sms_inbound_jobs` so it appears
 * in the dashboard Texts thread alongside the offer that prompted it.
 *
 * These replies are intercepted BEFORE the normal inbound path and resume an
 * AiFlow run directly (they must never be treated as customer messages), so
 * without this they never reach the SMS log and the thread shows only the
 * outbound offer. We store a terminal row (`status:'done'`, `suppress_reply`) so
 * the worker never re-processes it, with the confirmation we sent as the durable
 * `assistant_reply_text` — that renders BOTH the teammate's reply and our ack in
 * one conversational unit. Best-effort and idempotent on `telnyx_event_id`
 * (23505 = a Telnyx redelivery already logged it); a failure here never blocks
 * the offer resume that already happened.
 */
async function persistOfferReplyJob(args: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  businessId: string;
  eventId: string;
  envelope: unknown;
  from: string;
  staffKind: "owner" | "team";
  staffName?: string | null;
  /** The confirmation text we actually sent back, or null when none was sent. */
  ackSent: string | null;
}): Promise<void> {
  const ack = args.ackSent && args.ackSent.trim() ? args.ackSent : null;
  const { error } = await args.supabase.from("sms_inbound_jobs").insert({
    business_id: args.businessId,
    telnyx_event_id: args.eventId,
    payload: args.envelope as Record<string, unknown>,
    status: "done",
    suppress_reply: true,
    customer_e164: args.from,
    staff_kind: args.staffKind,
    staff_name: args.staffName?.trim() || null,
    assistant_reply_text: ack,
    outbound_idempotency_key: crypto.randomUUID()
  });
  if (error && (error as { code?: string }).code !== "23505") {
    console.error("offer reply persist", error);
  }
}

type LiveClaimArgs = {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  businessId: string;
  from: string;
  /** DID the inbound arrived on — safest ack sender fallback. */
  ackTo: string;
  eventId: string;
  /** Full Telnyx webhook envelope — persisted so the reply shows in Texts. */
  envelope: unknown;
  telnyxApiKey: string;
  messagingProfileId: string;
  smsFromE164: string;
  /** The leading reply digit ("3" in "3, 20 min"). */
  digit: string;
  /** The stated ETA (already parsed/trimmed). */
  timeframe: string;
};

/**
 * Handle a teammate's "claim WITH a timeframe" reply to a LIVE offer — the
 * "<n>, <eta>" option (e.g. "3, 20 min"). Resolves the teammate's currently
 * offered run and finalizes it as a claim with the ETA stamped on
 * routing.claim_timeframe (the worker appends it to the owner's claim notice +
 * the outcome). Returns a Response when consumed, or null when it should fall
 * through to the normal path — either this sender has no live offer, OR the
 * leading digit isn't an ACCEPT digit for that offer. The accept digits are
 * "1" (plain claim) and the offer's stamped `tf_digit` (the "accept with a
 * timeframe" option). This is what stops a round-robin "2, can't take it" (where
 * 2 means PASS) from being mis-recorded as a claim: digit 2 ≠ accept, so it
 * falls through and a real pass stays a bare "2".
 */
async function tryAgentClaimWithTimeframe(args: LiveClaimArgs): Promise<Response | null> {
  const { supabase, businessId, from, eventId, envelope, digit, timeframe } = args;

  const { data: offerRow } = await supabase
    .from("ai_flow_runs")
    .select("id, context")
    .eq("business_id", businessId)
    .in("status", ["awaiting_agent", "queued"])
    .eq("context->routing->>offered", from)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const offer = offerRow as { id: string; context: Record<string, unknown> | null } | null;
  if (!offer) return null;

  const prevRouting =
    offer.context?.routing && typeof offer.context.routing === "object"
      ? { ...(offer.context.routing as Record<string, unknown>) }
      : {};
  // Only "1" (plain accept) or this offer's stamped timeframe option count as a
  // claim. Any other comma'd digit (e.g. a round-robin "2" = pass) falls through
  // so it's never mis-recorded as a claim; a real pass is a bare digit.
  const tfDigit = typeof prevRouting.tf_digit === "string" ? prevRouting.tf_digit : "";
  if (digit !== "1" && !(tfDigit && digit === tfDigit)) return null;
  prevRouting.last_event = "claim";
  prevRouting.reply_from = from;
  prevRouting.claim_timeframe = timeframe;
  const nextContext = { ...(offer.context ?? {}), routing: prevRouting };
  const { error: resumeErr } = await supabase
    .from("ai_flow_runs")
    .update({
      status: "queued",
      awaiting_agent_e164: null,
      respond_by_at: null,
      context: nextContext,
      updated_at: new Date().toISOString()
    })
    .eq("id", offer.id)
    .in("status", ["awaiting_agent", "queued"]);
  if (resumeErr) {
    console.error("ai_flow_runs claim+timeframe resume", resumeErr);
    return new Response(JSON.stringify({ ok: false, error: "agent_resume_failed" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  // No claim acknowledgement is texted back: the offer SMS already carried the
  // lead details, so "you've claimed this lead, we'll tell the team..." only
  // promised a recap that never came. The reply is still logged (ackSent:null)
  // so the claim shows in the dashboard Texts thread, and the worker still
  // notifies the owner with the stated timeframe (routing.claim_timeframe).
  await persistOfferReplyJob({
    supabase,
    businessId,
    eventId,
    envelope,
    from,
    staffKind: "team",
    ackSent: null
  });
  await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
    business_id: businessId,
    run_id: offer.id,
    event_id: eventId,
    decision: "claim_timeframe"
  });
  return new Response(JSON.stringify({ ok: true, agent_offer: "claimed" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

type LateClaimArgs = {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  businessId: string;
  from: string;
  /** DID the inbound arrived on — safest ack/notify sender fallback. */
  ackTo: string;
  eventId: string;
  /** Full Telnyx webhook envelope — persisted so the reply shows in Texts. */
  envelope: unknown;
  telnyxApiKey: string;
  messagingProfileId: string;
  smsFromE164: string;
  /**
   * The leading reply digit ("4" in "4, 20 min"). A run is only late-claimable
   * when this equals its stamped late-claim option (routing.late_digit), so a
   * comma'd reply meant for a different run/flow never re-opens this one.
   */
  digit: string;
  /** Optional ETA the teammate stated ("4, 2 hours" → "2 hours"); "" when none. */
  timeframe?: string;
};

/**
 * Handle a teammate's retroactive (late) claim — a "<lateOpt>, <eta>" reply
 * where <lateOpt> is the flow's stamped late-claim option digit. Returns a
 * Response when the message was consumed (claimed or already-yours), or null
 * when no eligible offer exists so the caller can fall through to the normal
 * inbound path.
 *
 * Re-opens the most recent route_to_team run this teammate was offered (live or
 * already handed back to the owner) within LATE_CLAIM_WINDOW_MS WHOSE stamped
 * late-claim digit (routing.late_digit) matches the reply, rewinds it to the
 * route step (routing.step_index, stamped by the worker on park), and marks
 * routing.late_claim so the worker's claim path notifies the owner and then
 * finalizes WITHOUT replaying later steps.
 */
async function tryLateClaim(args: LateClaimArgs): Promise<Response | null> {
  const {
    supabase,
    businessId,
    from,
    ackTo,
    eventId,
    envelope,
    telnyxApiKey,
    messagingProfileId,
    smsFromE164,
    digit,
    timeframe
  } = args;
  const claimTimeframe = (timeframe ?? "").trim();

  // Sender resolution mirrors the 1/2 ack path: per-tenant settings win, then
  // the DID the message arrived on, then the global from.
  const { data: bizRow } = await supabase
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const biz = bizRow as
    | { telnyx_messaging_profile_id?: string | null; telnyx_sms_from_e164?: string | null }
    | null;
  const ackProfile =
    (biz?.telnyx_messaging_profile_id && biz.telnyx_messaging_profile_id.trim()) || messagingProfileId;
  const ackFrom = (biz?.telnyx_sms_from_e164 && biz.telnyx_sms_from_e164.trim()) || ackTo || smsFromE164;
  const canAck = Boolean(telnyxApiKey && ackProfile && from);
  // Send the confirmation AND log the teammate's reply (+ our ack) to the Texts
  // thread. Each consumed late-claim return calls this exactly once, so one row
  // is persisted per event; the no-match path returns without calling it (and
  // falls through to the normal inbound path, which logs its own row).
  const ack = async (text: string, keySuffix: string): Promise<void> => {
    let ackSent: string | null = null;
    if (canAck) {
      const send = await telnyxSendSms({
        apiKey: telnyxApiKey,
        messagingProfileId: ackProfile,
        fromE164: ackFrom,
        toE164: from,
        text,
        idempotencyKey: `${eventId}:${keySuffix}`
      });
      if (!send.ok) console.error("late-claim ack reply", send.status, send.body.slice(0, 300));
      else ackSent = text;
    }
    await persistOfferReplyJob({
      supabase,
      businessId,
      eventId,
      envelope,
      from,
      staffKind: "team",
      ackSent
    });
  };
  // Log the teammate's reply to the Texts thread WITHOUT texting any
  // confirmation back. Used for successful/idempotent claims: the offer SMS
  // already carried the lead details, so a "you've got this lead" ack only
  // promised a recap that never came. `ack` (which DOES text) is still used for
  // negative outcomes like losing the claim race.
  const logReply = (): Promise<void> =>
    persistOfferReplyJob({
      supabase,
      businessId,
      eventId,
      envelope,
      from,
      staffKind: "team",
      ackSent: null
    });

  // Recent route_to_team runs for this business (route steps stamp
  // context.routing). Newest first; 25 routing runs is plenty for a human
  // texting "86". Filter to context.routing IS NOT NULL so unrelated runs
  // (send_sms-only flows, approvals with no route step, etc.) don't consume
  // the cap and hide an eligible late-claim run within the 24h window.
  // Include awaiting_approval: after the owner fallback the worker can advance
  // past route_to_team and park a LATER step on an approval gate — that run is
  // still the teammate's most recent offered lead and must be visible to "86",
  // otherwise an older eligible run within 24h would be claimed instead.
  const { data: rows } = await supabase
    .from("ai_flow_runs")
    .select("id, status, context, awaiting_agent_e164, current_step, updated_at")
    .eq("business_id", businessId)
    .in("status", ["done", "awaiting_agent", "queued", "awaiting_approval"])
    .not("context->routing", "is", null)
    .order("updated_at", { ascending: false })
    .limit(25);
  const candidates =
    (rows as
      | Array<{
          id: string;
          status: string;
          context: Record<string, unknown> | null;
          awaiting_agent_e164: string | null;
          current_step: number | null;
          updated_at: string;
        }>
      | null) ?? [];

  const nowMs = Date.now();
  type Cand = (typeof candidates)[number];
  // A teammate can plausibly have more than one eligible run at once. Classify
  // each into three buckets and pick by PRECEDENCE rather than raw recency:
  //   1. live  — an active offer to this teammate (what reply "1" targets);
  //              wins even if an older eligible run was touched more recently.
  //   2. late  — a lapsed offer whose post-route steps already ran (re-open,
  //              the actual intent of "86"); beats a stale re-ack.
  //   3. mine  — a lead already claimed by this teammate (idempotent re-ack),
  //              only used when there's nothing fresh to claim.
  // Within each bucket the newest wins (candidates are newest-first).
  let liveMatch: Cand | null = null;
  let liveStep = -1;
  let lateMatch: Cand | null = null;
  let lateStep = -1;
  let mineMatch: Cand | null = null;
  for (const row of candidates) {
    if (liveMatch && lateMatch && mineMatch) break;
    const routing =
      row.context?.routing && typeof row.context.routing === "object"
        ? (row.context.routing as Record<string, unknown>)
        : null;
    if (!routing) continue;
    if (nowMs - Date.parse(row.updated_at) > LATE_CLAIM_WINDOW_MS) continue;
    // Only runs whose stamped late-claim digit matches this reply are eligible:
    // the late option is per-flow, so a "4, eta" reply must not re-open a run
    // whose late option was a different digit (or had none).
    const lateDigit = typeof routing.late_digit === "string" ? routing.late_digit : "";
    if (!lateDigit || lateDigit !== digit) continue;
    const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
    // Claimed by someone else → not available to this teammate.
    if (claimedBy && claimedBy !== from) continue;
    // Already this teammate's lead (claimed via 1, or a prior 86): re-ack
    // without re-opening. The worker clears routing.step_index when it
    // finalizes a claim, so this idempotent path must NOT require step_index —
    // gating on it here was why a repeat "86" fell through to the customer path.
    if (claimedBy === from) {
      if (!mineMatch) mineMatch = row;
      continue;
    }
    // A fresh claim needs the rewind target the worker stamped on park.
    const stepIndex = typeof routing.step_index === "number" ? routing.step_index : -1;
    if (stepIndex < 0) continue;
    const offered = typeof routing.offered === "string" ? routing.offered : "";
    const tried = Array.isArray(routing.tried)
      ? (routing.tried as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const everOffered = offered === from || row.awaiting_agent_e164 === from || tried.includes(from);
    if (!everOffered) continue;
    // Did the steps AFTER route_to_team already run? They did if the run
    // completed (status "done") OR the worker advanced current_step past the
    // route step (owner fallback ran later steps, then parked on e.g. a
    // quiet-hours defer or approval gate). Those are TRUE late claims.
    const currentStep = typeof row.current_step === "number" ? row.current_step : stepIndex;
    const postRouteRan = row.status === "done" || currentStep > stepIndex;
    if (postRouteRan) {
      // Any teammate who was ever offered this lead can take it now; the worker
      // re-runs only the route claim/notify and then ends (no step replay).
      if (!lateMatch) {
        lateMatch = row;
        lateStep = stepIndex;
      }
      continue;
    }
    // Still a LIVE offer parked at the route step (later steps not run yet).
    // Mirror reply "1": only the CURRENTLY offered teammate may claim, so a
    // teammate who already passed (in `tried`) can't preempt the active offer.
    if (offered === from && !liveMatch) {
      liveMatch = row;
      liveStep = stepIndex;
    }
  }

  // Precedence: live offer → fresh late claim → idempotent re-ack.
  let alreadyMine = false;
  let isLate = false;
  let matchStepIndex = -1;
  let match: Cand | null = null;
  if (liveMatch) {
    match = liveMatch;
    matchStepIndex = liveStep;
  } else if (lateMatch) {
    match = lateMatch;
    isLate = true;
    matchStepIndex = lateStep;
  } else if (mineMatch) {
    match = mineMatch;
    alreadyMine = true;
  }

  if (!match) return null;

  if (alreadyMine) {
    await logReply();
    await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
      business_id: businessId,
      run_id: match.id,
      event_id: eventId,
      decision: "late_claim_repeat"
    });
    return new Response(JSON.stringify({ ok: true, agent_offer: "already_claimed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Resolve the teammate's roster name so the owner's claimed-notify reads
  // "<name> claimed …" (offered_name was cleared on the owner fallback).
  const { data: memberRow } = await supabase
    .from("ai_flow_team_members")
    .select("name")
    .eq("business_id", businessId)
    .eq("phone_e164", from)
    .maybeSingle();
  const memberName = (memberRow as { name?: string } | null)?.name ?? "";

  const routing = { ...(match.context!.routing as Record<string, unknown>) };
  routing.last_event = "claim";
  routing.reply_from = from;
  routing.offered = from;
  if (memberName) routing.offered_name = memberName;
  // ETA the teammate stated ("86, 2 hours") → the worker appends it to the owner's
  // claim notice. Cleared when none so a re-claim never carries a stale ETA.
  if (claimTimeframe) routing.claim_timeframe = claimTimeframe;
  else delete routing.claim_timeframe;
  // late_claim flags a run whose post-route steps ALREADY ran (see matcher):
  // the worker re-runs just the route claim/notify and then ends, so
  // email/browse/notify aren't replayed. A still-live offer is left unflagged
  // so "86" continues the flow exactly like a "1" claim.
  if (isLate) routing.late_claim = true;
  const stepIndex = matchStepIndex;
  const nextContext = { ...(match.context ?? {}), routing };

  // Optimistic concurrency: gate the reopen on the exact updated_at we read.
  // Two teammates in `tried` can both text "86" before claimed_by is set;
  // this makes the FIRST write win (it changes updated_at, so the second
  // matches no row) instead of both overwriting routing and both being told
  // they got the lead. .select() lets us see whether we won.
  const { data: reopened, error: reopenErr } = await supabase
    .from("ai_flow_runs")
    .update({
      status: "queued",
      current_step: stepIndex,
      awaiting_agent_e164: null,
      respond_by_at: null,
      claimed_at: null,
      // Clear any stale quiet-hours deferral from an earlier park; otherwise
      // claim_ai_flow_runs would skip this run until that future time and the
      // claim/owner-notify would lag behind the teammate's immediate ack.
      earliest_claim_at: null,
      context: nextContext,
      updated_at: new Date().toISOString()
    })
    .eq("id", match.id)
    .eq("updated_at", match.updated_at)
    .in("status", ["done", "awaiting_agent", "queued", "awaiting_approval"])
    .select("id");
  if (reopenErr) {
    console.error("ai_flow_runs late-claim reopen", reopenErr);
    return new Response(JSON.stringify({ ok: false, error: "late_claim_failed" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (!reopened || (reopened as unknown[]).length === 0) {
    // Lost the race — a concurrent "86" or the worker mutated the row first.
    // Consume the message (it's still a teammate reply, never a customer text)
    // but don't claim a second time.
    await ack("Thanks — looks like this lead's already been handled.", "late-claim-race");
    await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
      business_id: businessId,
      run_id: match.id,
      event_id: eventId,
      decision: "late_claim_raced"
    });
    return new Response(JSON.stringify({ ok: true, agent_offer: "late_claim_raced" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  await logReply();
  await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
    business_id: businessId,
    run_id: match.id,
    event_id: eventId,
    decision: isLate ? "late_claim" : "late_option_live"
  });
  return new Response(JSON.stringify({ ok: true, agent_offer: "late_claimed" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

type UnclaimArgs = {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  businessId: string;
  from: string;
  /** DID the inbound arrived on — safest ack sender fallback. */
  ackTo: string;
  eventId: string;
  /** Full Telnyx webhook envelope — persisted so the reply shows in Texts. */
  envelope: unknown;
  telnyxApiKey: string;
  messagingProfileId: string;
  smsFromE164: string;
};

/**
 * Handle a teammate's retroactive UNCLAIM ("86"): they release a lead they had
 * claimed. Returns a Response when consumed, or null when this teammate has no
 * claimed lead to release (so the caller falls through to the normal path).
 *
 * Finds the most recent route_to_team run within LATE_CLAIM_WINDOW_MS whose
 * routing.claimed_by is this teammate, re-opens it at the durable route step
 * (routing.route_step_index, stamped on park and NOT cleared by the claim),
 * and stamps last_event='unclaim'. The worker then clears the claim, notifies
 * the owner the lead bounced back, and ends the run without replaying steps.
 */
async function tryUnclaim(args: UnclaimArgs): Promise<Response | null> {
  const {
    supabase,
    businessId,
    from,
    ackTo,
    eventId,
    envelope,
    telnyxApiKey,
    messagingProfileId,
    smsFromE164
  } = args;

  // Ack sender resolution mirrors the late-claim path.
  const { data: bizRow } = await supabase
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const biz = bizRow as
    | { telnyx_messaging_profile_id?: string | null; telnyx_sms_from_e164?: string | null }
    | null;
  const ackProfile =
    (biz?.telnyx_messaging_profile_id && biz.telnyx_messaging_profile_id.trim()) || messagingProfileId;
  const ackFrom = (biz?.telnyx_sms_from_e164 && biz.telnyx_sms_from_e164.trim()) || ackTo || smsFromE164;
  const canAck = Boolean(telnyxApiKey && ackProfile && from);
  const ack = async (text: string, keySuffix: string): Promise<void> => {
    let ackSent: string | null = null;
    if (canAck) {
      const send = await telnyxSendSms({
        apiKey: telnyxApiKey,
        messagingProfileId: ackProfile,
        fromE164: ackFrom,
        toE164: from,
        text,
        idempotencyKey: `${eventId}:${keySuffix}`
      });
      if (!send.ok) console.error("unclaim ack reply", send.status, send.body.slice(0, 300));
      else ackSent = text;
    }
    await persistOfferReplyJob({
      supabase,
      businessId,
      eventId,
      envelope,
      from,
      staffKind: "team",
      ackSent
    });
  };

  // Recent route_to_team runs this teammate may have claimed. A claim finalizes
  // the run as 'done' (claimed_by stamped on routing); include the same statuses
  // as late-claim so a re-opened/parked run is still findable.
  const { data: rows } = await supabase
    .from("ai_flow_runs")
    .select("id, status, context, updated_at")
    .eq("business_id", businessId)
    .in("status", ["done", "awaiting_agent", "queued", "awaiting_approval"])
    .not("context->routing", "is", null)
    .order("updated_at", { ascending: false })
    .limit(25);
  const candidates =
    (rows as
      | Array<{
          id: string;
          status: string;
          context: Record<string, unknown> | null;
          updated_at: string;
        }>
      | null) ?? [];

  const nowMs = Date.now();
  let match: (typeof candidates)[number] | null = null;
  let routeStepIndex = -1;
  for (const row of candidates) {
    const routing =
      row.context?.routing && typeof row.context.routing === "object"
        ? (row.context.routing as Record<string, unknown>)
        : null;
    if (!routing) continue;
    if (nowMs - Date.parse(row.updated_at) > LATE_CLAIM_WINDOW_MS) continue;
    // Only the teammate who currently holds the lead may release it.
    if (routing.claimed_by !== from) continue;
    // Need the durable route step to rewind to (stamped on park, survives the
    // claim). Without it we can't re-run the route handback cleanly.
    const idx =
      typeof routing.route_step_index === "number" ? routing.route_step_index : -1;
    if (idx < 0) continue;
    match = row;
    routeStepIndex = idx;
    break;
  }

  if (!match) return null;

  const routing = { ...(match.context!.routing as Record<string, unknown>) };
  routing.last_event = "unclaim";
  routing.reply_from = from;
  const nextContext = { ...(match.context ?? {}), routing };

  // Optimistic concurrency: gate on the exact updated_at we read so a racing
  // duplicate "86" (or the worker mutating the row) can't double-process.
  const { data: reopened, error: reopenErr } = await supabase
    .from("ai_flow_runs")
    .update({
      status: "queued",
      current_step: routeStepIndex,
      awaiting_agent_e164: null,
      respond_by_at: null,
      claimed_at: null,
      earliest_claim_at: null,
      context: nextContext,
      updated_at: new Date().toISOString()
    })
    .eq("id", match.id)
    .eq("updated_at", match.updated_at)
    .in("status", ["done", "awaiting_agent", "queued", "awaiting_approval"])
    .select("id");
  if (reopenErr) {
    console.error("ai_flow_runs unclaim reopen", reopenErr);
    return new Response(JSON.stringify({ ok: false, error: "unclaim_failed" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (!reopened || (reopened as unknown[]).length === 0) {
    await ack("Thanks — looks like this lead was already updated.", "unclaim-race");
    await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
      business_id: businessId,
      run_id: match.id,
      event_id: eventId,
      decision: "unclaim_raced"
    });
    return new Response(JSON.stringify({ ok: true, agent_offer: "unclaim_raced" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  await ack("Got it — you've released this lead. It's back with the owner.", "unclaim-ack");
  await telemetryRecord(supabase, "ai_flow_agent_offer_reply", {
    business_id: businessId,
    run_id: match.id,
    event_id: eventId,
    decision: "unclaim"
  });
  return new Response(JSON.stringify({ ok: true, agent_offer: "unclaimed" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
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
    //
    // Match on context.routing.offered (the agent the worker is currently
    // offering) rather than awaiting_agent_e164 alone: the escalation sweep can
    // re-queue the run (clearing awaiting_agent_e164) in the same window the
    // agent replies, but it leaves routing.offered set until the worker retires
    // it — so matching on routing.offered across both 'awaiting_agent' and
    // 'queued' avoids dropping a raced claim into the customer path. 1/2 don't
    // collide with STOP/HELP/START keywords (handled above).
    if (from) {
      const replyBody = inboundSmsBody(payload).trim();
      // "claim WITH a timeframe": "<n>, <eta>" (e.g. "4, 20 min"). The comma'd
      // ETA is the "accept and say when you'll reach out" option Dave-routed
      // offers advertise. The leading digit is just the displayed option number
      // (live claim vs. retroactive/late claim) — the comma is the real signal.
      const claimTf = parseClaimWithTimeframe(replyBody);

      // route_to_team retroactive UNCLAIM ("86"): a teammate RELEASES a lead
      // they had claimed; the worker hands it back to the owner. "86" no longer
      // means late-claim (that moved to the flow's lateClaimOption digit).
      // Matched BEFORE the 1-9 owner/agent block so a multi-digit "86" is never
      // misread as an approval digit; we accept a bare "86" or "86, <note>".
      if (replyBody === "86" || (claimTf && claimTf.digit === "86")) {
        const handled = await tryUnclaim({
          supabase,
          businessId,
          from,
          ackTo: to,
          eventId,
          envelope,
          telnyxApiKey,
          messagingProfileId,
          smsFromE164
        });
        if (handled) return handled;
        // No claimed lead for this teammate — fall through to the normal path
        // so a stray "86" is still handled like any other inbound text.
      }

      // Comma'd claim ("<n>, <eta>", n != 86): try a LIVE offer first (only the
      // ACCEPT digits "1" or the offer's timeframe option claim; a same-digit
      // PASS like a round-robin "2, can't take it" falls through). If no live
      // offer resolves it, try a retroactive/LATE claim keyed on the flow's
      // stamped late-claim digit (re-opens a lapsed offer within 24h).
      if (claimTf && claimTf.digit !== "86") {
        const liveHandled = await tryAgentClaimWithTimeframe({
          supabase,
          businessId,
          from,
          ackTo: to,
          eventId,
          envelope,
          telnyxApiKey,
          messagingProfileId,
          smsFromE164,
          digit: claimTf.digit,
          timeframe: claimTf.timeframe
        });
        if (liveHandled) return liveHandled;

        const lateHandled = await tryLateClaim({
          supabase,
          businessId,
          from,
          ackTo: to,
          eventId,
          envelope,
          telnyxApiKey,
          messagingProfileId,
          smsFromE164,
          digit: claimTf.digit,
          timeframe: claimTf.timeframe
        });
        if (lateHandled) return lateHandled;
      }

      // Single digits 1-9: agent offers understand 1/2; owner approvals map
      // the digit against the option list stored on the pending run (gates
      // offer up to 4 options today — approve / skip / bypass quiet hours /
      // cancel-last). Anything unmatched falls through to the customer path.
      if (/^[1-9]$/.test(replyBody)) {
        // AiFlow agent/owner acks must reply from the business's OWN number (the
        // per-tenant DID the worker also sends prompts from), NOT the global
        // TELNYX_SMS_FROM_E164 — otherwise the ack lands in a separate thread
        // from the prompt. Mirror the worker's messagingConfig: per-tenant
        // settings override env, and the DID the message arrived on (`to`) is
        // the safest final fallback (it's always a valid sender on the profile).
        const { data: bizSettingsRow } = await supabase
          .from("business_telnyx_settings")
          .select("forward_to_e164, telnyx_messaging_profile_id, telnyx_sms_from_e164")
          .eq("business_id", businessId)
          .maybeSingle();
        const bizSettings = bizSettingsRow as
          | {
              forward_to_e164?: string | null;
              telnyx_messaging_profile_id?: string | null;
              telnyx_sms_from_e164?: string | null;
            }
          | null;
        const ackProfile =
          (bizSettings?.telnyx_messaging_profile_id &&
            bizSettings.telnyx_messaging_profile_id.trim()) ||
          messagingProfileId;
        const ackFrom =
          (bizSettings?.telnyx_sms_from_e164 && bizSettings.telnyx_sms_from_e164.trim()) ||
          to ||
          smsFromE164;
        const canAck = Boolean(telnyxApiKey && ackProfile && from);

        const { data: offerRow } = await supabase
          .from("ai_flow_runs")
          .select("id, context")
          .eq("business_id", businessId)
          .in("status", ["awaiting_agent", "queued"])
          .eq("context->routing->>offered", from)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const offer = offerRow as
          | { id: string; context: Record<string, unknown> | null }
          | null;
        // Agent offers: "1" always claims. "2" is the PASS digit for round-robin
        // flows — UNLESS this offer's timeframe option IS "2" (a pinned, no-pass
        // flow like HomeLight: "Reply 1 to confirm, or 2 with a timeframe"), in
        // which case a bare "2" CLAIMS (no ETA) instead of being mis-read as a
        // pass that escalates to the owner. The offer's stamped tf_digit also lets
        // a bare timeframe digit (e.g. "3") claim. Any other digit falls through
        // to the owner-approval check and then the normal customer path.
        const offRouting =
          offer?.context?.routing && typeof offer.context.routing === "object"
            ? (offer.context.routing as Record<string, unknown>)
            : {};
        const offerTfDigit = typeof offRouting.tf_digit === "string" ? offRouting.tf_digit : "";
        const bareClaim = replyBody === "1" || (offerTfDigit !== "" && replyBody === offerTfDigit);
        const barePass = replyBody === "2" && offerTfDigit !== "2";
        if (offer && (bareClaim || barePass)) {
          const claimed = bareClaim;
          const prevRouting = { ...offRouting };
          prevRouting.last_event = claimed ? "claim" : "reject";
          prevRouting.reply_from = from;
          const nextContext = { ...(offer.context ?? {}), routing: prevRouting };
          // Only block terminal rows; 'awaiting_agent' and 'queued' are both
          // valid to resume (the latter covers the sweep-raced window above).
          const { error: resumeErr } = await supabase
            .from("ai_flow_runs")
            .update({
              status: "queued",
              awaiting_agent_e164: null,
              respond_by_at: null,
              context: nextContext,
              updated_at: new Date().toISOString()
            })
            .eq("id", offer.id)
            .in("status", ["awaiting_agent", "queued"]);
          if (resumeErr) {
            console.error("ai_flow_runs resume from agent reply", resumeErr);
            return new Response(
              JSON.stringify({ ok: false, error: "agent_resume_failed" }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }
          // A teammate's offer reply is NEVER a customer message: short-circuit
          // regardless of how many rows the guarded update touched.
          //
          // No claim/pass acknowledgement is texted back: the offer SMS already
          // carried the lead details, so "you've claimed this lead, we'll send
          // you the details" only promised a recap that never came. The reply is
          // still logged (ackSent:null) so the claim/pass shows in the Texts
          // thread; the owner is still notified of the claim by the worker.
          await persistOfferReplyJob({
            supabase,
            businessId,
            eventId,
            envelope,
            from,
            staffKind: "team",
            ackSent: null
          });
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

        // Owner approval via SMS: the digit maps against the option list the
        // worker STORED on the pending run when it parked (approve and skip
        // lead, optional extras like "bypass quiet hours" in between, cancel
        // is always the last digit) — mirroring the dashboard buttons
        // (decideAiFlowApproval). Only honored when the reply comes from the
        // business's configured owner forward number, and only after no agent
        // offer matched above (an owner who is also a roster agent
        // claims/rejects their own offer first). With multiple pending
        // approvals the reply resolves the most recently updated one — the
        // owner can always use the dashboard to disambiguate.
        if (businessId) {
          const ownerForward = normalizeE164(bizSettings?.forward_to_e164 ?? "");
          if (ownerForward && from === ownerForward) {
            const { data: apprRow } = await supabase
              .from("ai_flow_runs")
              .select("id, context")
              .eq("business_id", businessId)
              .eq("status", "awaiting_approval")
              .order("updated_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            const appr = apprRow as
              | { id: string; context: Record<string, unknown> | null }
              | null;
            const approvalCtx =
              appr?.context?.approval && typeof appr.context.approval === "object"
                ? (appr.context.approval as Record<string, unknown>)
                : null;
            const offered = parseStoredApprovalOptions(approvalCtx?.options);
            const option = appr ? approvalOptionForReply(offered, replyBody) : null;
            if (appr && option) {
              const decision = APPROVAL_OPTION_DECISIONS[option];
              // Replace context.approval wholesale (dropping any stale `consumed`
              // flag left by an earlier gate) so the worker resumes past THIS gate
              // — exactly what decideAiFlowApproval does for the dashboard path.
              // approve/skip/bypass re-queue the run (the worker consumes the
              // decision at the gate); deny cancels the whole run.
              const nextContext = {
                ...(appr.context ?? {}),
                approval: {
                  decision,
                  decided_by: `sms:${from}`,
                  note: null,
                  decided_at: new Date().toISOString()
                }
              };
              const { data: updatedRows, error: decideErr } = await supabase
                .from("ai_flow_runs")
                .update({
                  status: decision === "deny" ? "canceled" : "queued",
                  context: nextContext,
                  claimed_at: null,
                  updated_at: new Date().toISOString()
                })
                .eq("id", appr.id)
                .eq("status", "awaiting_approval")
                .select("id");
              if (decideErr) {
                console.error("ai_flow_runs approve from owner sms", decideErr);
                return new Response(
                  JSON.stringify({ ok: false, error: "approval_resume_failed" }),
                  { status: 503, headers: { "Content-Type": "application/json" } }
                );
              }
              // An owner's approval reply is NEVER a customer message: short-circuit
              // regardless of whether the guarded update raced the dashboard.
              const applied = (updatedRows ?? []).length > 0;
              const ack = !applied
                ? "That request was already handled — no change made."
                : decision === "approve"
                  ? "Approved — sending it now."
                  : decision === "bypass_quiet_hours"
                    ? "Approved — sending now, and I'll skip quiet hours for the rest of this workflow."
                    : decision === "skip"
                      ? "Skipped — I won't send that, but the rest of the workflow continues."
                      : "Canceled — I stopped the whole workflow.";
              let ackSent: string | null = null;
              if (canAck) {
                const send = await telnyxSendSms({
                  apiKey: telnyxApiKey,
                  messagingProfileId: ackProfile,
                  fromE164: ackFrom,
                  toE164: from,
                  text: ack,
                  idempotencyKey: `${eventId}:approval-ack`
                });
                if (!send.ok) {
                  console.error("approval ack reply", send.status, send.body.slice(0, 300));
                } else {
                  ackSent = ack;
                }
              }
              // Make the owner's approval reply (+ our ack) visible in Texts.
              await persistOfferReplyJob({
                supabase,
                businessId,
                eventId,
                envelope,
                from,
                staffKind: "owner",
                ackSent
              });
              await telemetryRecord(supabase, "ai_flow_approval_sms_reply", {
                business_id: businessId,
                run_id: appr.id,
                event_id: eventId,
                decision: applied ? decision : "noop"
              });
              return new Response(
                JSON.stringify({ ok: true, approval: applied ? decision : "noop" }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
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
      .select("is_paused, customer_channels_enabled, owner_name, phone")
      .eq("id", businessId)
      .maybeSingle();
    const biz = bizRow as
      | {
          is_paused?: boolean;
          customer_channels_enabled?: boolean;
          owner_name?: string | null;
          phone?: string | null;
        }
      | null;

    // Roster lookup for the team-member gate (applied below on BOTH the Safe
    // Mode path and the normal path — only the kill switch outranks it). A
    // roster employee's free-text reply (anything that wasn't a 1/2 offer
    // digit or an approval digit above) must NEVER be treated as a customer
    // message — no Coworker auto-reply, no AiFlow lead trigger, no
    // customer-memory profile. Fail CLOSED on a lookup error (503 → Telnyx
    // redelivers): silently treating an employee as a customer is exactly
    // what this gate exists to prevent.
    let teamMember: { name?: string | null } | null = null;
    // Owner vs employee — drives staff_kind on the queued job and the persona
    // the worker builds. Null whenever teamMember is null (ordinary customer).
    let teamMemberKind: "owner" | "team" | null = null;
    if (from) {
      const { data: memberRow, error: memberErr } = await supabase
        .from("ai_flow_team_members")
        .select("name")
        .eq("business_id", businessId)
        .eq("phone_e164", from)
        .eq("active", true)
        .maybeSingle();
      if (memberErr) {
        console.error("team member lookup", memberErr);
        return new Response(
          JSON.stringify({ ok: false, error: "team_lookup_failed" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
      teamMember = memberRow as { name?: string | null } | null;
      if (teamMember) teamMemberKind = "team";
      // The OWNER's own numbers get the same gate: a free text from the
      // owner is never a customer message, and without this the worker
      // would AI-chat with the owner and auto-create a customer profile for
      // their cell. Checked against ALL owner-configured numbers — the Safe
      // Mode forward cell, the notification alert phone, and the onboarding
      // phone — the same set `resolveContactNames` labels as "owner" on the
      // dashboard, so gate behavior and labeling can't disagree. The gate's
      // owner-forward is a no-op when sender === forward number.
      if (!teamMember) {
        const [fwdRes, prefsRes] = await Promise.all([
          supabase
            .from("business_telnyx_settings")
            .select("forward_to_e164")
            .eq("business_id", businessId)
            .maybeSingle(),
          supabase
            .from("notification_preferences")
            .select("phone_number")
            .eq("business_id", businessId)
            .maybeSingle()
        ]);
        if (fwdRes.error || prefsRes.error) {
          console.error("owner number lookup", fwdRes.error ?? prefsRes.error);
          return new Response(
            JSON.stringify({ ok: false, error: "team_lookup_failed" }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
        const ownerNumbers = [
          (fwdRes.data as { forward_to_e164?: string | null } | null)
            ?.forward_to_e164,
          (prefsRes.data as { phone_number?: string | null } | null)
            ?.phone_number,
          biz?.phone
        ].map((n) => normalizeE164(n ?? ""));
        if (ownerNumbers.some((n) => n && from === n)) {
          teamMember = { name: biz?.owner_name?.trim() || "Owner" };
          teamMemberKind = "owner";
        }
      }
    }

    // Staff-SMS behavior flags (default: assistant replies, no owner forward).
    // Only read when the sender is staff — customers never hit this path.
    let staffReplyEnabled = true;
    let staffForwardEnabled = false;
    if (teamMember) {
      const { data: staffCfg } = await supabase
        .from("business_telnyx_settings")
        .select(
          "staff_sms_assistant_reply_enabled, staff_sms_forward_to_owner_enabled"
        )
        .eq("business_id", businessId)
        .maybeSingle();
      if (staffCfg) {
        staffReplyEnabled =
          (staffCfg as { staff_sms_assistant_reply_enabled?: boolean | null })
            .staff_sms_assistant_reply_enabled !== false;
        staffForwardEnabled =
          (staffCfg as { staff_sms_forward_to_owner_enabled?: boolean | null })
            .staff_sms_forward_to_owner_enabled === true;
      }
    }

    // Owner/employee gate, shared by the Safe Mode and normal paths. Two
    // behaviors, controlled by the caller:
    //   reply=true   → enqueue a STAFF job (suppress_reply=false, staff_kind/
    //                  staff_name set). The worker answers in internal-assistant
    //                  mode — no lead intake, no customer profile — so staff can
    //                  text the assistant like they do in the dashboard chat.
    //   reply=false  → the legacy behavior: persist a suppressed `done` job so
    //                  there is no AI reply (used in Safe Mode, or when the
    //                  owner turns the staff reply off).
    //   forward=true → ALSO relay the text to the owner's cell ("[Team] …").
    // Either way the message never starts an AiFlow lead run and never creates
    // a customer-memory profile for a staff number.
    const respondTeamMemberGate = async (
      member: { name?: string | null },
      kind: "owner" | "team",
      opts: { reply: boolean; forward: boolean }
    ): Promise<Response> => {
      const { error: tmJobErr } = await supabase.from("sms_inbound_jobs").insert({
        business_id: businessId,
        telnyx_event_id: eventId,
        payload: envelope as unknown as Record<string, unknown>,
        // reply → leave the job claimable so the worker generates a staff reply;
        // otherwise mark it done so it stays audit-only with no outbound.
        status: opts.reply ? "pending" : "done",
        suppress_reply: !opts.reply,
        customer_e164: from,
        staff_kind: kind,
        staff_name: member.name?.trim() || null,
        outbound_idempotency_key: crypto.randomUUID()
      });
      if (tmJobErr && (tmJobErr as { code?: string }).code !== "23505") {
        console.error("team member inbound persist", tmJobErr);
        // When we PROMISED an assistant reply (reply=true), a lost `pending`
        // job means the texter would get nothing AND Telnyx would stop
        // retrying after our 200. Fail loudly so Telnyx retries; the insert is
        // idempotent on telnyx_event_id (a later success dedups via 23505) and
        // the owner forward below is idempotency-keyed, so no double-send.
        if (opts.reply) {
          return new Response(
            JSON.stringify({ ok: false, error: "staff_job_persist_failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      // Optional owner forward (mirrors the Safe Mode forward contract,
      // including its truncation caps). Skipped when the sender IS the
      // owner's forward number — no point forwarding to themselves.
      if (opts.forward) {
        const { data: fwdSettingsRow } = await supabase
          .from("business_telnyx_settings")
          .select("forward_to_e164, telnyx_messaging_profile_id, telnyx_sms_from_e164")
          .eq("business_id", businessId)
          .maybeSingle();
        const fwdSettings = fwdSettingsRow as
          | {
              forward_to_e164?: string | null;
              telnyx_messaging_profile_id?: string | null;
              telnyx_sms_from_e164?: string | null;
            }
          | null;
        const ownerCell = normalizeE164(fwdSettings?.forward_to_e164 ?? "");
        const fwdProfile =
          (fwdSettings?.telnyx_messaging_profile_id &&
            fwdSettings.telnyx_messaging_profile_id.trim()) ||
          messagingProfileId;
        const fwdFrom =
          (fwdSettings?.telnyx_sms_from_e164 && fwdSettings.telnyx_sms_from_e164.trim()) ||
          smsFromE164;
        if (telnyxApiKey && fwdProfile && ownerCell && from !== ownerCell) {
          const rawBody = inboundSmsBody(payload).slice(0, 1000);
          const who = member.name?.trim() || from;
          const send = await telnyxSendSms({
            apiKey: telnyxApiKey,
            messagingProfileId: fwdProfile,
            fromE164: fwdFrom,
            toE164: ownerCell,
            text: `[Team] ${who}: ${rawBody}`.slice(0, 1600),
            idempotencyKey: `${eventId}:team-forward`
          });
          if (!send.ok) {
            console.error("team member forward", send.status, send.body.slice(0, 300));
          }
        }
      }
      await telemetryRecord(supabase, "sms_inbound_team_member", {
        business_id: businessId,
        event_id: eventId,
        member_e164: from,
        staff_kind: kind,
        reply: opts.reply,
        forwarded: opts.forward
      });
      if (opts.reply) {
        return new Response(
          JSON.stringify({ ok: true, staff: kind }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, skip: "team_member" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

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
        // Team-member gate outranks Safe Mode handling (only the kill switch
        // above outranks the gate): an employee's text must not enqueue
        // AiFlow lead runs or be answered/forwarded as a customer message.
        // Safe Mode means the AI is off for everyone, so staff get the legacy
        // forward-and-suppress here regardless of the staff-reply toggle.
        if (teamMember) {
          return await respondTeamMemberGate(teamMember, teamMemberKind ?? "team", {
            reply: false,
            forward: true
          });
        }
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
            bodyText: inboundSmsBody(payload),
            participants: normalizedParticipants(payload)
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
            // Safe Mode persists the job as `done`, so the worker never claims it
            // to denormalize the sender. Stamp it here so the contact page still
            // surfaces these inbound texts.
            customer_e164: from,
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

    // Team-member gate, normal path (the Safe Mode branch above applies the
    // same gate before its forward). Staff get an internal-assistant reply
    // when enabled (the default), with an optional owner forward.
    if (teamMember) {
      return await respondTeamMemberGate(teamMember, teamMemberKind ?? "team", {
        reply: staffReplyEnabled,
        forward: staffForwardEnabled
      });
    }

    // Evaluate AiFlow triggers + enqueue runs up front so we only suppress the
    // default Coworker reply when an automation is actually queued to handle it.
    const { suppressingRunQueued } = await evaluateAndEnqueueAiFlows(supabase, businessId, {
      from,
      to,
      eventId,
      bodyText: inboundSmsBody(payload),
      participants: normalizedParticipants(payload)
    });

    const { error } = await supabase.from("sms_inbound_jobs").insert({
      business_id: businessId,
      telnyx_event_id: eventId,
      payload: envelope as unknown as Record<string, unknown>,
      status: "pending",
      // Only suppress when a flow that requested it actually has a queued run.
      suppress_reply: suppressingRunQueued,
      // Stamp the sender up front so the contact page + summarizer (which query
      // by this column, not the JSONB payload) see the message even when an
      // AiFlow suppresses the reply — the worker's suppression branch returns
      // before it would otherwise denormalize this.
      customer_e164: from,
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
