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
import {
  telnyxInboundImages,
  telnyxMessagingPhoneString,
  type TelnyxInboundImage
} from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import {
  callSmsRowboatWithStatelessFallback,
  STATELESS_5XX_MIN_ATTEMPT
} from "../_shared/sms_rowboat.ts";
import {
  resolveRowboatBearerForBusiness,
  sharedEnvRowboatBearer
} from "../_shared/gateway_token.ts";
import { buildCustomerPreambleForEdge, type EdgeCustomerMemoryRow } from "../_shared/customer_memory_preamble.ts";
import {
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../_shared/reply_reasoning.ts";
import { loadFlowRunContext } from "../_shared/ai_flows/run_context.ts";
import { loadRecentSmsTranscript } from "../_shared/sms_transcript.ts";
import { escalateToHuman } from "../_shared/needs_human.ts";
import {
  SMS_CONVERSATION_QUALITY_LINE,
  SMS_GROUNDED_ACTIONS_LINE,
  SMS_IDENTITY_LINE
} from "../_shared/sms_prompt_lines.ts";
import { inboundSmsBody, telnyxSendSms } from "../_shared/telnyx_sms_compliance.ts";
import { resolveRcsAgentId } from "../_shared/channel_settings.ts";
import {
  buildOwnerReplyPromptSms,
  resolveSmsReplyMode
} from "../_shared/contact_reply_mode.ts";
import { currentDateTimeLine } from "../_shared/datetime_line.ts";
import {
  pickSmsTurn,
  capMicrosForTier,
  resolveSmsChatCap,
  tenantHasLocalModel
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
  /**
   * Set by telnyx-sms-inbound when the sender is the owner or a roster team
   * member. Drives the internal-assistant persona (no lead intake, no customer
   * profile). Null = ordinary customer job.
   */
  staff_kind?: "owner" | "team" | null;
  staff_name?: string | null;
};

type ThreadRow = {
  rowboat_conversation_id: string;
  rowboat_state: unknown | null;
};

// Delegates to the shared reader so RCS payloads (nested `body.text` /
// `body.suggestion_response.text`) resolve the same here as at the webhook.
function inboundPayloadText(p: Record<string, unknown>): string {
  return inboundSmsBody(p);
}

// ── Inbound MMS photos as edit sources ──────────────────────────────────────
// Same bucket + `<businessId>/<uuid>.<ext>` shape the generate_image tools
// write, so the tool's business-scoped ref validation covers stored inbound
// photos with zero extra machinery. Created by 20260819000000_generated_images_bucket.sql.
const GENERATED_IMAGES_BUCKET = "generated-images";
const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

const INBOUND_IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

/**
 * Download an inbound MMS photo from Telnyx's media CDN and store it in the
 * generated-images bucket so the texting coworker can edit it (generate_image
 * inputImageRef). Best-effort: any failure returns null and the text is
 * handled as if no photo arrived — a media blip must never block a reply.
 * The URL was host-pinned to *.telnyx.com by telnyxInboundImages.
 */
async function storeInboundImageForEditing(
  supabase: SupabaseClient<any, any, any>,
  businessId: string,
  image: TelnyxInboundImage
): Promise<string | null> {
  try {
    // No redirects: only the pinned Telnyx host may serve the bytes — a 3xx
    // bouncing elsewhere is a refusal, not a hop (SSRF).
    const res = await fetch(image.url, { redirect: "manual" });
    if (!res.ok) {
      console.warn("inbound MMS media fetch failed", res.status);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_INBOUND_IMAGE_BYTES) {
      console.warn("inbound MMS media skipped: size", bytes.length);
      return null;
    }
    const ext = INBOUND_IMAGE_EXT[image.contentType] ?? "jpg";
    const path = `${businessId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from(GENERATED_IMAGES_BUCKET)
      .upload(path, new Blob([bytes], { type: image.contentType }), {
        contentType: image.contentType
      });
    if (error) {
      console.warn("inbound MMS media store failed", error.message);
      return null;
    }
    return path;
  } catch (e) {
    console.warn("inbound MMS media capture failed", e instanceof Error ? e.message : e);
    return null;
  }
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
  replyText: string,
  replyChannel: "sms" | "rcs"
): Promise<void> {
  await supabase
    .from("sms_inbound_jobs")
    .update({
      rowboat_reply_cached: null,
      assistant_reply_text: replyText,
      // The reply can leave on a different channel than the inbound arrived
      // on (RCS inbound answered over SMS after an RCS rejection) — the
      // thread UI badges the outbound bubble off this, not `channel`.
      reply_channel: replyChannel,
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
  const defaultProjectId = Deno.env.get("ROWBOAT_DEFAULT_PROJECT_ID") ?? "";
  // Per-tenant Rowboat bearer, resolved once per distinct business in this
  // batch. A re-keyed VPS rejects the shared env token ("Invalid API key"),
  // which used to dead-letter every customer SMS for that tenant.
  //
  // Only PER-TENANT tokens are cached: when the resolver returns the shared
  // env fallback it may be fail-open after a transient token-table error, and
  // caching that would keep presenting the (possibly rejected) shared secret
  // to every remaining job for the business even after the lookup recovers.
  // Fallback tenants just re-query per job — one cheap indexed read.
  const bearerCache = new Map<string, string>();
  const envBearer = sharedEnvRowboatBearer();
  const bearerFor = async (businessId: string): Promise<string> => {
    const cached = bearerCache.get(businessId);
    if (cached !== undefined) return cached;
    const b = await resolveRowboatBearerForBusiness(supabase, businessId);
    if (b.length > 0 && b !== envBearer) bearerCache.set(businessId, b);
    return b;
  };

  for (const job of list) {
    const envelope = job.payload as { data?: { payload?: Record<string, unknown> } };
    const payload = envelope?.data?.payload ?? {};
    const fromRaw = telnyxMessagingPhoneString(payload, "from");
    const fromE164 = normalizeE164(fromRaw);
    const inboundImages = telnyxInboundImages(payload);
    // A photo with no caption is a real message (e.g. "edit this picture" is
    // coming next, or the photo IS the ask) — give the model a stand-in text
    // instead of dead-lettering the job as empty.
    const userText =
      inboundPayloadText(payload).trim() ||
      (inboundImages.length > 0 ? "(The texter sent a photo with no text.)" : "");

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
    // vps_size decides the over-cap behavior: hardware with a local model
    // (kvm2/kvm8) degrades to the CoworkerLocal twin; kvm1 has none, so
    // over-cap turns are refused (see pickSmsTurn / tenantHasLocalModel).
    let businessVpsSize: string | null = null;
    {
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("is_paused, customer_channels_enabled, timezone, tier, vps_size")
        .eq("id", job.business_id)
        .maybeSingle();
      const biz = bizRow as
        | {
            is_paused?: boolean;
            customer_channels_enabled?: boolean;
            timezone?: string | null;
            tier?: string | null;
            vps_size?: string | null;
          }
        | null;
      businessTimezone = typeof biz?.timezone === "string" ? biz.timezone : null;
      businessTier = typeof biz?.tier === "string" ? biz.tier : null;
      businessVpsSize = typeof biz?.vps_size === "string" ? biz.vps_size : null;

      if (biz?.is_paused || biz?.customer_channels_enabled === false) {
        // Staff jobs were already handled at inbound time (audit row + optional
        // "[Team] …" owner relay). If Safe Mode / pause flips on before the
        // worker runs, the generic customer forward below would send a SECOND
        // owner SMS ("[Safe Mode] …") for a staff text that may already have
        // been relayed — and we don't want an assistant reply while paused.
        // Close staff jobs out as audit-only here, before the customer gate.
        if (job.staff_kind) {
          await supabase.rpc("complete_sms_inbound_job", {
            p_job_id: job.id,
            p_status: "done",
            p_telnyx_outbound_message_id: null,
            p_rowboat_conversation_id: null,
            p_last_error: "staff_safe_mode_noop"
          });
          await clearJobReplyCache(supabase, job.id);
          await telemetryRecord(supabase, "sms_worker_staff_safe_mode_noop", {
            job_id: job.id,
            business_id: job.business_id,
            staff_kind: job.staff_kind
          });
          processed += 1;
          continue;
        }
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
            // A forward_owner contact keeps their reply relay in Safe Mode:
            // the Safe-Mode forward above already put the text on the owner's
            // phone (no second "what would you like me to say?" SMS), so just
            // record the routable prompt. Best-effort + idempotent on job id;
            // the webhook's relay path runs in Safe Mode too.
            if (!job.staff_kind) {
              const { data: smContact } = await supabase
                .from("contacts")
                .select("sms_reply_mode")
                .eq("business_id", job.business_id)
                .or(`customer_e164.eq.${fromE164},alias_e164s.cs.{${fromE164}}`)
                .maybeSingle();
              const smMode = resolveSmsReplyMode(
                (smContact as { sms_reply_mode?: unknown } | null)?.sms_reply_mode
              );
              if (smMode === "forward_owner") {
                const { error: smPromptErr } = await supabase
                  .from("sms_owner_reply_prompts")
                  .insert({
                    business_id: job.business_id,
                    customer_e164: fromE164,
                    inbound_job_id: job.id,
                    inbound_text: userText.slice(0, 1000)
                  });
                if (smPromptErr && (smPromptErr as { code?: string }).code !== "23505") {
                  console.error("safe mode forward_owner prompt insert", smPromptErr);
                }
              }
            }
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
      // The AiFlow owns the reply, but this is still a real inbound from a
      // contact. The normal reply path below denormalizes the sender and bumps
      // the customer-memory counters; since we return early here, do both now so
      // the message shows on the contact page and counts as an interaction.
      // Skip staff (an owner/employee text must never seed a customer profile) —
      // suppressed jobs come from the customer path, but guard defensively.
      if (fromE164 && !job.staff_kind) {
        // Stamp the column for rows queued before the webhook started doing it.
        const { error: stampErr } = await supabase
          .from("sms_inbound_jobs")
          .update({ customer_e164: fromE164 })
          .eq("id", job.id)
          .is("customer_e164", null);
        if (stampErr) {
          console.error("suppressed customer_e164 stamp", stampErr);
        }
        const { error: memErr } = await supabase.rpc("record_customer_interaction", {
          p_business_id: job.business_id,
          p_customer_e164: fromE164,
          p_channel: "sms",
          p_display_name: null
        });
        if (memErr) {
          console.error("record_customer_interaction (suppressed sms)", memErr);
        }
      }
      await telemetryRecord(supabase, "sms_worker_suppressed_ai_flow", {
        job_id: job.id,
        business_id: job.business_id
      });
      processed += 1;
      continue;
    }

    // Per-contact reply mode (contacts.sms_reply_mode). Runs AFTER the AiFlow
    // suppress_reply branch so an AiFlow that owns the reply is untouched, and
    // only for customer jobs (staff texting keeps the internal assistant).
    //   suppress      → no default Coworker reply; the inbound is still logged
    //                   and still bumps the contact's interaction counters.
    //   forward_owner → additionally forward the text to the owner's cell with
    //                   "What would you like me to say?" and record a pending
    //                   prompt so the owner's reply is relayed to the customer
    //                   (telnyx-sms-inbound resolves it). Missing forward
    //                   config degrades to plain suppress — never a default
    //                   reply the owner asked us not to send.
    if (!job.staff_kind) {
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("display_name, sms_reply_mode")
        .eq("business_id", job.business_id)
        .or(`customer_e164.eq.${fromE164},alias_e164s.cs.{${fromE164}}`)
        .maybeSingle();
      const replyMode = resolveSmsReplyMode(
        (contactRow as { sms_reply_mode?: unknown } | null)?.sms_reply_mode
      );
      if (replyMode !== "auto") {
        let forwarded = false;
        if (replyMode === "forward_owner") {
          const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
          const { data: fwdRow } = await supabase
            .from("business_telnyx_settings")
            .select("forward_to_e164, telnyx_messaging_profile_id, telnyx_sms_from_e164")
            .eq("business_id", job.business_id)
            .maybeSingle();
          const fwd = fwdRow as
            | {
                forward_to_e164?: string | null;
                telnyx_messaging_profile_id?: string | null;
                telnyx_sms_from_e164?: string | null;
              }
            | null;
          const ownerCell = normalizeE164(fwd?.forward_to_e164 ?? "");
          const fwdProfile =
            (fwd?.telnyx_messaging_profile_id ?? "").trim() ||
            (Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "");
          const fwdFrom =
            (fwd?.telnyx_sms_from_e164 ?? "").trim() ||
            (Deno.env.get("TELNYX_SMS_FROM_E164") ?? "");
          if (apiKey && fwdProfile && ownerCell) {
            // Prompt row FIRST, and the send is GATED on it existing: an
            // owner prompted without a prompt row would reply into the void —
            // or worse, the webhook would attach their text to a DIFFERENT
            // customer's newest pending prompt. Idempotent on inbound_job_id
            // (a worker retry re-hits the unique index → duplicate is fine).
            const { error: promptErr } = await supabase
              .from("sms_owner_reply_prompts")
              .insert({
                business_id: job.business_id,
                customer_e164: fromE164,
                inbound_job_id: job.id,
                inbound_text: userText.slice(0, 1000)
              });
            const promptFailed =
              Boolean(promptErr) && (promptErr as { code?: string }).code !== "23505";
            if (promptFailed) {
              console.error("sms_owner_reply_prompts insert", promptErr);
              // Transient DB failure: bounded retry WITHOUT texting the owner.
              if (job.attempt_count < MAX_ATTEMPTS) {
                await supabase
                  .from("sms_inbound_jobs")
                  .update({
                    status: "pending",
                    processing_started_at: null,
                    last_error: "contact_forward_owner:prompt_insert_failed",
                    updated_at: new Date().toISOString()
                  })
                  .eq("id", job.id);
                await telemetryRecord(supabase, "sms_worker_contact_forward_retry", {
                  job_id: job.id,
                  business_id: job.business_id,
                  stage: "prompt_insert"
                });
                processed += 1;
                continue;
              }
              // Out of retry budget: fall through and close the job out as
              // suppressed — no owner SMS without a routable prompt.
            } else {
              const customerLabel =
                (contactRow as { display_name?: string | null } | null)?.display_name?.trim() ||
                fromE164;
              const send = await telnyxSendSms({
                apiKey,
                messagingProfileId: fwdProfile,
                fromE164: fwdFrom,
                toE164: ownerCell,
                text: buildOwnerReplyPromptSms({ customerLabel, inboundText: userText }),
                // Keyed on the job so worker retries never double-text the owner.
                idempotencyKey: `${job.id}:owner-reply-prompt`
              });
              if (!send.ok) {
                console.error("contact forward_owner send", send.status, send.body.slice(0, 300));
                // Transient send failure: bounded retry like the Safe-Mode
                // forward path, so the owner doesn't silently miss the message.
                if (job.attempt_count < MAX_ATTEMPTS) {
                  await supabase
                    .from("sms_inbound_jobs")
                    .update({
                      status: "pending",
                      processing_started_at: null,
                      last_error: `contact_forward_owner:telnyx_${send.status}`.slice(0, 2000),
                      updated_at: new Date().toISOString()
                    })
                    .eq("id", job.id);
                  await telemetryRecord(supabase, "sms_worker_contact_forward_retry", {
                    job_id: job.id,
                    business_id: job.business_id,
                    stage: "telnyx_send",
                    status: send.status
                  });
                  processed += 1;
                  continue;
                }
                // Out of retry budget: the owner never received the prompt,
                // so the row must not stay routable — an unanswered orphan
                // would relay the owner's NEXT unrelated text to this
                // customer. Delete it, then close the job out as suppressed —
                // still no default reply.
                const { error: orphanErr } = await supabase
                  .from("sms_owner_reply_prompts")
                  .delete()
                  .eq("inbound_job_id", job.id)
                  .is("answered_at", null);
                if (orphanErr) {
                  console.error("contact forward_owner orphan prompt delete", orphanErr);
                }
              } else {
                forwarded = true;
              }
            }
          } else {
            await systemLog(supabase, {
              businessId: job.business_id,
              source: "sms_worker",
              level: "warn",
              event: "sms_contact_forward_unconfigured",
              message:
                "Contact is set to forward-to-owner but no forwarding number / Telnyx env is configured; suppressing only",
              payload: { job_id: job.id }
            });
          }
        }
        await supabase.rpc("complete_sms_inbound_job", {
          p_job_id: job.id,
          p_status: "done",
          p_telnyx_outbound_message_id: null,
          p_rowboat_conversation_id: null,
          p_last_error: forwarded ? "contact_forward_owner" : "suppressed_by_contact"
        });
        await clearJobReplyCache(supabase, job.id);
        // Same bookkeeping as the AiFlow-suppressed branch: the inbound is a
        // real customer message, so stamp the sender and bump the counters.
        const { error: stampErr } = await supabase
          .from("sms_inbound_jobs")
          .update({ customer_e164: fromE164 })
          .eq("id", job.id)
          .is("customer_e164", null);
        if (stampErr) {
          console.error("contact mode customer_e164 stamp", stampErr);
        }
        const { error: memErr } = await supabase.rpc("record_customer_interaction", {
          p_business_id: job.business_id,
          p_customer_e164: fromE164,
          p_channel: "sms",
          p_display_name: null
        });
        if (memErr) {
          console.error("record_customer_interaction (contact mode sms)", memErr);
        }
        await telemetryRecord(supabase, "sms_worker_contact_reply_mode", {
          job_id: job.id,
          business_id: job.business_id,
          mode: replyMode,
          forwarded
        });
        processed += 1;
        continue;
      }
    }

    const { data: cfg } = await supabase
      .from("business_configs")
      .select("rowboat_project_id")
      .eq("business_id", job.business_id)
      .maybeSingle();

    const rawProjectId = cfg?.rowboat_project_id as string | null | undefined;
    const projectId =
      rawProjectId && String(rawProjectId).length > 0 ? String(rawProjectId) : defaultProjectId;
    const bearer = await bearerFor(job.business_id);

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

    // Staff texts (owner/team) get the internal-assistant persona — never the
    // customer lead-intake script — and never a customer-memory profile.
    const isStaff = Boolean(job.staff_kind);

    // Always-injected prompt lines (identity / grounded actions / quality)
    // live in _shared/sms_prompt_lines.ts so the live-AI e2e suite
    // regression-tests the EXACT production strings (the Derek Schultz
    // call-promise replay). Edit them there.
    const identityLine = SMS_IDENTITY_LINE;
    const groundedActionsLine = SMS_GROUNDED_ACTIONS_LINE;
    const conversationQualityLine = SMS_CONVERSATION_QUALITY_LINE;
    // Date awareness: without this the model cannot resolve "tomorrow at
    // 2pm" into the ISO times the calendar tools require. Business-local
    // when the owner set a timezone; UTC fallback otherwise.
    const dateLine = currentDateTimeLine(new Date(), businessTimezone);

    let customerPreamble: string;
    if (isStaff) {
      // Internal-assistant mode (mirrors the voice staff persona): the texter
      // is the owner or a team member, so help them like a colleague and skip
      // the customer playbook entirely.
      const staffName = job.staff_name?.trim();
      const role =
        job.staff_kind === "owner" ? "the business owner" : "a member of the team";
      const staffLines = [
        `You are texting with ${staffName ? `${staffName}, ` : ""}${role} — this person is NOT a customer or a lead.`,
        "Talk to them like a trusted colleague. Do NOT run the customer intake script: never ask them for their name, contact info, address, timeline, or budget, and never try to qualify them. If you know their name, use it.",
        "Help them as their internal assistant: answer questions about the business from what you know, help look something up, take a message for someone on the team, or help them schedule. Keep replies concise and natural for text.",
        // Staff are not customers — do not create or edit a customer profile
        // for their number.
        "Do NOT use the customer CRM tools (customer_lookup_by_phone, customer_set_display_name, customer_append_pinned_note) on this texter.",
        identityLine,
        groundedActionsLine,
        dateLine
      ];
      customerPreamble = staffLines.join("\n\n");
    } else {
      // Phase 3: customer memory preamble. Pulled from the cross-channel
      // rollup so SMS replies see the same context as voice + dashboard.
      // Cheap if the row doesn't exist (single indexed lookup); preamble
      // is null when there's no summary/pinned content yet, which keeps
      // first-contact SMS exactly as it was pre-Phase-3 (no empty
      // "Customer profile:" header in the prompt).
      // Alias-aware: a number merged into another profile (alias_e164s) must
      // resolve to the surviving row so the merged context follows the texter.
      const { data: memoryRow } = await supabase
        .from("contacts")
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
      // AiFlow context bridge: when an automation recently handled this
      // texter (asked them a question, collected their details), the model
      // must continue THAT conversation, not restart intake. Production
      // showed the post-flow turn asking a lead for their phone number —
      // over SMS (Truly Insurance, 2026-07-11). Best-effort: null on any
      // failure, and the reply proceeds with plain memory context.
      const flowContext = await loadFlowRunContext(supabase, job.business_id, fromE164);
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
      const dateAndPhoneLines = `${identityLine}\n\n${groundedActionsLine}\n\n${conversationQualityLine}\n\n${dateLine}\n\n${phoneLine}`;
      customerPreamble = [dateAndPhoneLines, memoryPreamble, flowContext]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      // Decision-engine capture (PRD Ch. 6): ask the model to end its reply
      // with a machine-read reasoning trailer. splitReplyReasoning strips it
      // before caching/sending, so the customer never sees it. Customer path
      // only — staff chat is internal and needs no lead-facing rationale.
      customerPreamble += REASONING_PROMPT_INSTRUCTION;
    }

    // Inbound MMS photo → stored edit source. Only when the reply path is
    // actually about to run (download + store cost nothing on suppressed
    // jobs, which return before reaching here). Best-effort — but the model
    // is ALWAYS told a photo arrived, so an edit request after a capture
    // failure gets an honest "please resend" instead of a hallucinated edit.
    if (inboundImages.length > 0) {
      const imageRef = await storeInboundImageForEditing(
        supabase,
        job.business_id,
        inboundImages[0]
      );
      customerPreamble += imageRef
        ? `\n\nThe texter attached a photo to this message. Its image reference is ` +
          `"${imageRef}". If they ask you to edit it, restyle it, or create an image ` +
          `based on it, call generate_image with inputImageRef set to exactly that ` +
          `value (and their request as the prompt). Do not mention the reference ` +
          `string itself to the texter.`
        : `\n\nThe texter attached a photo to this message, but it could not be ` +
          `processed. If they ask you to edit it or do anything with it, do NOT call ` +
          `generate_image — apologize and ask them to send the photo again.`;
    }

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
          // kvm1 hardware has no local Ollama model, so there is no
          // CoworkerLocal to degrade to — over-cap turns must refuse. Keyed
          // on the explicit vps_size pin only: a null pin = legacy kvm2/kvm8
          // box that does have the local model.
          localAgent: tenantHasLocalModel(businessVpsSize)
            ? SMS_CHAT_LOCAL_AGENT
            : null
        });

        if (turnPlan.refuse) {
          // Over cap with no local fallback: complete the job WITHOUT an AI
          // reply. Silence toward the customer is deliberate — a canned
          // non-AI text would still spend an SMS segment while promising a
          // follow-up nobody is around to give. The owner already got the
          // fuse-tripped alert from the spend meter; log per-message so the
          // volume of suppressed texts is visible in the tenant's logs.
          await supabase.rpc("complete_sms_inbound_job", {
            p_job_id: job.id,
            p_status: "done",
            p_telnyx_outbound_message_id: null,
            p_rowboat_conversation_id: existingConv,
            p_last_error: "suppressed_over_ai_budget_no_local"
          });
          await clearJobReplyCache(supabase, job.id);
          const { error: refuseStampErr } = await supabase
            .from("sms_inbound_jobs")
            .update({ customer_e164: fromE164 })
            .eq("id", job.id)
            .is("customer_e164", null);
          if (refuseStampErr) {
            console.error("over-cap refuse customer_e164 stamp", refuseStampErr);
          }
          const { error: refuseMemErr } = await supabase.rpc("record_customer_interaction", {
            p_business_id: job.business_id,
            p_customer_e164: fromE164,
            p_channel: "sms",
            p_display_name: null
          });
          if (refuseMemErr) {
            console.error("record_customer_interaction (over-cap refuse)", refuseMemErr);
          }
          await telemetryRecord(supabase, "sms_chat_spend_over_cap_refused", {
            job_id: job.id,
            business_id: job.business_id
          });
          await systemLog(supabase, {
            businessId: job.business_id,
            source: "sms_worker",
            level: "warn",
            event: "sms_reply_suppressed_over_ai_budget",
            message:
              "Inbound SMS got no AI reply: monthly AI budget used up and this plan's hardware has no local fallback model",
            payload: { job_id: job.id }
          });
          processed += 1;
          continue;
        }

        // Continuation turns get a fallback transcript: if the stateless
        // retry fires, the freshly-rooted conversation continues the thread
        // instead of restarting intake (2026-07-13 incident). Loaded only
        // when a continuation exists — a fresh thread has no history to lose.
        const statelessContextExtra =
          !turnPlan.stateless && existingConv
            ? await loadRecentSmsTranscript(supabase, job.business_id, fromE164, job.id)
            : null;

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
          customerPreamble,
          statelessContextExtra,
          // A 5xx is usually a transient upstream (Gemini) outage, not a
          // stale continuation — early attempts surface it to the job-level
          // retry, which re-runs STATEFUL with the thread intact. Only after
          // repeated failures do we allow the history-dropping stateless
          // reset, as the last resort before dead-letter.
          allowStatelessOnServerErrors: job.attempt_count >= STATELESS_5XX_MIN_ATTEMPT
        });
        // Strip the reasoning trailer BEFORE anything caches or sends the
        // reply — the trailer is for the ai_reply_reasoning record only.
        const split = splitReplyReasoning(parsed.reply);
        reply = split.reply;
        if (!reply.trim()) {
          // Degenerate turn: the model answered with ONLY the trailer. Treat
          // it like an empty assistant reply (throw → retry/dead-letter)
          // rather than caching/sending an empty SMS.
          throw new Error("rowboat_empty_assistant_after_reasoning_strip");
        }
        // Persist the decision record best-effort: a failure here (or a model
        // that ignored the trailer instruction) never touches the reply path.
        if (!isStaff && split.reasoning) {
          const { error: reasoningErr } = await supabase.from("ai_reply_reasoning").insert({
            business_id: job.business_id,
            contact_e164: fromE164,
            channel: "sms",
            inbound_preview: userText.slice(0, 300),
            reply_preview: reply.slice(0, 300),
            intent: split.reasoning.intent,
            rationale: split.reasoning.rationale,
            escalated: split.reasoning.escalated,
            model: turnPlan.stateless ? "local" : "gemini"
          });
          if (reasoningErr) console.error("ai_reply_reasoning insert", reasoningErr);
          // Needs-human escalation: the model flagged that a person must take
          // this over (handoff semantics exclude routine bookings). Tags the
          // contact "Needs Human", fires the tag hooks, and pages the owner —
          // once per open escalation (the tag is the open/closed state).
          // Best-effort: never touches the reply that already carries the
          // model's own "someone will follow up" text.
          if (split.reasoning.escalated) {
            await escalateToHuman(supabase, {
              businessId: job.business_id,
              contactE164: fromE164,
              reason: split.reasoning.rationale,
              intent: split.reasoning.intent,
              inboundPreview: userText.slice(0, 300),
              notifyUrl: `${supabaseUrl}/functions/v1/notifications`,
              bearer: serviceKey
            });
          }
        }

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
        // Skipped for staff: an owner/employee text must never create or bump
        // a customer profile for their own number.
        if (!isStaff) {
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
      // A dead-lettered customer message means SILENCE: the texter asked
      // something and will never get an answer unless a human steps in. Page
      // the owner through the needs-human pipeline (tag + notification, with
      // its own open-state dedupe) — a system-log row nobody watches is not
      // an acceptable end state for a real conversation.
      if (deadLetter && !isStaff) {
        await escalateToHuman(supabase, {
          businessId: job.business_id,
          contactE164: fromE164,
          reason:
            "Their text never got a reply — the AI reply failed repeatedly and gave up. Reply to them yourself.",
          intent: "no_reply_sent",
          inboundPreview: userText.slice(0, 300),
          notifyUrl: `${supabaseUrl}/functions/v1/notifications`,
          bearer: serviceKey
        });
      }
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

    // RCS-first for eligible tenants (Standard+, approved + enabled agent):
    // verified-brand reply with Telnyx-side SMS fallback from the tenant's
    // existing number. Resolution is fail-safe (any error → null → plain SMS)
    // and requires a concrete from-number for the fallback leg.
    const rcsAgentId = platformFrom
      ? await resolveRcsAgentId(supabase, job.business_id, businessTier)
      : null;
    let replyChannel: "sms" | "rcs" = "sms";
    // Hoisted so the catch-side reconciliation can reuse a message id from a
    // send that SUCCEEDED before a later step (e.g. the completion RPC) threw.
    // This is the only recovery path for RCS sends: tag-based recovery below
    // searches /v2/messages by the ncw_idem tag, which RCS requests don't carry.
    let mid = "";

    try {
      let sentViaRcs = false;
      if (rcsAgentId) {
        const rcsRes = await fetch("https://api.telnyx.com/v2/messages/rcs", {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent_id: rcsAgentId,
            to: fromE164,
            messaging_profile_id: messagingProfileId,
            type: "RCS",
            // Full body over RCS (no 160/1600 segmenting); only the plain-text
            // fallback leg is capped — Telnyx limits fallback text to 3072,
            // matching sendTelnyxRcsWithFallback in telnyx_sms_compliance.ts.
            agent_message: { content_message: { text: reply } },
            sms_fallback: { from: platformFrom, text: reply.slice(0, 3072) }
          })
        });
        if (rcsRes.ok) {
          const rcsJson = (await rcsRes.json()) as { data?: { id?: string } };
          const rcsMid = rcsJson.data?.id ?? "";
          if (rcsMid) {
            mid = rcsMid;
            sentViaRcs = true;
            replyChannel = "rcs";
          } else {
            // 2xx without a message id means Telnyx did not durably create the
            // message — without an id the send can't be reconciled or tracked,
            // so treat it like a rejection and deliver over plain SMS.
            console.warn("rcs reply accepted but returned no message id, falling back to sms");
          }
        } else {
          // RCS API rejection (agent revoked, destination not routable, …):
          // fall through to plain SMS so the customer never loses a reply to
          // channel plumbing. The idempotency key is safe to reuse — the
          // rejected RCS request created no message.
          console.warn(
            `rcs reply rejected (${rcsRes.status}), falling back to sms:`,
            (await rcsRes.text()).slice(0, 200)
          );
        }
      }
      if (!sentViaRcs) {
        const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(msgBody)
        });
        if (!smsRes.ok) {
          throw new Error(`telnyx_sms_${smsRes.status}_${(await smsRes.text()).slice(0, 200)}`);
        }
        const smsJson = (await smsRes.json()) as { data?: { id?: string } };
        mid = smsJson.data?.id ?? "";
      }
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
      await finalizeDeliveredReply(supabase, job.id, reply, replyChannel);
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
        payload: { job_id: job.id, telnyx_message_id: mid || null, channel: replyChannel }
      });
    } catch (e) {
      // Prefer the in-scope message id (covers RCS + SMS sends that succeeded
      // before a later step threw); fall back to tag-based recovery, which can
      // only find plain-SMS sends carrying the ncw_idem tag.
      const recovered = mid || (idem ? await telnyxTryRecoverOutboundMessageId(apiKey, idem) : null);
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
          // and persist the durable reply for dashboard history. replyChannel
          // is already correct: "rcs" only when the RCS send itself succeeded.
          await finalizeDeliveredReply(supabase, job.id, reply, replyChannel);
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
      // Same silence rule as the Rowboat dead letter above: the reply was
      // composed but never delivered, and retries are exhausted — page the
      // owner so a human answers the texter.
      if (deadLetter && !isStaff) {
        await escalateToHuman(supabase, {
          businessId: job.business_id,
          contactE164: fromE164,
          reason:
            "Their text never got a reply — the answer was written but could not be delivered after repeated attempts. Reply to them yourself.",
          intent: "no_reply_sent",
          inboundPreview: userText.slice(0, 300),
          notifyUrl: `${supabaseUrl}/functions/v1/notifications`,
          bearer: serviceKey
        });
      }
    }
    processed += 1;
  }

  await telemetryRecord(supabase, "sms_inbound_worker_batch", { claimed: list.length, processed });

  return new Response(JSON.stringify({ ok: true, claimed: list.length, processed }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
