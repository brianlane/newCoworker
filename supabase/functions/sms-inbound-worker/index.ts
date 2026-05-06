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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { telnyxMessagingPhoneString } from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import { callSmsRowboatWithStatelessFallback } from "../_shared/sms_rowboat.ts";

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
  supabase: ReturnType<typeof createClient>,
  jobId: string
): Promise<void> {
  await supabase
    .from("sms_inbound_jobs")
    .update({ rowboat_reply_cached: null, updated_at: new Date().toISOString() })
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
    {
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("is_paused, customer_channels_enabled")
        .eq("id", job.business_id)
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
          }
          processed += 1;
          continue;
        }
      }
    }

    const { data: cfg } = await supabase
      .from("business_configs")
      .select("rowboat_project_id")
      .eq("business_id", job.business_id)
      .maybeSingle();

    const projectId =
      (cfg?.rowboat_project_id as string | null) && String(cfg.rowboat_project_id).length > 0
        ? String(cfg.rowboat_project_id)
        : defaultProjectId;

    if (!projectId || !bearer) {
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: null,
        p_last_error: "missing_rowboat_project_or_bearer"
      });
      await clearJobReplyCache(supabase, job.id);
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

    let convId: string | undefined;
    let reply = (job.rowboat_reply_cached ?? "").trim();

    try {
      if (!reply) {
        const existingConv = thread?.rowboat_conversation_id?.trim() ?? null;
        const parsed = await callSmsRowboatWithStatelessFallback({
          chatUrl,
          bearer,
          userText,
          conversationId: existingConv,
          state: thread?.rowboat_state ?? null,
          timeoutMs: ROWBOAT_CHAT_TIMEOUT_MS
        });
        reply = parsed.reply;

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

        convId = (stableConvId || parsed.conversationId || existingConv || "").trim() || undefined;

        // Denormalize the normalized customer E.164 onto the job row
        // so the customers page (Phase 4) + nightly cross-channel
        // summarizer (Phase 2 batch) can query per-customer SMS
        // history without scanning the JSONB payload. Bundled into
        // the same UPDATE as rowboat_reply_cached to avoid an extra
        // round-trip per job.
        const { error: cacheErr } = await supabase
          .from("sms_inbound_jobs")
          .update({
            rowboat_reply_cached: reply,
            customer_e164: fromE164,
            updated_at: new Date().toISOString()
          })
          .eq("id", job.id);
        if (cacheErr) {
          console.error("rowboat_reply_cached", cacheErr);
        }

        if (parsed.retriedStateless) {
          await telemetryRecord(supabase, "sms_worker_rowboat_stateless_retry", {
            job_id: job.id,
            business_id: job.business_id
          });
        }
      } else {
        convId = thread?.rowboat_conversation_id;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.attempt_count >= MAX_ATTEMPTS) {
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

    if ((tset?.telnyx_sms_from_e164 as string | null)?.length) {
      platformFrom = String(tset.telnyx_sms_from_e164);
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
    const reserve = reserveRaw as { ok?: boolean; reason?: string } | null;
    if (!reserve?.ok) {
      // Strict cap: no auto-reply here (customer sees silence). Product follow-up: optional one-shot "quota exceeded" SMS.
      await supabase.rpc("complete_sms_inbound_job", {
        p_job_id: job.id,
        p_status: "dead_letter",
        p_telnyx_outbound_message_id: null,
        p_rowboat_conversation_id: convId ?? null,
        p_last_error: reserve?.reason ?? "monthly_sms_limit"
      });
      await clearJobReplyCache(supabase, job.id);
      processed += 1;
      continue;
    }

    const releaseReservedSlot = async (): Promise<void> => {
      const { error: relErr } = await supabase.rpc("release_sms_outbound_slot", {
        p_business_id: job.business_id
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
      await clearJobReplyCache(supabase, job.id);
      await telemetryRecord(supabase, "sms_inbound_worker_sent", {
        job_id: job.id,
        business_id: job.business_id
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
            // Reconciled: the outbound DID go out, so keep the metered slot.
            await clearJobReplyCache(supabase, job.id);
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
      if (job.attempt_count >= MAX_ATTEMPTS) {
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
    }
    processed += 1;
  }

  await telemetryRecord(supabase, "sms_inbound_worker_batch", { claimed: list.length, processed });

  return new Response(JSON.stringify({ ok: true, claimed: list.length, processed }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
