/**
 * Claims sms_inbound_jobs (§10), calls Rowboat /chat on the business VPS, sends outbound SMS
 * with Telnyx `Idempotency-Key` = `outbound_idempotency_key` (set at job insert + backfilled on claim).
 * Message `tags` include `ncw_idem:<uuid>` for optional GET reconciliation after ambiguous fetch errors (§10).
 *
 * Multi-turn SMS: `sms_rowboat_threads` stores Rowboat `conversationId` + optional `state` per
 * (business_id, customer_e164). Each job sends only the new user line; continuing threads pass
 * `conversationId` / `state` per Rowboat’s contract. `rowboat_reply_cached` avoids double /chat
 * when Rowboat succeeded but Telnyx send is retried.
 * Failed Rowboat or Telnyx sends reset the job to `pending` for bounded retries (`attempt_count` / MAX_ATTEMPTS);
 * `complete_sms_inbound_job(..., 'pending')` exists for the same pattern (see migration comment on that RPC).
 *
 * Secrets: SUPABASE_*, ROWBOAT_VPS_CHAT_BEARER (or ROWBOAT_GATEWAY_TOKEN), ROWBOAT_CHAT_URL_TEMPLATE,
 *          TELNYX_API_KEY, TELNYX_MESSAGING_PROFILE_ID, TELNYX_SMS_FROM_E164,
 *          INTERNAL_CRON_SECRET (Authorization: Bearer) for this endpoint.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { telnyxMessagingPhoneString } from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import { callSmsRowboatWithStatelessFallback } from "../_shared/sms_rowboat.ts";
import { buildCustomerPreambleForEdge, type EdgeCustomerMemoryRow } from "../_shared/customer_memory_preamble.ts";
import { currentDateTimeLine } from "../_shared/datetime_line.ts";
import {
  pickSmsTurn,
  capMicrosForTier,
  resolveSmsChatCap
} from "../_shared/chat_spend_cap.ts";
import { sendCapAlertOnce, smsCapPeriodKey } from "../_shared/cap_alerts.ts";

const MAX_ATTEMPTS = 8;
const NCW_IDEM_TAG_PREFIX = "ncw_idem:";
// Hard ceiling on a single Rowboat /chat call. A hung business VPS would otherwise
// keep the worker blocked for the full platform invocation timeout (and stall every
// other claimed job in the batch). Retries are handled by bounded `attempt_count`.
// Local Ollama inside Rowboat takes ~5s for short prompts but routinely
// >20s for the first reply on a typical-length SMS once the model has to
// page in or stream a longer response (verified via end-to-end timing
// from the VPS through the Cloudflare tunnel back to Rowboat). The
// Edge-function ceiling is ~150s so we have plenty of budget; 60s gives
// the model headroom while still bounding a stuck VPS.
const ROWBOAT_CHAT_TIMEOUT_MS = 60_000;

// Combined wall-clock budget across the initial Rowboat /chat call AND
// the optional stateless retry. Sized against the pg_cron HTTP cap of
// 90s (see migrations/20260505180000_sms_inbound_worker_cron_timeout.sql)
// minus a 10s reserve for Telnyx send + DB writes + telemetry that
// runs after Rowboat returns. Without this, a slow first failure
// (~60s timeoutMs) plus a fresh full-window retry could push total
// Rowboat wall time to ~120s — well past the 90s cron cap, so
// pg_cron disconnects, the outbound never goes out, and the job sits
// at 'processing' until the stale-claim recovery requeues it.
// (Codex P1 / Cursor Bugbot Medium feedback on PR #74.)
const ROWBOAT_RETRY_BUDGET_MS = 80_000;

// --- SMS chat spend cap (shared fuse with owner-dashboard chat) -------------
// Inbound SMS now runs on Gemini (the `Coworker` agent was repointed off local
// Qwen). Gemini bills per token, so SMS shares the SAME monthly fuse as owner
// chat: we meter each Gemini turn into owner_chat_model_spend and, once the
// COMBINED spend crosses the cap for the billing period, fall back to the local
// Qwen agent (`CoworkerLocal`) until the next period. See _shared/chat_spend_cap.ts.
const SMS_CHAT_SPEND_METERING_ENABLED =
  (Deno.env.get("SMS_CHAT_SPEND_METERING_ENABLED") ?? "true").trim().toLowerCase() !== "false";
// SHARED cap (micro-USD; 1 USD = 1_000_000). SMS deliberately reads the SAME env
// var as owner chat (OWNER_CHAT_SPEND_CAP_MICROS, default $10) — both surfaces
// meter into the same owner_chat_model_spend row and pass p_cap_micros to the
// same RPC, so a single cap value keeps the fuse consistent. Using a separate
// SMS_* var risked the two surfaces tripping/falling back at different totals.
const CHAT_SPEND_CAP_MICROS = (() => {
  const n = Number(Deno.env.get("OWNER_CHAT_SPEND_CAP_MICROS"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000_000;
})();
// Starter tenants get a lower shared AI budget ($5). Resolved per job from the
// business tier via capMicrosForTier; this is the starter base (env-tunable).
const CHAT_SPEND_CAP_MICROS_STARTER = (() => {
  const n = Number(Deno.env.get("OWNER_CHAT_SPEND_CAP_MICROS_STARTER"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000_000;
})();
// Agent names MUST match the workflow deploy-client.sh seeds: `Coworker` is the
// Gemini-backed SMS startAgent, `CoworkerLocal` its $0 Qwen fallback twin.
const SMS_CHAT_GEMINI_AGENT = (Deno.env.get("SMS_CHAT_GEMINI_AGENT") ?? "Coworker").trim();
const SMS_CHAT_LOCAL_AGENT = (Deno.env.get("SMS_CHAT_LOCAL_AGENT") ?? "CoworkerLocal").trim();


/** Best-effort: Telnyx list-messages filter may vary by API version — safe to return null. */
async function telnyxTryRecoverOutboundMessageId(apiKey: string, idem: string): Promise<string | null> {
  const tag = `${NCW_IDEM_TAG_PREFIX}${idem}`;
  const url = new URL("https://api.telnyx.com/v2/messages");
  url.searchParams.set("page[size]", "5");
  url.searchParams.set("filter[tags][in]", tag);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: Array<{ id?: string }> };
  const id = j.data?.[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

type JobRow = {
  id: string;
  business_id: string;
  payload: Record<string, unknown>;
  outbound_idempotency_key: string | null;
  attempt_count: number;
  rowboat_reply_cached?: string | null;
  /** Set by the AiFlow trigger hook: skip the normal Coworker reply for this job. */
  suppress_reply?: boolean | null;
};

type ThreadRow = {
  rowboat_conversation_id: string;
  rowboat_state: unknown | null;
};

function inboundPayloadText(p: Record<string, unknown>): string {
  const t = p["text"];
  if (typeof t === "string") return t;
  const body = p["body"];
  if (typeof body === "string") return body;
  return "";
}

async function clearJobReplyCache(
  supabase: SupabaseClient<any, any, any>,
  jobId: string
): Promise<void> {
  await supabase
    .from("sms_inbound_jobs")
    .update({ rowboat_reply_cached: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/**
 * Called ONLY after a confirmed successful outbound delivery. Clears the
 * transient retry buffer AND writes the durable `assistant_reply_text` that
 * powers the dashboard SMS thread / customer history.
 *
 * Writing the durable copy here (delivery time) rather than at cache time is
 * deliberate: paths that cache a reply but never deliver it (opt-out
 * suppression, monthly-cap reservation failure, dead-letter, missing Telnyx
 * env) call `clearJobReplyCache` instead, leaving `assistant_reply_text` null
 * so the dashboard never shows an outbound message that was never sent.
 */
async function finalizeDeliveredReply(
  supabase: SupabaseClient<any, any, any>,
  jobId: string,
  replyText: string
): Promise<void> {
  await supabase
    .from("sms_inbound_jobs")
    .update({
      rowboat_reply_cached: null,
      assistant_reply_text: replyText,
      updated_at: new Date().toISOString()
    })
    .eq("id", jobId);
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

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: jobs, error: claimErr } = await supabase.rpc("claim_sms_inbound_jobs", {
    p_limit: 8
  });

  if (claimErr) {
    console.error("claim_sms_inbound_jobs", claimErr);
    return new Response("Claim failed", { status: 500 });
  }

  const list = (jobs ?? []) as JobRow[];
  let processed = 0;

  const template =
    Deno.env.get("ROWBOAT_CHAT_URL_TEMPLATE") ??
    "https://{businessId}.newcoworker.com/api/v1/{projectId}/chat";
  const bearer =
    Deno.env.get("ROWBOAT_VPS_CHAT_BEARER") ?? Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  const defaultProjectId = Deno.env.get("ROWBOAT_DEFAULT_PROJECT_ID") ?? "";

  for (const job of list) {
    const envelope = job.payload as { data?: { payload?: Record<string, unknown> } };
    const payload = envelope?.data?.payload ?? {};
    const fromRaw = telnyxMessagingPhoneString(payload, "from");
    const fromE164 = normalizeE164(fromRaw);
    const userText = inboundPayloadText(payload).trim();

    if (!fromE164 || !userText) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: null,
        p_last_error: "missing_from_or_text"
      });
      await clearJobReplyCache(supabase, job.id);
      processed += 1;
      continue;
    }

    // Defense in depth against the telnyx-sms-inbound gate: flags can flip
    // between enqueue and drain, so re-check the kill switch + Safe Mode
    // before running Rowboat. Matches the webhook gate (§CustomerChannelGate).
    // The same row carries the business timezone for the date/time preamble.
    let businessTimezone: string | null = null;
    // Tier drives the shared AI spend cap ($5 starter / $10 otherwise).
    let businessTier: string | null = null;
    {
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("is_paused, customer_channels_enabled, timezone, tier")
        .eq("id", job.business_id)
        .maybeSingle();
      const biz = bizRow as
        | {
            is_paused?: boolean;
            customer_channels_enabled?: boolean;
            timezone?: string | null;
            tier?: string | null;
          }
        | null;
      businessTimezone = typeof biz?.timezone === "string" ? biz.timezone : null;
      businessTier = typeof biz?.tier === "string" ? biz.tier : null;

      if (biz?.is_paused || biz?.customer_channels_enabled === false) {
        const { data: settingsRow } = await supabase
          .from("business_telnyx_settings")
          .select(
            "forward_to_e164, telnyx_messaging_profile_id, telnyx_sms_from_e164"
          )
          .eq("business_id", job.business_id)
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
          await supabase.rpc("complete_sms_inbound_job", {
            p_job_id: job.id,
            p_status: "dead_letter",
            p_telnyx_outbound_message_id: null,
            p_rowboat_conversation_id: null,
            p_last_error: "paused"
          });
          await clearJobReplyCache(supabase, job.id);
          await telemetryRecord(supabase, "sms_worker_killswitch", {
            job_id: job.id,
            business_id: job.business_id,
            is_paused: Boolean(biz?.is_paused)
          });
          processed += 1;
          continue;
        }

        if (gate.kind === "safe_mode_forward") {
          const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
          const fwdProfile =
            (settings?.telnyx_messaging_profile_id as string | null)?.length
              ? String(settings!.telnyx_messaging_profile_id)
              : Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
          const fwdFrom =
            (settings?.telnyx_sms_from_e164 as string | null)?.length
              ? String(settings!.telnyx_sms_from_e164)
              : Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";
          const canForward = Boolean(apiKey && fwdProfile);

          if (!canForward) {
            await supabase.rpc("complete_sms_inbound_job", {
              p_job_id: job.id,
              p_status: "dead_letter",
              p_telnyx_outbound_message_id: null,
              p_rowboat_conversation_id: null,
              p_last_error: "safe_mode_missing_telnyx_env"
            });
            await clearJobReplyCache(supabase, job.id);
            processed += 1;
            continue;
          }

          const idem = job.outbound_idempotency_key;
          // Label is "[Safe Mode]" (not "[Coworker paused]") — Safe Mode keeps the
          // owner's dashboard + VPS online; customers just get forwarded. The
          // paused path is handled above and never reaches this branch.
          const forwardText = `[Safe Mode] From ${fromE164}: ${userText.slice(0, 1000)}`;
          const fwdBody: Record<string, unknown> = {
            to: gate.forwardToE164,
            text: forwardText.slice(0, 1600),
            messaging_profile_id: fwdProfile
          };
          if (fwdFrom) fwdBody.from = fwdFrom;
          if (idem) fwdBody.tags = [`${NCW_IDEM_TAG_PREFIX}${idem}`];

          const fwdHeaders: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          };
          if (idem) fwdHeaders["Idempotency-Key"] = idem;

          try {
            const fwdRes = await fetch("https://api.telnyx.com/v2/messages", {
              method: "POST",
              headers: fwdHeaders,
              body: JSON.stringify(fwdBody)
            });
            if (!fwdRes.ok) {
              throw new Error(`telnyx_forward_${fwdRes.status}`);
            }
            const fwdJson = (await fwdRes.json()) as { data?: { id?: string } };
            const mid = fwdJson.data?.id ?? null;
            await supabase.rpc("complete_sms_inbound_job", {
              p_job_id: job.id,
              p_status: "done",
              p_telnyx_outbound_message_id: mid,
              p_rowboat_conversation_id: null,
              p_last_error: "safe_mode_forwarded"
            });
            await clearJobReplyCache(supabase, job.id);
            await telemetryRecord(supabase, "sms_worker_safe_mode_forwarded", {
              job_id: job.id,
              business_id: job.business_id
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("sms_worker safe mode forward", msg);
            // Bound the retry budget just like the Rowboat error path below —
            // a persistently-failing forward (bad number, Telnyx outage, etc.)
            // would otherwise burn worker capacity on every cron tick forever.
            if (job.attempt_count >= MAX_ATTEMPTS) {
              await supabase.rpc("complete_sms_inbound_job", {
                p_job_id: job.id,
                p_status: "dead_letter",
                p_telnyx_outbound_message_id: null,
                p_rowboat_conversation_id: null,
                p_last_error: `safe_mode_forward:${msg}`.slice(0, 2000)
              });
              await clearJobReplyCache(supabase, job.id);
            } else {
              await supabase
                .from("sms_inbound_jobs")
                .update({
                  status: "pending",
                  processing_started_at: null,
                  last_error: `safe_mode_forward:${msg}`.slice(0, 2000),
                  updated_at: new Date().toISOString()
                })
                .eq("id", job.id);
            }
            await telemetryRecord(supabase, "sms_worker_safe_mode_forward_failed", {
              job_id: job.id,
              business_id: job.business_id,
              error: msg
            });
            await systemLog(supabase, {
              businessId: job.business_id,
              source: "sms_worker",
              level: job.attempt_count >= MAX_ATTEMPTS ? "error" : "warn",
              event: "sms_safe_mode_forward_failed",
              message: msg,
              payload: { job_id: job.id, attempt: job.attempt_count }
            });
          }
          processed += 1;
          continue;
        }
      }
    }

    // AiFlow suppression: a matched flow with options.suppressDefaultReply owns
    // the response to this inbound, so skip the normal Coworker reply (no Rowboat
    // call, no outbound send). This runs AFTER the kill-switch/Safe-Mode gate so
    // a suppressed lead in Safe Mode is still forwarded to the owner above; only
    // the AI auto-reply is suppressed. The job is marked done for the audit
    // trail; the AiFlow run was enqueued separately by the webhook.
    if (job.suppress_reply) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "done",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: null,
        p_last_error: "suppressed_by_ai_flow"
      });
      await clearJobReplyCache(supabase, job.id);
      await telemetryRecord(supabase, "sms_worker_suppressed_ai_flow", {
        job_id: job.id,
        business_id: job.business_id
      });
      processed += 1;
      continue;
    }

    const { data: cfg } = await supabase
      .from("business_configs")
      .select("rowboat_project_id")
      .eq("business_id", job.business_id)
      .maybeSingle();

    const rawProjectId = cfg?.rowboat_project_id as string | null | undefined;
    const projectId =
      rawProjectId && String(rawProjectId).length > 0 ? String(rawProjectId) : defaultProjectId;

    if (!projectId || !bearer) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: null,
        p_last_error: "missing_rowboat_project_or_bearer"
      });
      await clearJobReplyCache(supabase, job.id);
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: "error",
        event: "sms_rowboat_not_configured",
        message: "Inbound SMS dead-lettered: Rowboat project id / bearer missing",
        payload: { job_id: job.id }
      });
      processed += 1;
      continue;
    }

    const chatUrl = template
      .replace(/\{businessId\}/g, job.business_id)
      .replace(/\{projectId\}/g, projectId);

    const { data: threadRow } = await supabase
      .from("sms_rowboat_threads")
      .select("rowboat_conversation_id, rowboat_state")
      .eq("business_id", job.business_id)
      .eq("customer_e164", fromE164)
      .maybeSingle();

    const thread = threadRow as ThreadRow | null;

    // Phase 3: customer memory preamble. Pulled from the cross-channel
    // rollup so SMS replies see the same context as voice + dashboard.
    // Cheap if the row doesn't exist (single indexed lookup); preamble
    // is null when there's no summary/pinned content yet, which keeps
    // first-contact SMS exactly as it was pre-Phase-3 (no empty
    // "Customer profile:" header in the prompt).
    // Alias-aware: a number merged into another profile (alias_e164s) must
    // resolve to the surviving row so the merged context follows the texter.
    const { data: memoryRow } = await supabase
      .from("customer_memories")
      .select(
        "customer_e164, display_name, summary_md, pinned_md, " +
          "total_interaction_count, last_channel, last_interaction_at"
      )
      .eq("business_id", job.business_id)
      .or(`customer_e164.eq.${fromE164},alias_e164s.cs.{${fromE164}}`)
      .maybeSingle();
    const memoryPreamble =
      memoryRow == null
        ? null
        : buildCustomerPreambleForEdge(memoryRow as unknown as EdgeCustomerMemoryRow);
    // The texter's E.164 is ALWAYS stated, even on first contact with no
    // memory row: the Rowboat tool webhook (/api/rowboat/tool-call) has no
    // caller context, so the customer tools require an explicit `phone`
    // argument — without this line the model has nothing to pass and every
    // tool call fails validation.
    const phoneLine =
      `Current texter phone: ${fromE164}. When calling customer tools ` +
      `(customer_lookup_by_phone, customer_set_display_name, ` +
      `customer_append_pinned_note), pass this exact value as the phone ` +
      `argument unless the texter explicitly refers to a different number.`;
    // Date awareness: without this the model cannot resolve "tomorrow at
    // 2pm" into the ISO times the calendar tools require. Business-local
    // when the owner set a timezone; UTC fallback otherwise.
    const dateAndPhoneLines = `${currentDateTimeLine(new Date(), businessTimezone)}\n\n${phoneLine}`;
    const customerPreamble = memoryPreamble
      ? `${dateAndPhoneLines}\n\n${memoryPreamble}`
      : dateAndPhoneLines;

    let convId: string | undefined;
    let reply = (job.rowboat_reply_cached ?? "").trim();

    try {
      if (!reply) {
        const existingConv = thread?.rowboat_conversation_id?.trim() ?? null;

        // Shared spend-cap decision for this turn. Under cap → Gemini
        // (`Coworker`), stateful resume of the bound thread, metered. Over cap →
        // local Qwen (`CoworkerLocal`), forced stateless so Rowboat honors the
        // startAgent override (it ignores startAgent when a conversationId is
        // supplied), $0 and not metered. Fails open to Gemini on any read error.
        const cap = await resolveSmsChatCap(supabase, job.business_id, {
          capMicros: capMicrosForTier(businessTier, CHAT_SPEND_CAP_MICROS, CHAT_SPEND_CAP_MICROS_STARTER),
          enabled: SMS_CHAT_SPEND_METERING_ENABLED
        });
        const turnPlan = pickSmsTurn({
          overCap: cap.overCap,
          geminiAgent: SMS_CHAT_GEMINI_AGENT,
          localAgent: SMS_CHAT_LOCAL_AGENT
        });

        const parsed = await callSmsRowboatWithStatelessFallback({
          chatUrl,
          bearer,
          userText,
          // Over cap we drop the continuation so the local-agent override takes
          // effect; under cap we resume the (Gemini-bound) thread as before.
          conversationId: turnPlan.stateless ? null : existingConv,
          state: turnPlan.stateless ? null : (thread?.rowboat_state ?? null),
          startAgent: turnPlan.startAgent,
          timeoutMs: ROWBOAT_CHAT_TIMEOUT_MS,
          // Cap the combined initial+retry wall time under the 90s
          // pg_cron HTTP timeout (see ROWBOAT_RETRY_BUDGET_MS).
          budgetMs: ROWBOAT_RETRY_BUDGET_MS,
          customerPreamble
        });
        reply = parsed.reply;

        if (cap.overCap) {
          await telemetryRecord(supabase, "sms_chat_spend_over_cap_local", {
            job_id: job.id,
            business_id: job.business_id
          });
        }

        if (turnPlan.stateless) {
          // Over-cap local ($0) turn: we forced a stateless call so Rowboat
          // would honor startAgent=CoworkerLocal. Do NOT bind the thread to the
          // local agent — leave the stored (Gemini-bound) thread untouched so it
          // resumes on Gemini once the period resets. The returned (local)
          // conversationId is intentionally discarded. Keep the existing
          // continuation on the completed job row for bookkeeping.
          convId = existingConv ?? undefined;
        } else {
          // When the stateless retry fired, Rowboat treated this turn as
          // a fresh conversation — its response carries a NEW
          // conversationId. We must NOT preserve the stale `existingConv`
          // here; doing so would replay the same fail-then-retry cycle
          // on every subsequent SMS until the model evicts again.
          // (Same-shape bug as Cursor Bugbot Low on PR #71's dashboard
          // chat retry path.)
          const stableConvId = parsed.retriedStateless
            ? (parsed.conversationId ?? "").trim()
            : (parsed.conversationId ?? existingConv ?? "").trim();
          if (stableConvId) {
            // On a stateless retry, drop whatever state was paired with
            // the now-evicted continuation. Otherwise carry the existing
            // state forward unless Rowboat returned a new value.
            let nextState: unknown | null = parsed.retriedStateless
              ? null
              : thread?.rowboat_state ?? null;
            if (parsed.hasStateKey) {
              nextState = parsed.state ?? null;
            }
            const { error: threadErr } = await supabase.from("sms_rowboat_threads").upsert(
              {
                business_id: job.business_id,
                customer_e164: fromE164,
                rowboat_conversation_id: stableConvId,
                rowboat_state: nextState,
                updated_at: new Date().toISOString()
              },
              { onConflict: "business_id,customer_e164" }
            );
            if (threadErr) {
              console.error("sms_rowboat_threads upsert", threadErr);
            }
          } else if (parsed.retriedStateless) {
            // Stateless retry succeeded but Rowboat didn't echo a fresh
            // conversationId. Clear the stored row anyway — the existing
            // conversationId is known-stale (we just proved that by
            // succeeding without it). Leaving it would re-run the
            // fail-then-retry on the next SMS.
            await supabase
              .from("sms_rowboat_threads")
              .delete()
              .eq("business_id", job.business_id)
              .eq("customer_e164", fromE164);
          }

          // When the stateless retry succeeded WITHOUT a fresh
          // conversationId from Rowboat, the existing conversationId is
          // known-stale (the retry just proved that by succeeding
          // without it). Falling back to existingConv here would persist
          // the stale ID via complete_sms_inbound_job_done, advertising
          // a known-invalid continuation on the completed job record
          // (Cursor Bugbot Low on PR #74). Leave convId undefined in
          // that case so the job row's rowboat_conversation_id is set
          // to NULL, matching the sms_rowboat_threads delete above.
          convId = parsed.retriedStateless
            ? (stableConvId || (parsed.conversationId ?? "").trim() || undefined)
            : (stableConvId || (parsed.conversationId ?? "").trim() || existingConv || undefined);
        }

        // Denormalize the normalized customer E.164 onto the job row
        // so the customers page (Phase 4) + nightly cross-channel
        // summarizer (Phase 2 batch) can query per-customer SMS
        // history without scanning the JSONB payload. Bundled into
        // the same UPDATE as rowboat_reply_cached to avoid an extra
        // round-trip per job.
        //
        // Model spend is NO LONGER metered here: the llm-router sidecar meters
        // the exact billed tokens for every Gemini turn (owner chat / SMS /
        // summarizers) and POSTs them to /api/internal/meter-gemini-spend. This
        // worker only READS that shared spend (resolveSmsChatCap) to route
        // Gemini→local once the period cap is hit.
        const cachePatch: Record<string, unknown> = {
          rowboat_reply_cached: reply,
          customer_e164: fromE164,
          updated_at: new Date().toISOString()
        };
        const { error: cacheErr } = await supabase
          .from("sms_inbound_jobs")
          .update(cachePatch)
          .eq("id", job.id);
        if (cacheErr) {
          // Caching the reply is a PREREQUISITE for sending: the cached reply is
          // what lets a Telnyx-send retry re-deliver without re-running Rowboat.
          // If we can't persist it, abort the turn (→ catch → retry/dead-letter)
          // instead of sending. Sending now would risk a double-SMS on retry —
          // with no cached reply the retry re-runs Rowboat and sends again.
          // Aborting keeps it simple and correct: the retry re-runs, re-caches,
          // and sends exactly once. Cache failures are a rare DB-write error, so
          // the wasted re-run is acceptable.
          console.error("rowboat_reply_cached", cacheErr);
          throw new Error(`rowboat_reply_cache_failed: ${cacheErr.message}`);
        }

        // Phase 3 write side: bump the customer memory counters in a
        // single round trip. The summarizer is NOT invoked here —
        // post-interaction summarization runs from the nightly cron
        // sweep (Phase 2 batch) so it never preempts the live SMS
        // path. Owner-confirmed gating: 3-interaction threshold +
        // 30s debounce + low-priority queue.
        const { error: memErr } = await supabase.rpc("record_customer_interaction", {
          p_business_id: job.business_id,
          p_customer_e164: fromE164,
          p_channel: "sms",
          p_display_name: null
        });
        if (memErr) {
          // Memory tracking is best-effort — a degraded customer page
          // is acceptable; failing the SMS reply because we couldn't
          // bump a counter is not.
          console.error("record_customer_interaction (sms)", memErr);
        }

        if (parsed.retriedStateless) {
          await telemetryRecord(supabase, "sms_worker_rowboat_stateless_retry", {
            job_id: job.id,
            business_id: job.business_id
          });
        }

        // Model spend + the cap-tripped owner alert are handled by the
        // llm-router meter (→ /api/internal/meter-gemini-spend), not here. This
        // worker only routes Gemini→local via resolveSmsChatCap above.
      } else {
        convId = thread?.rowboat_conversation_id;
        // Cached-reply re-send (Telnyx retry, or a crash after caching): the
        // turn already ran; nothing to meter here either (the llm-router meters
        // the real Gemini turn when it runs).
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const deadLetter = job.attempt_count >= MAX_ATTEMPTS;
      if (deadLetter) {
        await supabase.rpc("complete_sms_inbound_job", {
          p_job_id: job.id,
          p_status: "dead_letter",
          p_telnyx_outbound_message_id: null,
          p_rowboat_conversation_id: null,
          p_last_error: msg.slice(0, 2000)
        });
        await clearJobReplyCache(supabase, job.id);
      } else {
        await supabase
          .from("sms_inbound_jobs")
          .update({
            status: "pending",
            processing_started_at: null,
            last_error: msg.slice(0, 2000),
            updated_at: new Date().toISOString()
          })
          .eq("id", job.id);
      }
      // The Rowboat turn (→ llm-router → Gemini/Ollama) failed: this is THE
      // "client texted the AI and got silence" diagnostic.
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: deadLetter ? "error" : "warn",
        event: deadLetter ? "sms_rowboat_dead_letter" : "sms_rowboat_retry",
        message: msg,
        payload: { job_id: job.id, attempt: job.attempt_count, max_attempts: MAX_ATTEMPTS }
      });
      processed += 1;
      continue;
    }

    const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
    const baseProf = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
    let platformFrom = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";

    const { data: tset } = await supabase
      .from("business_telnyx_settings")
      .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
      .eq("business_id", job.business_id)
      .maybeSingle();

    const messagingProfileId =
      (tset?.telnyx_messaging_profile_id as string | null)?.length
        ? String(tset?.telnyx_messaging_profile_id)
        : baseProf;

    const rawPlatformFrom = tset?.telnyx_sms_from_e164 as string | null | undefined;
    if (rawPlatformFrom && String(rawPlatformFrom).length) {
      platformFrom = String(rawPlatformFrom);
    }

    if (!apiKey || !messagingProfileId) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: convId ?? null,
        p_last_error: "missing_telnyx_messaging_env"
      });
      await clearJobReplyCache(supabase, job.id);
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: "error",
        event: "sms_telnyx_not_configured",
        message: "Reply dead-lettered: Telnyx API key / messaging profile missing",
        payload: { job_id: job.id }
      });
      processed += 1;
      continue;
    }

    // CTIA opt-out gate at send time (defense in depth: enqueue path also gates, but if
    // an opt-out lands after enqueue we must still suppress the outbound reply here).
    const { data: optedRaw, error: optLookErr } = await supabase.rpc("sms_is_opted_out", {
      p_business_id: job.business_id,
      p_sender_e164: fromE164
    });
    if (optLookErr) {
      console.error("sms_is_opted_out", optLookErr);
    } else if (optedRaw === true) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "done",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: convId ?? null,
        p_last_error: "suppressed_opt_out"
      });
      await clearJobReplyCache(supabase, job.id);
      await telemetryRecord(supabase, "sms_worker_suppressed_opt_out", {
        job_id: job.id,
        business_id: job.business_id
      });
      processed += 1;
      continue;
    }

    // Atomically reserve one outbound slot (row-locked monthly cap + pre-increment).
    // This replaces the previous check_sms_monthly_limit → send → meter pattern, which
    // was TOCTOU: two workers could each see "allowed" simultaneously and both blow
    // through the cap. try_reserve_sms_outbound_slot holds a row lock on businesses.
    const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
      "try_reserve_sms_outbound_slot",
      { p_business_id: job.business_id }
    );
    if (reserveErr) {
      console.error("try_reserve_sms_outbound_slot", reserveErr);
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: convId ?? null,
        p_last_error: `sms_reserve:${reserveErr.message}`.slice(0, 2000)
      });
      await clearJobReplyCache(supabase, job.id);
      processed += 1;
      continue;
    }
    const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
    if (!reserve?.ok) {
      // Strict cap: no auto-reply here (customer sees silence). The owner gets
      // a one-time urgent alert per period so silence isn't the only signal.
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: convId ?? null,
        p_last_error: reserve?.reason ?? "monthly_sms_limit"
      });
      await clearJobReplyCache(supabase, job.id);
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: "warn",
        event: "sms_quota_exhausted",
        message: `Reply suppressed: ${reserve?.reason ?? "monthly_sms_limit"} (customer sees silence)`,
        payload: { job_id: job.id }
      });
      if (reserve?.reason === "monthly_sms_limit") {
        await sendCapAlertOnce(supabase, {
          businessId: job.business_id,
          kind: "sms_monthly",
          periodKey: smsCapPeriodKey(),
          notifyUrl: `${supabaseUrl}/functions/v1/notifications`,
          bearer: serviceKey,
          payload: { surface: "sms_worker", job_id: job.id }
        });
      }
      processed += 1;
      continue;
    }

    const releaseReservedSlot = async (): Promise<void> => {
      const { error: relErr } = await supabase.rpc("release_sms_outbound_slot", {
        p_business_id: job.business_id,
        // A bonus-sourced reserve consumed a purchased text; give it back when
        // the Telnyx send failed after the reserve.
        p_refund_bonus: reserve.source === "bonus"
      });
      if (relErr) console.error("release_sms_outbound_slot", relErr);
    };

    const msgBody: Record<string, unknown> = {
      to: fromE164,
      text: reply.slice(0, 1600),
      messaging_profile_id: messagingProfileId
    };
    if (platformFrom) msgBody.from = platformFrom;
    const idem = job.outbound_idempotency_key;
    if (idem) {
      msgBody.tags = [`${NCW_IDEM_TAG_PREFIX}${idem}`];
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
    if (idem) headers["Idempotency-Key"] = idem;

    try {
      const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(msgBody)
      });
      if (!smsRes.ok) {
        throw new Error(`telnyx_sms_${smsRes.status}_${(await smsRes.text()).slice(0, 200)}`);
      }
      const smsJson = (await smsRes.json()) as { data?: { id?: string } };
      const mid = smsJson.data?.id ?? "";
      // Slot was already metered during try_reserve_sms_outbound_slot, so call the
      // no-metering completion RPC to avoid double-counting the outbound.
      const { error: doneErr } = await supabase.rpc("complete_sms_inbound_job_done", {
        p_job_id: job.id,
        p_business_id: job.business_id,
        p_telnyx_outbound_message_id: mid || null,
        p_rowboat_conversation_id: convId ?? null
      });
      if (doneErr) {
        throw new Error(`done:${doneErr.message}`);
      }
      // Delivered: persist the durable reply for dashboard history and clear
      // the transient retry buffer in one update.
      await finalizeDeliveredReply(supabase, job.id, reply);
      await telemetryRecord(supabase, "sms_inbound_worker_sent", {
        job_id: job.id,
        business_id: job.business_id
      });
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: "info",
        event: "sms_reply_sent",
        message: "Inbound SMS answered (Rowboat reply delivered via Telnyx)",
        payload: { job_id: job.id, telnyx_message_id: mid || null }
      });
    } catch (e) {
      if (idem) {
        const recovered = await telnyxTryRecoverOutboundMessageId(apiKey, idem);
        if (recovered) {
          await telemetryRecord(supabase, "sms_outbound_reconciled_after_error", {
            job_id: job.id,
            business_id: job.business_id
          });
          const { error: recErr } = await supabase.rpc("complete_sms_inbound_job_done", {
            p_job_id: job.id,
            p_business_id: job.business_id,
            p_telnyx_outbound_message_id: recovered,
            p_rowboat_conversation_id: convId ?? null
          });
          if (!recErr) {
            // Reconciled: the outbound DID go out, so keep the metered slot
            // and persist the durable reply for dashboard history.
            await finalizeDeliveredReply(supabase, job.id, reply);
            await systemLog(supabase, {
              businessId: job.business_id,
              source: "sms_worker",
              level: "info",
              event: "sms_reply_sent",
              message:
                "Inbound SMS answered (Telnyx send reconciled via idempotency key)",
              payload: { job_id: job.id, telnyx_message_id: recovered, reconciled: true }
            });
            processed += 1;
            continue;
          }
          console.error("complete_sms_inbound_job_done after reconcile", recErr);
        }
      }
      // Release the pre-incremented slot so a failed (and non-reconciled) send does not
      // consume monthly quota. Done BEFORE status update so a retry can re-reserve cleanly.
      await releaseReservedSlot();
      const msg = e instanceof Error ? e.message : String(e);
      const deadLetter = job.attempt_count >= MAX_ATTEMPTS;
      if (deadLetter) {
        await supabase.rpc("complete_sms_inbound_job", {
          p_job_id: job.id,
          p_status: "dead_letter",
          p_telnyx_outbound_message_id: null,
          p_rowboat_conversation_id: convId ?? null,
          p_last_error: msg.slice(0, 2000)
        });
        await clearJobReplyCache(supabase, job.id);
      } else {
        await supabase
          .from("sms_inbound_jobs")
          .update({
            status: "pending",
            processing_started_at: null,
            last_error: msg.slice(0, 2000),
            updated_at: new Date().toISOString()
          })
          .eq("id", job.id);
      }
      await systemLog(supabase, {
        businessId: job.business_id,
        source: "sms_worker",
        level: deadLetter ? "error" : "warn",
        event: deadLetter ? "sms_telnyx_send_dead_letter" : "sms_telnyx_send_retry",
        message: msg,
        payload: { job_id: job.id, attempt: job.attempt_count, max_attempts: MAX_ATTEMPTS }
      });
    }
    processed += 1;
  }

  await telemetryRecord(supabase, "sms_inbound_worker_batch", { claimed: list.length, processed });

  return new Response(JSON.stringify({ ok: true, claimed: list.length, processed }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
