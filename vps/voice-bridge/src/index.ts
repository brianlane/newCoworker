/**
 * Telnyx media WebSocket bridge: validates signed stream URL (v1), marks nonce consumed,
 * upserts voice_active_sessions, heartbeats bridge health to Supabase, and pipes audio
 * between Telnyx (L16 @ 16 kHz JSON `media` frames) and Gemini Live when `GOOGLE_API_KEY` is set.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type RawData } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./load-env.js";
import {
  createGeminiTelnyxBridge,
  type TransferCapability,
  type HangupCapability,
  type VoicemailCapability,
  type DtmfCapability,
  type CallerIdentity,
  type CapturedLead,
  type IntakeCapability,
  type GeminiLiveUsage
} from "./gemini-telnyx-bridge.js";
import { loadVaultForPrompt } from "./vault-loader.js";
import { smsTextUnits } from "./sms-text-units.js";
import {
  telnyxDialCall,
  telnyxBridgeCall,
  telnyxTransferCall,
  telnyxSendPlainSms,
  meterBridgeOperationalSms,
  telnyxHangupCall,
  telnyxSendDtmf,
  telnyxStreamingStop
} from "./telnyx-call-actions.js";
import { speakVoicemailDeterministic as speakVoicemailOnBridge } from "./voicemail-speak.js";
import {
  parseReachLadderConfig,
  runReachLadder,
  type ReachLadderConfig
} from "./reach-teammate.js";
import {
  composeIntakeLeadSms,
  extractIntakeAlertContext,
  inboundVoicemailScript,
  type IntakeAlertContext,
  type IntakeKnownLead
} from "./intake.js";
import { loadVoiceFlowContext } from "./flow-run-context.js";
import { loadVoiceContactTimeline } from "./contact-context.js";
import {
  loadContactPreferredLanguage,
  resolveVoiceLanguagePrefs
} from "./language-prefs.js";
import { isBridgeToolEnabled } from "./tool-settings.js";
import { loadVoiceBookingLine } from "./booking-context.js";
import type { TranscriptAdapter } from "./voice-transcript.js";
import { startIdleHeartbeatLoop, writeHeartbeat } from "./heartbeat.js";
import {
  AMD_RESOLUTION_SETTINGS_KEY,
  deterministicVoicemailArmed,
  NUMBER_GUARD_SETTINGS_KEY,
  parseRolloutGate,
  rolloutIncludes
} from "./voicemail-mode.js";

loadEnv();

const PORT = Number(process.env.VOICE_BRIDGE_PORT ?? "8090");
const STREAM_SECRET = process.env.STREAM_URL_SIGNING_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUSINESS_ID = process.env.BUSINESS_ID ?? "";
/** Min ms between `voice_active_sessions.last_seen_at` writes per call (audio ~50/s otherwise). */
const LAST_SEEN_UPDATE_INTERVAL_MS = (() => {
  const raw = Number(process.env.VOICE_SESSION_LAST_SEEN_INTERVAL_MS ?? "15000");
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
})();

function readPositiveMs(envKey: string, fallback: number): number {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Shared AI-budget cap (micro-USD), read from the SAME env vars as owner chat +
// SMS (OWNER_CHAT_SPEND_CAP_MICROS / _STARTER) so the mid-call time cap trips
// against the identical pool total those surfaces (and the pre-call gate in
// telnyx-voice-inbound) use, hardcoding $5/$10 here would desync voice from an
// ops-tuned cap. Defaults match _shared/chat_spend_cap.ts and chat-usage.ts.
const OWNER_CHAT_SPEND_CAP_MICROS = (() => {
  const n = Number(process.env.OWNER_CHAT_SPEND_CAP_MICROS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000_000;
})();
const OWNER_CHAT_SPEND_CAP_MICROS_STARTER = (() => {
  const n = Number(process.env.OWNER_CHAT_SPEND_CAP_MICROS_STARTER);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000_000;
})();

/**
 * Derive a per-call Gemini Live time cap (ms) from the tenant's REMAINING shared
 * AI budget so a single (or concurrent) call can't blow the whole pool. This is
 * the mid-call half of the hard stop: the pre-call gate in telnyx-voice-inbound
 * reserves this call's budget and refuses when the pool is fully committed; this
 * shortens the session when only a little budget is left, and the bridge's
 * graceful wind-down (with budget wording) closes the call before it overspends.
 *
 * Remaining is read via `owner_chat_ai_remaining`, which subtracts persisted
 * spend AND active reservations for OTHER concurrent calls (this call's own hold
 * is excluded by `p_exclude_call_control_id`), so overlapping calls size their
 * sessions against what's genuinely left, not the same stale pool.
 *
 * Combined two-way audio costs ~0.375 micro-USD/ms (25 tok/s each way at the
 * $3-in/$12-out audio rates), intentionally CONSERVATIVE, overestimating cost
 * yields a shorter cap, never a longer one. Fails OPEN: any read error returns
 * `envMaxMs` (never shorten a call over a DB blip), and the result is clamped to
 * a small floor so we never answer-then-immediately-hang-up.
 */
// ---------------------------------------------------------------------------
// Monthly quota windows within a (possibly multi-month) Stripe billing period.
// 12/24-month plans are charged in full at checkout, so the Stripe period can
// span the whole prepaid term while the shared AI budget still resets MONTHLY.
// INLINE COPY of supabase/functions/_shared/billing_period_window.ts, keep in
// lockstep (the bridge builds/deploys from its own directory).
// ---------------------------------------------------------------------------
function addUtcMonthsClamped(base: Date, months: number): Date {
  const totalMonths = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), daysInTarget);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
}

// Window 0 echoes the input string verbatim so existing monthly tenants'
// spend keys are bit-for-bit unchanged (period_start is an equality key).
function deriveMonthlyQuotaWindowStart(periodStartIso: string, nowMs: number): string {
  const start = new Date(periodStartIso);
  if (!Number.isFinite(start.getTime())) return periodStartIso;

  let n = 0;
  if (nowMs > start.getTime()) {
    const now = new Date(nowMs);
    // The month-diff estimate can only overshoot around clamped month ends;
    // settle downward onto the invariant window[n] <= now < window[n+1].
    n =
      (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - start.getUTCMonth());
    while (n > 0 && addUtcMonthsClamped(start, n).getTime() > nowMs) n--;
  }
  return n === 0 ? periodStartIso : addUtcMonthsClamped(start, n).toISOString();
}

async function computeBudgetDerivedSessionMaxMs(
  supabase: SupabaseClient,
  businessId: string,
  callControlId: string,
  envMaxMs: number
): Promise<number> {
  try {
    const microsPerMs = readPositiveMs("GEMINI_LIVE_MICROS_PER_MS", 0.375);
    const minMs = readPositiveMs("GEMINI_LIVE_SESSION_MIN_MS", 30_000);

    const { data: bizRow } = await supabase
      .from("businesses")
      .select("tier")
      .eq("id", businessId)
      .maybeSingle();
    const tier = String((bizRow as { tier?: string | null } | null)?.tier ?? "");
    // Starter vs standard/enterprise, read from env (see the constants above) so
    // every surface trips the same shared fuse at the same ops-tuned total.
    const baseCapMicros =
      tier === "starter"
        ? OWNER_CHAT_SPEND_CAP_MICROS_STARTER
        : OWNER_CHAT_SPEND_CAP_MICROS;

    const now = new Date();
    let periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const { data: subRow } = await supabase
      .from("subscriptions")
      .select("stripe_current_period_start, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const subStart = (subRow as { stripe_current_period_start?: string | null } | null)
      ?.stripe_current_period_start;
    if (subStart) periodStart = deriveMonthlyQuotaWindowStart(subStart, Date.now());

    let creditMicros = 0;
    const { data: creditRaw, error: creditErr } = await supabase.rpc("chat_active_credit_micros", {
      p_business_id: businessId
    });
    if (!creditErr) {
      const n = Number(creditRaw ?? 0);
      if (Number.isFinite(n) && n > 0) creditMicros = n;
    }
    const capMicros = baseCapMicros + creditMicros;

    // Remaining = cap - persisted spend - OTHER calls' active reservations.
    const { data: remainingRaw, error: remErr } = await supabase.rpc("owner_chat_ai_remaining", {
      p_business_id: businessId,
      p_period_start: periodStart,
      p_cap_micros: capMicros,
      p_exclude_call_control_id: callControlId
    });
    if (remErr) throw new Error(remErr.message);
    const remainingMicros = Number(remainingRaw ?? 0);
    if (!Number.isFinite(remainingMicros) || remainingMicros <= 0) {
      // The pre-call gate reserves/refuses, but clamp to the floor (not 0)
      // rather than trust a racy read to zero out the session.
      return Math.min(envMaxMs, minMs);
    }
    // The pre-call gate reserved this call's budget and refuses whenever the
    // remaining headroom is below one min-session's cost, so an answered call
    // almost always has budgetMs >= minMs and the floor is not the binding
    // limit. The `Math.max(minMs, …)` only covers the small race window where
    // spend/holds advanced between the gate and this read.
    const budgetMs = Math.floor(remainingMicros / microsPerMs);
    return Math.min(envMaxMs, Math.max(minMs, budgetMs));
  } catch (err) {
    console.warn(
      "voice-bridge: budget-derived session cap failed (using env cap)",
      err instanceof Error ? err.message : String(err)
    );
    return envMaxMs;
  }
}

/**
 * Coerce a raw phone string to E.164 (US-centric), mirroring the SMS worker's
 * `_shared/normalize_e164.ts`. Bare 10-digit inputs are assumed NANP (+1),
 * 11-digit `1...` are NANP, anything else must already start with '+'. Returns
 * null for empty / structurally invalid inputs so caller-identity comparisons
 * can't false-match on junk. Needed because owner numbers in the DB are stored
 * inconsistently (e.g. `businesses.phone` may be a bare 10-digit string while
 * the caller arrives as `+1...`).
 */
function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  let candidate: string;
  if (cleaned.startsWith("+")) candidate = cleaned;
  else if (cleaned.length === 10) candidate = `+1${cleaned}`;
  else if (cleaned.length === 11 && cleaned.startsWith("1")) candidate = `+${cleaned}`;
  else return null;
  if (!/^\+[1-9]\d{0,14}$/.test(candidate)) return null;
  if (candidate.slice(1).length < 7) return null;
  return candidate;
}

/**
 * Decide whether the caller is the business owner, a team member, or a regular
 * customer. Mirrors the SMS worker's gate (telnyx-sms-inbound): a call from a
 * known team member or one of the owner's configured numbers (Safe Mode
 * forward cell, notification alert phone, or the business's own number) is
 * never a customer. Best-effort, any DB hiccup degrades to "customer" so a
 * lookup failure never blocks a live call. Returns `{ kind: "customer" }` for
 * anonymous/unknown callers.
 */
async function resolveCallerIdentity(
  supabase: SupabaseClient,
  businessId: string,
  callerE164: string,
  ownerCandidates: Array<string | null | undefined>,
  ownerName: string | null | undefined
): Promise<CallerIdentity> {
  const callerNorm = normalizeE164(callerE164);
  if (!callerNorm) return { kind: "customer" };
  try {
    const { data: member } = await supabase
      .from("ai_flow_team_members")
      .select("name")
      .eq("business_id", businessId)
      .eq("phone_e164", callerNorm)
      .eq("active", true)
      .maybeSingle();
    if (member) {
      const name = (member as { name?: string | null }).name?.trim();
      return { kind: "team", name: name || undefined };
    }
  } catch (err) {
    console.warn("voice-bridge: team member lookup failed (non-fatal)", err);
  }
  const ownerNorm = ownerCandidates
    .map((n) => normalizeE164(n ?? ""))
    .filter((n): n is string => Boolean(n));
  if (ownerNorm.includes(callerNorm)) {
    // Leave name unset when owner_name is blank (don't fabricate "the owner",
    // the greeting would then literally say "Hey the owner"). The greeting and
    // system prompt both handle a nameless staff caller gracefully.
    return { kind: "owner", name: ownerName?.trim() || undefined };
  }
  return { kind: "customer" };
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Mirrors the signers in supabase/functions/_shared/stream_url.ts and
// src/lib/telnyx/stream-url.ts. Key order is the security contract and must
// match byte-for-byte. v2 adds the signed caller number (from_e164) between
// to_e164 and exp; v1 omits it (legacy, drained within the 120s URL TTL).
function signMac(payload: {
  v: number;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  from_e164?: string;
  exp: number;
  nonce: string;
}): string {
  const canonical =
    payload.v === 2
      ? JSON.stringify({
          v: payload.v,
          call_control_id: payload.call_control_id,
          business_id: payload.business_id,
          to_e164: payload.to_e164,
          from_e164: payload.from_e164 ?? "",
          exp: payload.exp,
          nonce: payload.nonce
        })
      : JSON.stringify({
          v: payload.v,
          call_control_id: payload.call_control_id,
          business_id: payload.business_id,
          to_e164: payload.to_e164,
          exp: payload.exp,
          nonce: payload.nonce
        });
  return b64url(createHmac("sha256", STREAM_SECRET).update(canonical).digest());
}

type TenantTelnyxSettings = {
  forwardToE164: string | null;
  transferEnabled: boolean;
  smsFallbackEnabled: boolean;
  smsFromE164: string | null;
  messagingProfileId: string | null;
  /**
   * Translator mode: after a warm transfer, stay on the call interpreting
   * between the caller and the human instead of detaching. Only meaningful when
   * telnyx-voice-inbound ARMED the stream at answer time (target_legs=both) off
   * this same column, which is why the bridge does not re-derive it per call.
   */
  translatorModeEnabled: boolean;
  /**
   * Standard+ tier check on its own, for bridge-local tools that are not
   * covered by translatorModeEnabled. That flag is the POST-TRANSFER
   * stay-on-the-line path (owner toggle AND tier); the staff-request
   * start_translator_mode tool reads only the Coworker-tools row, so without
   * this a Starter owner could say "be my interpreter" and run full-duplex
   * Gemini Live with the session cap deferred - the exact cost leak the tier
   * gate exists to close.
   */
  translatorTierAllowed: boolean;
  /**
   * The tenant's chosen Gemini Live voice, or null for the platform default.
   * Read per call (not baked into box env at provision) so an owner can audition
   * voices from the admin page without a redeploy.
   */
  voiceName: string | null;
};

/**
 * Supabase-backed `TranscriptAdapter`. Writes are direct (service-role),
 * same trust model as `voice_active_sessions` heartbeats. All methods log on
 * failure and never throw; a DB issue must not crash the media pipe.
 */
function createSupabaseTranscriptAdapter(
  supabase: SupabaseClient,
  options?: { recordCustomerInteraction?: boolean }
): TranscriptAdapter {
  // Staff callers (owner/team) aren't customers, so don't bump/create a
  // customer_memories row for their number. Defaults to true (customer).
  const recordCustomerInteraction = options?.recordCustomerInteraction !== false;
  return {
    createTranscript: async (input) => {
      // Best-effort FK to the reservation. Transcript is still usable if the
      // lookup fails (reservation_id stays NULL).
      let reservationId: string | null = null;
      try {
        const { data } = await supabase
          .from("voice_reservations")
          .select("id")
          .eq("call_control_id", input.callControlId)
          .maybeSingle();
        reservationId = (data as { id: string } | null)?.id ?? null;
      } catch (err) {
        console.warn("voice-transcript: reservation lookup failed", err);
      }
      const { data, error } = await supabase
        .from("voice_call_transcripts")
        .insert({
          business_id: input.businessId,
          call_control_id: input.callControlId,
          reservation_id: reservationId,
          caller_e164: input.callerE164 || null,
          model: input.model,
          direction: input.direction,
          status: "in_progress"
        })
        .select("id")
        .single();
      if (error) {
        console.error("voice-transcript: create failed", error.message);
        return null;
      }
      return (data as { id: string }).id;
    },
    markInterpretedFrom: async (input) => {
      // The transcript row is the one the bridge created for this call, so a
      // plain id match is enough; failures are logged and dropped, like every
      // other transcript write.
      const { error } = await supabase
        .from("voice_call_transcripts")
        .update({
          interpreted_from_turn_index: input.fromTurnIndex,
          updated_at: new Date().toISOString()
        })
        .eq("id", input.transcriptId);
      if (error) {
        console.error("voice-transcript: markInterpretedFrom failed", error.message);
      }
    },
    insertTurn: async (input) => {
      const { error } = await supabase
        .from("voice_call_transcript_turns")
        .insert({
          transcript_id: input.transcriptId,
          role: input.role,
          content: input.content,
          turn_index: input.turnIndex
        });
      if (error) {
        console.error("voice-transcript: insert turn failed", error.message);
      }
    },
    finalizeTranscript: async (input) => {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("voice_call_transcripts")
        .update({
          status: input.status,
          ended_at: nowIso,
          updated_at: nowIso
        })
        .eq("id", input.transcriptId);
      if (error) {
        console.error("voice-transcript: finalize failed", error.message);
      }

      // Phase 3b memory write-through: bump the (business, caller_e164)
      // customer_memories counter and timestamp at end of every voice
      // call. Mirrors what the SMS worker does after a successful
      // exchange. This is what makes the cross-channel memory feel
      // continuous: the next SMS or call from this number will see
      // an up-to-date last_channel/last_interaction_at, and the
      // nightly summarizer sweep will re-trigger if interaction_count
      // crossed threshold.
      //
      // Best-effort:
      //   - We don't have caller_e164 on the input here; the recorder
      //     was created with the call's callerE164 in the closure. We
      //     re-fetch from the transcript row so this stays self-
      //     contained even when the recorder API evolves.
      //   - A missing customer_memories table (VPS Supabase predates
      //     migration 20260507000000) returns a 4xx that we swallow,
      //     same shape as the read path above.
      if (!recordCustomerInteraction) return;
      try {
        const { data: t } = await supabase
          .from("voice_call_transcripts")
          .select("business_id, caller_e164")
          .eq("id", input.transcriptId)
          .maybeSingle();
        const row = t as { business_id?: string; caller_e164?: string | null } | null;
        if (row?.business_id && row.caller_e164) {
          const { error: rpcErr } = await supabase.rpc("record_customer_interaction", {
            p_business_id: row.business_id,
            p_customer_e164: row.caller_e164,
            p_channel: "voice",
            p_display_name: null
          });
          if (rpcErr) {
            console.warn("voice-transcript: record_customer_interaction failed", rpcErr.message);
          }
        }
      } catch (err) {
        console.warn(
          "voice-transcript: customer-memory write-through error (non-fatal)",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  };
}

async function loadTenantTelnyxSettings(
  supabase: SupabaseClient,
  businessId: string
): Promise<TenantTelnyxSettings> {
  const [{ data }, { data: bizRow }] = await Promise.all([
    supabase
      .from("business_telnyx_settings")
      .select(
        "forward_to_e164, transfer_enabled, sms_fallback_enabled, telnyx_sms_from_e164, telnyx_messaging_profile_id, translator_mode_enabled, voice_name"
      )
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase.from("businesses").select("tier").eq("id", businessId).maybeSingle()
  ]);
  const row = (data ?? null) as null | {
    forward_to_e164: string | null;
    transfer_enabled: boolean | null;
    sms_fallback_enabled: boolean | null;
    telnyx_sms_from_e164: string | null;
    telnyx_messaging_profile_id: string | null;
    translator_mode_enabled: boolean | null;
    voice_name: string | null;
  };
  const tier = (bizRow as { tier?: string | null } | null)?.tier ?? null;
  // Standard+ only. Mirror the Edge answer-time gate so a leftover settings
  // flag cannot offer start_translator_mode or stay-on-transfer on Starter.
  const translatorTierOk = tier === "standard" || tier === "enterprise";
  return {
    forwardToE164: row?.forward_to_e164 ?? null,
    transferEnabled: row?.transfer_enabled ?? true,
    smsFallbackEnabled: row?.sms_fallback_enabled ?? true,
    smsFromE164: row?.telnyx_sms_from_e164 ?? null,
    messagingProfileId: row?.telnyx_messaging_profile_id ?? null,
    // Opt-in: a box running an older schema (column absent) reads as false and
    // behaves exactly as it did before translator mode existed.
    translatorModeEnabled: row?.translator_mode_enabled === true && translatorTierOk,
    translatorTierAllowed: translatorTierOk,
    voiceName: row?.voice_name ?? null
  };
}

/**
 * The two voice rollout gates for this business, read in one query at session
 * attach. Fail-OFF on any error or malformed value: both features change call
 * behavior irreversibly (muted model audio, refused hangups, flushed playback
 * queues), so an unreadable gate must mean yesterday's behavior, never a
 * half-armed one. Parsing is the lockstep copy in voicemail-mode.ts.
 */
async function loadVoiceRolloutEnrollment(
  supabase: SupabaseClient,
  businessId: string
): Promise<{ amdResolution: boolean; numberGuard: boolean }> {
  const off = { amdResolution: false, numberGuard: false };
  try {
    const { data, error } = await supabase
      .from("admin_platform_settings")
      .select("key, value")
      .in("key", [AMD_RESOLUTION_SETTINGS_KEY, NUMBER_GUARD_SETTINGS_KEY]);
    if (error) {
      console.error("voice-bridge: rollout gates read failed", error);
      return off;
    }
    const byKey = new Map(
      ((data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value])
    );
    return {
      amdResolution: rolloutIncludes(
        parseRolloutGate(byKey.get(AMD_RESOLUTION_SETTINGS_KEY)),
        businessId
      ),
      numberGuard: rolloutIncludes(
        parseRolloutGate(byKey.get(NUMBER_GUARD_SETTINGS_KEY)),
        businessId
      )
    };
  } catch (err) {
    console.error("voice-bridge: rollout gates read threw", err);
    return off;
  }
}

/**
 * Send the owner a "missed AI call" SMS when the Gemini Live session could
 * not start. This path is only ever hit when `sms_fallback_enabled` is on
 * AND a `forward_to_e164` is configured; we never SMS the caller.
 */
async function sendMissedCallSms(params: {
  supabase: SupabaseClient;
  businessId: string;
  settings: TenantTelnyxSettings;
  callerE164: string;
  businessName: string;
  reason: string;
}): Promise<void> {
  const { supabase, businessId, settings, callerE164, businessName, reason } = params;
  if (!settings.smsFallbackEnabled || !settings.forwardToE164 || !settings.smsFromE164) return;
  const apiKey = process.env.TELNYX_API_KEY ?? "";
  if (!apiKey) return;
  const text =
    `[${businessName}] your AI coworker couldn't take a live call from ${callerE164}. ` +
    `Please call them back. (Reason: ${reason.slice(0, 80)})`;
  const res = await telnyxSendPlainSms(apiKey, {
    toE164: settings.forwardToE164,
    fromE164: settings.smsFromE164,
    messagingProfileId: settings.messagingProfileId ?? undefined,
    text
  });
  if (!res.ok) {
    console.error("voice-bridge: fallback SMS failed", res.status, res.body);
  } else {
    await meterBridgeOperationalSms(supabase, businessId, smsTextUnits(text));
  }
}

/**
 * Meter a completed Gemini Live session's exact token usage into the shared AI
 * budget (`owner_chat_model_spend`) via the same app endpoint the llm-router
 * uses for chat/SMS/voice_task. This is the SECOND Gemini voice metering point:
 * `voice_task` (Rowboat text turns) meter through the router, while the Live
 * audio-to-audio model holds its WebSocket here in the bridge, so its usage is
 * only visible to us. Audio tokens are forwarded separately so the app can
 * price them at the audio rate (in $3/1M, out $12/1M) vs the small text
 * remainder. Best-effort: a metering failure can only under-count the fuse.
 */
/**
 * Estimate a Gemini Live session's usage from its DURATION when the session
 * never reported `usageMetadata` (some sessions, very short calls, transport
 * errors, close without a usage frame). Without this the spend POST is skipped
 * entirely, leaving `owner_chat_model_spend` flat while Google still bills the
 * audio, so the pre-call/mid-call budget gates would keep allowing voice on an
 * already-exhausted pool. Gemini Live audio is ~25 tokens/sec each direction; we
 * count both directions for the full call (conservative, never undercount) so
 * the token math lands on the same ~0.375 micro-USD/ms the mid-call cap assumes
 * (25 tok/s × ($3 in + $12 out)/1M). Returns null for a zero/negative duration.
 */
function estimateLiveUsageFromDuration(
  startedAtMs: number | undefined,
  endedAtMs: number
): GeminiLiveUsage | null {
  if (!startedAtMs || endedAtMs <= startedAtMs) return null;
  const durationSec = (endedAtMs - startedAtMs) / 1000;
  const perSec = readPositiveMs("GEMINI_LIVE_AUDIO_TOKENS_PER_SEC", 25);
  const tokens = Math.round(perSec * durationSec);
  if (tokens <= 0) return null;
  return {
    promptTokens: tokens,
    outputTokens: tokens,
    promptAudioTokens: tokens,
    outputAudioTokens: tokens,
    totalTokens: tokens * 2
  };
}

/**
 * Release this call's AI-budget hold WITHOUT recording spend, used when the
 * bridge never opened or produced no billable tokens. Best-effort; the
 * reservation also auto-expires, so a failure here can't pin budget forever.
 */
async function releaseAiBudgetReservation(
  supabase: SupabaseClient,
  callControlId: string
): Promise<void> {
  try {
    const { error } = await supabase.rpc("owner_chat_ai_release", {
      p_call_control_id: callControlId
    });
    if (error) console.error("voice-bridge: owner_chat_ai_release", error.message);
  } catch (err) {
    console.error(
      "voice-bridge: owner_chat_ai_release threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function meterGeminiLiveSpend(params: {
  businessId: string;
  model: string;
  usage: GeminiLiveUsage;
  /** Settle this call's AI-budget reservation (release the hold + record actual). */
  callControlId: string;
  /** True when `usage` is a duration-based estimate (no usageMetadata frame). */
  estimated?: boolean;
}): Promise<void> {
  const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (!appBaseUrl || !gatewayToken) return;
  // Nothing billable (session never produced tokens), skip the round trip.
  if (params.usage.promptTokens <= 0 && params.usage.outputTokens <= 0) return;
  try {
    const res = await fetch(`${appBaseUrl}/api/internal/meter-gemini-spend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`
      },
      body: JSON.stringify({
        businessId: params.businessId,
        model: params.model,
        // callControlId routes the app to owner_chat_ai_settle: it releases this
        // call's reservation AND records the exact spend in one atomic step.
        callControlId: params.callControlId,
        usage: {
          promptTokens: params.usage.promptTokens,
          outputTokens: params.usage.outputTokens,
          promptAudioTokens: params.usage.promptAudioTokens,
          outputAudioTokens: params.usage.outputAudioTokens
        }
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("voice-bridge: meter-gemini-spend failed", res.status, body.slice(0, 200));
    } else {
      console.log("voice-bridge: Gemini Live spend metered", {
        model: params.model,
        estimated: Boolean(params.estimated),
        promptTokens: params.usage.promptTokens,
        outputTokens: params.usage.outputTokens,
        promptAudioTokens: params.usage.promptAudioTokens,
        outputAudioTokens: params.usage.outputAudioTokens
      });
    }
  } catch (err) {
    console.error(
      "voice-bridge: meter-gemini-spend threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Max characters of transcript to include in the intake SMS (Telnyx segments long bodies). */
const INTAKE_SMS_MAX_CHARS = 3000;

/**
 * CRM contact row for the number an outbound intake call dialed, so the
 * finished-call alert can name the lead the platform already knows (their
 * name, email, and lead source) instead of arriving blind. `contacts` is a
 * residency-KEPT table (deliberately central, the box copy only lags it), so
 * this central read is correct for every tenant. Best-effort: any miss or
 * error just drops the enrichment, never the alert.
 */
async function lookupIntakeKnownLead(
  supabase: SupabaseClient,
  businessId: string,
  e164: string
): Promise<IntakeKnownLead | undefined> {
  try {
    const { data, error } = await supabase
      .from("contacts")
      .select("display_name, email, lead_source")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${e164},alias_e164s.cs.{${e164}}`)
      .limit(1);
    if (error || !data || data.length === 0) return undefined;
    const row = data[0] as {
      display_name?: string | null;
      email?: string | null;
      lead_source?: string | null;
    };
    const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const leadSource = typeof row.lead_source === "string" ? row.lead_source.trim() : "";
    if (!name && !email && !leadSource) return undefined;
    return {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(leadSource ? { leadSource } : {})
    };
  } catch (err) {
    console.warn("voice-bridge: intake known-lead lookup failed (non-fatal)", err);
    return undefined;
  }
}

/**
 * After a HomeLight AI-takeover call ends, text the owner (notify number) a
 * structured lead summary plus the full transcript. Best-effort: a missing SMS
 * config or transcript just trims the message; we never throw.
 *
 * `callDirection` and the enrichment fields exist because the same summary
 * also fires for OUTBOUND `place_ai_call` calls, where the old inbound-shaped
 * message was wrong twice over: the header claimed a missed warm handoff on a
 * call the platform placed, and the dialed lead's own number rendered as
 * "Transferred via". See `composeIntakeLeadSms` for the direction semantics.
 */
async function sendIntakeLeadSms(params: {
  supabase: SupabaseClient;
  businessId: string;
  settings: TenantTelnyxSettings;
  notifyE164: string;
  callControlId: string;
  /** The live-transfer line the call arrived on (transfer partner), not the seller. Inbound only. */
  transferFromE164: string;
  businessName: string;
  lead: CapturedLead;
  /** Frame the summary in asterisks (the flow's options.starAlerts). */
  starFrame?: boolean;
  /** Who dialed; outbound reshapes the header and number labeling. */
  callDirection?: "inbound" | "outbound";
  /** Outbound only: the number the platform dialed (the lead's own number). */
  leadE164?: string;
  /** CRM contact fields for the dialed number. */
  known?: IntakeKnownLead;
  /** The flow's briefing note for the call, rendered under "Call briefing:". */
  flowContextNote?: string;
  /** Machine verdict stamps read off the session context. */
  voicemail?: { detected: boolean; messageLeft: boolean; messageBeingLeft?: boolean };
}): Promise<void> {
  const { supabase, businessId, settings, notifyE164, callControlId, transferFromE164, businessName, lead } =
    params;
  const apiKey = process.env.TELNYX_API_KEY ?? "";
  if (!apiKey || !settings.smsFromE164 || !notifyE164) {
    console.warn("voice-bridge: intake SMS skipped (missing api key / from / notify number)");
    return;
  }

  let transcript = "";
  try {
    const { data: t } = await supabase
      .from("voice_call_transcripts")
      .select("id")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    const transcriptId = (t as { id?: string } | null)?.id;
    if (transcriptId) {
      const { data: turns } = await supabase
        .from("voice_call_transcript_turns")
        .select("role, content, turn_index")
        .eq("transcript_id", transcriptId)
        .order("turn_index", { ascending: true });
      transcript = (turns ?? [])
        .map((r) => {
          const row = r as { role?: string; content?: string };
          const who = row.role === "assistant" ? "AI" : "Client";
          return `${who}: ${row.content ?? ""}`;
        })
        .join("\n");
    }
  } catch (err) {
    console.warn("voice-bridge: intake transcript read failed (non-fatal)", err);
  }

  const text = composeIntakeLeadSms({
    businessName,
    lead,
    transferFromE164,
    transcript,
    maxChars: INTAKE_SMS_MAX_CHARS,
    starFrame: params.starFrame === true,
    callDirection: params.callDirection,
    leadE164: params.leadE164,
    known: params.known,
    flowContextNote: params.flowContextNote,
    voicemail: params.voicemail
  });

  const res = await telnyxSendPlainSms(apiKey, {
    toE164: notifyE164,
    fromE164: settings.smsFromE164,
    messagingProfileId: settings.messagingProfileId ?? undefined,
    text
  });
  if (!res.ok) {
    console.error("voice-bridge: intake SMS failed", res.status, res.body);
  } else {
    console.log("voice-bridge: intake lead SMS sent", { callControlId, to: notifyE164 });
    await meterBridgeOperationalSms(supabase, businessId, smsTextUnits(text));
  }
}

/**
 * Text the flow-configured transfer target the pre-alert ("LIVE TRANSFER
 * incoming, pick up!") right before the warm transfer rings them. Same
 * bridge-side send path as the intake summary SMS; a successful send is
 * counted against the tenant's operational SMS pool. Best-effort: an SMS
 * hiccup must never block the actual transfer.
 */
async function sendTransferPreAlertSms(params: {
  supabase: SupabaseClient;
  businessId: string;
  settings: TenantTelnyxSettings;
  toE164: string;
  body: string;
  callControlId: string;
}): Promise<void> {
  const { supabase, businessId, settings, toE164, body, callControlId } = params;
  const apiKey = process.env.TELNYX_API_KEY ?? "";
  if (!apiKey || !settings.smsFromE164) {
    console.warn("voice-bridge: transfer pre-alert skipped (missing api key / from number)");
    return;
  }
  try {
    const res = await telnyxSendPlainSms(apiKey, {
      toE164,
      fromE164: settings.smsFromE164,
      messagingProfileId: settings.messagingProfileId ?? undefined,
      text: body
    });
    if (!res.ok) {
      console.error("voice-bridge: transfer pre-alert SMS failed", res.status, res.body);
    } else {
      console.log("voice-bridge: transfer pre-alert SMS sent", { callControlId, to: toE164 });
      await meterBridgeOperationalSms(supabase, businessId, smsTextUnits(body));
    }
  } catch (err) {
    console.error("voice-bridge: transfer pre-alert SMS threw", err);
  }
}

/**
 * The outbound session context's parked-run link (see
 * supabase/functions/_shared/voice_outbound.ts OutboundSessionContext.flow_run).
 */
type FlowRunLink = {
  run_id?: unknown;
  save_as?: unknown;
  marker?: unknown;
  step_index?: unknown;
};

/**
 * Stamp `transfer_initiated: true` on the handoff session context so
 * telnyx-voice-call-end derives the "transferred" outcome at hangup even if
 * the direct run resume below never landed. Read-modify-write is fine here:
 * the bridge is the only writer of this flag, once, on its own session.
 */
async function stampTransferInitiated(
  supabase: SupabaseClient,
  callControlId: string
): Promise<void> {
  try {
    const { data } = await supabase
      .from("voice_handoff_sessions")
      .select("context")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    const ctx =
      (data as { context?: Record<string, unknown> } | null)?.context &&
      typeof (data as { context?: unknown }).context === "object"
        ? ((data as { context: Record<string, unknown> }).context)
        : {};
    await supabase
      .from("voice_handoff_sessions")
      .update({ context: { ...ctx, transfer_initiated: true } })
      .eq("call_control_id", callControlId);
  } catch (err) {
    console.error("voice-bridge: transfer_initiated stamp failed", err);
  }
}

/**
 * Resume the batch-flow run a place_ai_call step parked (status
 * `awaiting_call`) with the call outcome. Node mirror of
 * supabase/functions/_shared/ai_flows/call_outcome.ts (the bridge is a
 * separate runtime), keep the two in lockstep. Status/revision-guarded so
 * only the first writer lands; a miss is backstopped by call-end and the
 * timeout sweep. Never throws.
 */
/**
 * The human phrase for an outcome, mirroring callOutcomeLabel() in
 * supabase/functions/_shared/ai_flows/call_outcome_meta.ts. Only the outcomes
 * this bridge can deliver are covered: it never has a REASON to report (a
 * machine verdict comes from the call-end webhook, not from here), so the
 * reason-specific phrases stay in the Deno copy. Keep the shared phrases
 * identical to that module.
 */
function callOutcomeLabelMirror(
  outcome: "transferred" | "answered" | "no_answer"
): string {
  if (outcome === "transferred") return "connected you live";
  if (outcome === "answered") return "spoke with them";
  return "no answer yet";
}

async function resumeFlowRunWithCallOutcome(
  supabase: SupabaseClient,
  link: FlowRunLink,
  outcome: "transferred" | "answered" | "no_answer"
): Promise<boolean> {
  const runId = typeof link.run_id === "string" ? link.run_id : "";
  if (!runId) return false;
  const saveAs =
    typeof link.save_as === "string" && link.save_as.trim() ? link.save_as : "call_outcome";
  const marker =
    typeof link.marker === "string" && link.marker.trim() ? link.marker : "__called_unknown";
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, status, context, revision")
      .eq("id", runId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("voice-bridge: call-outcome run lookup", error);
      return false;
    }
    const run = data as {
      id: string;
      status: string;
      context: Record<string, unknown> | null;
      revision: number;
    };
    if (run.status !== "awaiting_call") return false;
    const waiting = (run.context?.waiting_call ?? {}) as { step_index?: unknown };
    if (
      typeof link.step_index === "number" &&
      typeof waiting.step_index === "number" &&
      waiting.step_index !== link.step_index
    ) {
      return false;
    }
    const prevVars =
      run.context?.vars && typeof run.context.vars === "object"
        ? (run.context.vars as Record<string, unknown>)
        : {};
    const nextContext = {
      ...(run.context ?? {}),
      vars: {
        ...prevVars,
        [saveAs]: outcome,
        // The two companion vars every place_ai_call step declares. Written
        // here too, or a template reading {{vars.<saveAs>_label}} after a call
        // that ENDED NORMALLY would render empty while the same template after
        // a refusal reads fine. Always overwritten, never merged: a retry
        // ladder can reuse one outcome var across attempts.
        [`${saveAs}_reason`]: "",
        [`${saveAs}_label`]: callOutcomeLabelMirror(outcome),
        [marker]: "1"
      },
      waiting_call: {
        ...(run.context?.waiting_call as Record<string, unknown>),
        result: outcome
      }
    };
    const { data: updated, error: updErr } = await supabase
      .from("ai_flow_runs")
      .update({
        status: "queued",
        respond_by_at: null,
        claimed_at: null,
        context: nextContext,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("revision", run.revision)
      .eq("status", "awaiting_call")
      .select("id");
    if (updErr) {
      console.error("voice-bridge: call-outcome run resume", updErr);
      return false;
    }
    const resumed = ((updated ?? []) as unknown[]).length > 0;
    if (resumed) {
      console.log("voice-bridge: flow run resumed with call outcome", { runId, outcome });
    }
    return resumed;
  } catch (err) {
    console.error("voice-bridge: call-outcome resume threw", err);
    return false;
  }
}

function main(): void {
  if (!STREAM_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("voice-bridge: set STREAM_URL_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Kick off the idle-heartbeat loop as soon as we have a Supabase client
  // and a known BUSINESS_ID. We deliberately skip the loop when BUSINESS_ID
  // is missing (single-tenant container with no provisioned business yet),
  // upserts without a primary key would error out with FK violations on
  // every interval and spam the logs without producing useful signal. The
  // per-call heartbeat inside the WS upgrade handler is still a backstop,
  // so we don't lose health visibility for those edge configurations.
  if (BUSINESS_ID) {
    startIdleHeartbeatLoop(supabase, BUSINESS_ID);
  }

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("voice-bridge ok\n");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/voice/stream" && !path.endsWith("/voice/stream")) {
      socket.destroy();
      return;
    }

    const v = Number(url.searchParams.get("v") ?? "0");
    const callControlId = url.searchParams.get("call_control_id") ?? "";
    const businessId = url.searchParams.get("business_id") ?? BUSINESS_ID;
    const toE164 = url.searchParams.get("to_e164") ?? "";
    const exp = Number(url.searchParams.get("exp") ?? "0");
    const nonce = url.searchParams.get("nonce") ?? "";
    const mac = url.searchParams.get("mac") ?? "";
    // Transported as `from_e164_info`. SIGNED in v2 (trusted for staff +
    // memory below); merely informational in legacy v1 (display/SMS only).
    const fromE164Info = url.searchParams.get("from_e164_info") ?? "";

    // Accept both v1 (legacy, no signed caller) and v2 (signed caller). v1
    // URLs drain within the 120s TTL after telnyx-voice-inbound is deployed.
    if ((v !== 1 && v !== 2) || !callControlId || !businessId || !toE164 || !nonce || !mac) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (Math.floor(Date.now() / 1000) > exp + 5) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const expected = signMac({
      v,
      call_control_id: callControlId,
      business_id: businessId,
      to_e164: toE164,
      // Only part of the canonical for v2; signMac ignores it for v1.
      from_e164: fromE164Info,
      exp,
      nonce
    });
    // The caller number is only trustworthy when it was inside the verified v2
    // canonical. For v1 we must NOT trust the unsigned param for any security
    // decision (staff persona, memory recognition), see issue #268. Empty
    // string makes the caller resolve as a first-time customer (safe default).
    const callerTrusted = v === 2;
    const trustedFromE164 = callerTrusted ? fromE164Info : "";
    try {
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(mac, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Consume the single-use nonce BEFORE completing the WebSocket handshake. Prior
    // to this, `wss.handleUpgrade` ran first and we relied on `ws.close(4401)` to
    // reject a reused nonce, which meant a replayed URL got an HTTP 101 upgrade and
    // then an immediate close rather than being rejected at the HTTP layer. Doing
    // the nonce UPDATE here (with the `is("consumed_at", null)` predicate) ensures a
    // reused/invalid nonce never sees an accepted WebSocket.
    void (async (): Promise<void> => {
      const { data: consumed, error: nonceErr } = await supabase
        .from("stream_url_nonces")
        .update({ consumed_at: new Date().toISOString() })
        .eq("nonce", nonce)
        .is("consumed_at", null)
        .select("nonce")
        .maybeSingle();

      if (nonceErr || !consumed?.nonce) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, async (ws) => {
      // Diagnostics sink → telemetry_events (queryable from the dashboard /
      // Supabase). The Gemini bridge lifecycle (session start, greeting, close
      // code/reason, frame counters) previously only existed in VPS stdout,
      // which we can't read from here. Routing it through `telemetry_record`
      // lets us diagnose "greeting then dead air" from a single SQL query
      // after a test call. Fire-and-forget; never blocks the media pipe.
      const recordDiag = (eventType: string, payload: Record<string, unknown> = {}): void => {
        void Promise.resolve(
          supabase.rpc("telemetry_record", {
            p_event_type: eventType,
            p_payload: {
              call_control_id: callControlId,
              business_id: businessId,
              caller_e164: fromE164Info || null,
              ts: new Date().toISOString(),
              ...payload
            }
          })
        ).then(
          (res) => {
            const err = (res as { error?: { message?: string } | null } | null)?.error;
            if (err) console.error("voice-bridge: telemetry_record error", err.message);
          },
          (err) =>
            console.error(
              "voice-bridge: telemetry_record threw",
              err instanceof Error ? err.message : String(err)
            )
        );
      };

      await supabase.from("voice_active_sessions").upsert(
        {
          call_control_id: callControlId,
          business_id: businessId,
          stream_nonce: nonce,
          last_seen_at: new Date().toISOString()
        },
        { onConflict: "call_control_id" }
      );

      // Plan §5 (answer-then-mark race): if Edge crashed between a successful Telnyx answer and
      // `voice_mark_answer_issued`, `answer_issued_at` would be NULL and the 3-min unanswered
      // sweep would release a live reservation. Coalesce it here and flip pending_answer → active.
      // The nonce check above already proves this stream URL was minted post-answer.
      {
        const nowIso = new Date().toISOString();
        const { error: resErr } = await supabase.rpc("voice_bridge_attach_ws", {
          p_call_control_id: callControlId,
          p_now: nowIso
        });
        if (resErr) {
          // Fallback: best-effort direct write if the RPC is not deployed yet.
          console.warn("voice_bridge_attach_ws unavailable, falling back to direct update", resErr.message);
          await supabase
            .from("voice_reservations")
            .update({ ws_connected_at: nowIso, updated_at: nowIso })
            .eq("call_control_id", callControlId);
        }
      }

      // Per-call heartbeat: emit one immediately when the WS upgrade
      // completes, then every 30 s for the duration of the call. Both
      // call writeHeartbeat directly (Bugbot Low: the local `heartbeat`
      // wrapper added no value over the import). writeHeartbeat already
      // swallows rejections internally, so a `void` here is process-safe.
      void writeHeartbeat(supabase, businessId);
      const hb = setInterval(() => {
        void writeHeartbeat(supabase, businessId);
      }, 30_000);

      let geminiTeardown: (() => Promise<void>) | undefined;
      let onTelnyxGemini: ((rawUtf8: string) => void) | undefined;
      let geminiGetLead: (() => CapturedLead) | undefined;
      // Captured at session end for AI-budget metering (Gemini Live path).
      let geminiGetUsage: (() => GeminiLiveUsage | null) | undefined;
      let geminiLiveModel: string | undefined;
      // Set when the Live bridge starts, used to estimate spend from call
      // duration if the session ends without ever reporting usageMetadata.
      let geminiStartedAtMs: number | undefined;

      const geminiFlag = (process.env.GEMINI_LIVE_ENABLED ?? "true").trim().toLowerCase();
      const geminiLiveEnabled = geminiFlag !== "false" && geminiFlag !== "0";
      const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";

      recordDiag("voice_bridge_ws_attached", {
        gemini_live_enabled: geminiLiveEnabled,
        has_api_key: Boolean(apiKey)
      });

      const tenantSettings = await loadTenantTelnyxSettings(supabase, businessId);
      const rollout = await loadVoiceRolloutEnrollment(supabase, businessId);
      const { data: biz } = await supabase
        .from("businesses")
        .select("name, timezone, owner_name, phone, default_customer_language")
        .eq("id", businessId)
        .maybeSingle();
      const businessName = typeof biz?.name === "string" && biz.name.length > 0 ? biz.name : "your business";
      const businessTimezone = typeof biz?.timezone === "string" && biz.timezone.length > 0 ? biz.timezone : null;

      // Owner / team / customer gate, same intent as the SMS worker. Owner
      // numbers are the Safe Mode forward cell, the notification alert phone,
      // and the business's own number. Resolved up front so it can both pick
      // the staff persona and suppress customer-CRM side effects below.
      const { data: notifPrefs } = await supabase
        .from("notification_preferences")
        .select("phone_number")
        .eq("business_id", businessId)
        .maybeSingle();
      const callerIdentity = await resolveCallerIdentity(
        supabase,
        businessId,
        // Trusted (v2-signed) number only, a spoofed v1 caller must never get
        // the staff persona or skip record_customer_interaction.
        trustedFromE164,
        [
          tenantSettings.forwardToE164,
          (notifPrefs as { phone_number?: string | null } | null)?.phone_number,
          (biz as { phone?: string | null } | null)?.phone
        ],
        (biz as { owner_name?: string | null } | null)?.owner_name
      );
      const callerIsStaff = callerIdentity.kind !== "customer";
      if (callerIsStaff) {
        console.log("voice-bridge: caller recognized as staff", {
          callControlId,
          kind: callerIdentity.kind,
          name: callerIdentity.name ?? null
        });
      }

      // HomeLight AI-takeover intake: telnyx-voice-inbound flips the handoff
      // session to status='ai_intake' right before attaching this stream. When
      // that's the case, run the lead-intake persona and remember the notify
      // number so we can text the owner a summary + transcript at call end.
      let intake: IntakeCapability | undefined;
      let intakeNotifyE164 = "";
      // Optional second recipient of the same summary: the lead details go to
      // the agent working it and a copy to the owner.
      let intakeAlsoNotifyE164 = "";
      // The flow's options.starAlerts, snapshotted on the handoff context by
      // the edge at chain start: frame the intake summary in asterisks so it
      // stands out like the rest of this flow's alerts.
      let intakeStarFrame = false;
      // place_ai_call live-transfer config + parked-run link, read off the
      // outbound session context written by telnyx-voice-originate.
      let intakeTransferConfig:
        | { toE164: string; preSmsBody: string; agentName: string }
        | undefined;
      // place_ai_call reach ladder (reachTeammate): parsed from the same
      // session context. Supersedes both transfer capabilities below.
      let intakeReachConfig: ReachLadderConfig | undefined;
      let intakeFlowRun: FlowRunLink | undefined;
      // The step's authored voicemailTemplate, snapshotted on the session by
      // telnyx-voice-originate. Present ONLY when the flow author wrote one, so
      // "no template" still means leave no message: nobody's unapproved copy
      // goes out on a customer's mailbox.
      let intakeVoicemailScript = "";
      // Outbound AiFlow legs are placed by telnyx-voice-originate, which writes
      // the handoff session context with `outbound: true`. Everything else is a
      // customer dialing the DID (inbound). Recorded on the transcript so the
      // dashboard can tag the call.
      let callDirection: "inbound" | "outbound" = "inbound";
      {
        // The edge already flipped the session to ai_intake and pressed 1 for a
        // live seller, so getting this read wrong means Gemini would run the
        // normal receptionist persona (and expose transfer/CRM tools) to that
        // seller. Retry transient failures (throw OR PostgREST error) a few
        // times before giving up, and log loudly if we never resolve it.
        let row: { status?: string; context?: unknown } | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { data: sess, error } = await supabase
              .from("voice_handoff_sessions")
              .select("status, context")
              .eq("call_control_id", callControlId)
              .maybeSingle();
            if (error) throw new Error(error.message);
            row = sess as { status?: string; context?: unknown } | null;
            break;
          } catch (err) {
            if (attempt === 2) {
              console.error(
                "voice-bridge: handoff session lookup failed after retries",
                { callControlId, error: err instanceof Error ? err.message : String(err) }
              );
              recordDiag("voice_bridge_intake_lookup_failed", {
                error: err instanceof Error ? err.message : String(err)
              });
            } else {
              await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            }
          }
        }
        if (row?.status === "ai_intake") {
          const ctx = (row.context ?? {}) as {
            outbound?: boolean;
            ai_takeover?: {
              notify_e164?: string;
              also_notify_e164?: string;
              persona?: string;
              capture_fields?: unknown;
              context_note?: string;
              ivr_gate?: { digit?: string; fallback_ms?: number } | null;
            } | null;
            transfer?: {
              to_e164?: string;
              pre_sms_body?: string;
              agent_name?: string;
            } | null;
            reach_targets?: Record<string, unknown> | null;
            flow_run?: FlowRunLink | null;
            star_alerts?: boolean;
            /**
             * The step's authored voicemailTemplate, snapshotted by
             * telnyx-voice-originate. Absent when the author configured none,
             * which is what keeps unapproved copy off a customer's mailbox.
             */
            voicemail?: { script?: string } | null;
          };
          if (ctx.outbound === true) callDirection = "outbound";
          intakeStarFrame = ctx.star_alerts === true;
          intakeVoicemailScript =
            typeof ctx.voicemail?.script === "string" ? ctx.voicemail.script.trim() : "";
          const ai = ctx.ai_takeover ?? undefined;
          intakeNotifyE164 = typeof ai?.notify_e164 === "string" ? ai.notify_e164 : "";
          intakeAlsoNotifyE164 =
            typeof ai?.also_notify_e164 === "string" ? ai.also_notify_e164.trim() : "";
          // The partner answered us with a recording, not a person: hold the
          // greeting and press the accept digit when the announcement asks.
          const gateDigit =
            typeof ai?.ivr_gate?.digit === "string" ? ai.ivr_gate.digit.trim() : "";
          const gateFallbackMs =
            typeof ai?.ivr_gate?.fallback_ms === "number" && ai.ivr_gate.fallback_ms > 0
              ? ai.ivr_gate.fallback_ms
              : undefined;
          intake = {
            persona: typeof ai?.persona === "string" ? ai.persona : undefined,
            ivrGate: gateDigit
              ? { digit: gateDigit, ...(gateFallbackMs ? { fallbackMs: gateFallbackMs } : {}) }
              : undefined,
            captureFields: Array.isArray(ai?.capture_fields)
              ? (ai!.capture_fields as unknown[]).filter((x): x is string => typeof x === "string")
              : undefined,
            contextNote:
              typeof ai?.context_note === "string" && ai.context_note.trim()
                ? ai.context_note.trim()
                : undefined,
            // Re-read the SAME field the flow's voice_brief step rewrites, so
            // details extracted after the AI picked up reach the live call.
            pollBrief: async () => {
              try {
                const { data, error } = await supabase
                  .from("voice_handoff_sessions")
                  .select("context")
                  .eq("call_control_id", callControlId)
                  .maybeSingle();
                if (error) return "";
                const note = (
                  (data as { context?: { ai_takeover?: { context_note?: unknown } } } | null)
                    ?.context?.ai_takeover?.context_note
                );
                return typeof note === "string" ? note : "";
              } catch {
                return "";
              }
            }
          };
          // place_ai_call live-transfer config: the flow explicitly authorized
          // a mid-call warm transfer (pre-alert SMS + wt: transfer), carried
          // per session, never inferred from tenant settings.
          if (typeof ctx.transfer?.to_e164 === "string" && ctx.transfer.to_e164.trim()) {
            intakeTransferConfig = {
              toE164: ctx.transfer.to_e164.trim(),
              preSmsBody:
                typeof ctx.transfer.pre_sms_body === "string"
                  ? ctx.transfer.pre_sms_body.trim()
                  : "",
              agentName:
                typeof ctx.transfer.agent_name === "string" ? ctx.transfer.agent_name.trim() : ""
            };
            intake.allowTransfer = true;
            intake.transferAgentName = intakeTransferConfig.agentName || undefined;
          }
          if (ctx.reach_targets) {
            const parsed = parseReachLadderConfig(ctx.reach_targets);
            if (parsed) {
              intakeReachConfig = parsed;
              intake.allowTransfer = true;
              intake.transferAgentName = parsed.targets[0]?.name || undefined;
            } else {
              // A ladder that cannot dial must not register the tool: the
              // model would promise a transfer that can only fail.
              console.error("voice-bridge: reach_targets present but unusable", {
                callControlId
              });
            }
          }
          if (ctx.flow_run && typeof ctx.flow_run.run_id === "string") {
            intakeFlowRun = ctx.flow_run;
          }
          console.log("voice-bridge: HomeLight intake mode", {
            callControlId,
            notify: intakeNotifyE164 || null,
            transfer: intakeTransferConfig?.toE164 ?? null
          });
        }
      }

      // DETERMINISTIC VOICEMAIL DELIVERY: outbound leg, authored script, and
      // the AMD resolution sweep armed for this tenant (the sweep or the
      // greeting handler is what will speak and end a leg the bridge mutes).
      // See voicemail-mode.ts for why all three conditions are load-bearing.
      const deterministicVoicemail = deterministicVoicemailArmed({
        direction: callDirection,
        voicemailScript: intakeVoicemailScript,
        amdResolutionEnrolled: rollout.amdResolution
      });
      // The persona names the script's callback number (fabrications happened
      // exactly where the model held none), and the spoken-number guard learns
      // the script's numbers through the same field.
      if (intake && intakeVoicemailScript) {
        intake.voicemailScript = intakeVoicemailScript;
      }

      // Let the assistant hang up when the conversation is over. Available on
      // every call (inbound + outbound) whenever we have a Telnyx API key, the
      // bridge gates the `end_call` tool on this capability being present.
      // Stop this call's media fork without hanging the leg up. Wired
      // unconditionally (not only alongside `transfer`) because translator mode
      // can be entered by staff on a tenant with no transfer target at all, and
      // the interpreter ceiling must be able to detach on that path too.
      const detachMediaApiKey = process.env.TELNYX_API_KEY ?? "";
      const detachMedia = detachMediaApiKey
        ? async (): Promise<{ ok: boolean; detail?: string }> => {
            const result = await telnyxStreamingStop(detachMediaApiKey, callControlId);
            if (!result.ok) {
              console.error(
                "voice-bridge: detachMedia streaming_stop failed",
                result.status,
                result.body
              );
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: detachMedia (streaming_stop)", { callControlId });
            return { ok: true, detail: "streaming stopped" };
          }
        : undefined;

      const hangupApiKey = process.env.TELNYX_API_KEY ?? "";
      const hangup: HangupCapability | undefined = hangupApiKey
        ? {
            graceMs: readPositiveMs("VOICE_END_CALL_GRACE_MS", 3000),
            execute: async ({ reason }) => {
              const result = await telnyxHangupCall(hangupApiKey, callControlId);
              if (!result.ok) {
                console.error("voice-bridge: end_call hangup failed", result.status, result.body);
                return { ok: false, detail: `telnyx ${result.status}` };
              }
              console.log("voice-bridge: end_call hangup", {
                callControlId,
                reason: reason ?? ""
              });
              return { ok: true, detail: "hung up" };
            }
          }
        : undefined;

      /**
       * The assistant's own "this is a recording" verdict, for calls WE placed
       * AND for a partner LIVE TRANSFER (an IVR-gated inbound takeover).
       *
       * Carrier AMD is primary and unreliable: it read Jim Inderberg's mailbox
       * as `human_residence` on 2026-08-17, so nothing stamped the call, the
       * cadence recorded "spoke with them", and the follow-up text that only
       * sends on no-answer was skipped. The assistant heard the mailbox; this
       * is how it says so.
       *
       * On a live transfer carrier AMD is not merely unreliable, it is
       * IMPOSSIBLE. The partner (HomeLight) dials the seller on its own leg
       * and mixes her audio into the inbound call we already answered, so
       * Telnyx sees one inbound leg with nothing to analyse and we never arm
       * detection on it. Measured 2026-08-28 across every HomeLight live
       * transfer on record: 5 of 8 landed in the seller's mailbox (Aug 11,
       * 14, 16, 24, 28), the AI ran on into it for 10, 86, 228, 26 and 51
       * seconds after its first word, and ALL EIGHT carry
       * `answering_machine_result: null` and `voicemail_left: false`.
       *
       * The persona is NOT the gap. It already carries
       * INBOUND_VOICEMAIL_RECOGNITION_LINE and one approved message, and it
       * used them: Aug 24 read that message verbatim and Aug 28 was midway
       * through it when the leg dropped. What was missing is anywhere to PUT
       * the verdict, so a mailbox settled on the record as an ordinary
       * conversation and the owner's alert claimed a capture that never
       * happened. Recognition without a tool also drifts: on Aug 14 the model
       * read a mailbox tone back as a phone number, on Aug 28 it asked a
       * recording for its best callback number.
       *
       * Two effects, in this order:
       *   1. Record the machine verdict on the session AND the call row. The
       *      session stamp is what the hangup path reads to resolve the run's
       *      outcome to no-answer; the transcript field is what the call page's
       *      answering-machine badge shows. Both mirror the edge's stampMachine
       *      exactly, so a call detected here is indistinguishable downstream
       *      from one AMD caught.
       *   2. When the step configured a message, CLAIM the right to leave it
       *      through the same single-winner RPC the edge's own voicemail drop
       *      uses, and hand the script back to be read aloud. Losing the claim
       *      means the edge is already speaking it, so the model stays quiet
       *      rather than talking over a message that is already going out.
       *
       * On a live transfer there is no authored template to read: nothing
       * snapshots a voicemailTemplate onto an inbound session. The tool hands
       * back the persona's own approved message instead of "no script",
       * because "say nothing and end the call" and "leave EXACTLY this one
       * message" cannot both be live in one prompt and the model is told to
       * read whatever it is handed word for word. Same text, one source
       * (`inboundVoicemailScript`); inventing fresh copy for a partner's
       * seller is how [[ai-invents-callback-numbers-on-voicemail]] happens.
       *
       * Sweep interaction, both branches: the stamp carries no
       * `machine_stamped_at` (only the edge's `stampMachine` writes one), so
       * the AMD resolution sweep skips this row as `no_stamp_time` rather
       * than speaking or hanging up behind a live bridge, and winning the
       * claim below sets `voicemail_claimed`, which drops it from the sweep's
       * query outright.
       */
      // Matched to the bridge's own `ivrGate`, which is `opts.dtmf &&
      // intake.ivrGate`, so the tool can never ship on a session whose gate
      // the bridge does not see: that pairing would arm `voicemail_reached`
      // with BOTH the partner-menu carve-out and the pre-accept refusal
      // switched off, which is the one combination that can end a referral
      // mid-menu. `dtmf` is built from the same key, further down.
      const transferGated = Boolean(hangupApiKey) && Boolean(intake?.ivrGate);
      const transferVoicemailScript = transferGated ? inboundVoicemailScript(businessName) : "";
      const voicemail: VoicemailCapability | undefined =
        callDirection === "outbound" || transferGated
          ? {
              execute: async () => {
                // Deterministic mode ages the leg against `machine_stamped_at`
                // (the AMD resolution sweep's clock). The edge's stampMachine
                // writes it exactly once on the AMD webhook; only fill it here
                // when Telnyx never delivered a verdict, and never move an
                // existing clock (a moved clock restarts the 40s grace).
                let stampPatch: Record<string, unknown> = { machine_detected: true };
                if (deterministicVoicemail) {
                  const { data: sessRow } = await supabase
                    .from("voice_handoff_sessions")
                    .select("context")
                    .eq("call_control_id", callControlId)
                    .maybeSingle();
                  const sessCtx = ((sessRow as { context?: unknown } | null)?.context ??
                    {}) as Record<string, unknown>;
                  if (typeof sessCtx.machine_stamped_at !== "string") {
                    stampPatch = {
                      ...stampPatch,
                      machine_stamped_at: new Date().toISOString()
                    };
                  }
                }
                const { error: stampErr } = await supabase.rpc("voice_session_context_merge", {
                  p_call_control_id: callControlId,
                  p_patch: stampPatch
                });
                if (stampErr) {
                  // Without the stamp the run would still resolve "answered",
                  // which is the whole failure this exists to stop. Say so
                  // loudly and leave no message: a lead the cadence believes
                  // was reached AND a voicemail is the worst of both.
                  console.error("voice-bridge: voicemail machine stamp failed", stampErr);
                  return { ok: false, detail: "stamp failed" };
                }
                const { error: badgeErr } = await supabase
                  .from("voice_call_transcripts")
                  .update({ answering_machine_result: "machine" })
                  .eq("call_control_id", callControlId);
                if (badgeErr) {
                  console.error("voice-bridge: voicemail badge write failed", badgeErr);
                }
                // Deterministic mode ends here: NO claim and NO script. The
                // claim is the "I am the one speaking" token, and the speaker
                // in this mode is the edge (greeting.ended handler, else the
                // AMD resolution sweep 25s after the stamp), which claims when
                // it acts. The model's tool winning the claim is exactly what
                // stood the sweep down on call 5e325829 while the model
                // betrayed the read with a fabricated number. Delivery is
                // beep_detected, the uplink beep detector, or the sweep 40s
                // after the stamp.
                if (deterministicVoicemail) {
                  return { ok: true, detail: "machine stamped, platform delivers" };
                }
                // Authored template first, so a flow author who wrote one for
                // an outbound step keeps it; the transfer default only fills
                // the inbound gap, where no template can exist.
                const script = (intakeVoicemailScript || transferVoicemailScript).trim();
                if (!script) return { ok: true, detail: "recorded, no message configured" };
                const { data: claimed, error: claimErr } = await supabase.rpc(
                  "voice_claim_voicemail_speak",
                  { p_call_control_id: callControlId }
                );
                if (claimErr) {
                  console.error("voice-bridge: voicemail claim failed", claimErr);
                  return { ok: true, detail: "recorded, claim unavailable" };
                }
                if (claimed !== true) {
                  return { ok: true, alreadyBeingLeft: true, detail: "message already being left" };
                }
                // `voicemail_spoken` is NOT written here. Winning the claim only
                // means nobody else may speak; the message still has to be read
                // by the model, and the hangup path derives its "voicemail_left"
                // reason from this flag. Stamping now would report a message
                // that a dropped session never delivered. It is written by
                // confirmSpoken instead. The edge path writes it after its own
                // speak succeeds for exactly the same reason.
                return { ok: true, script, detail: "claimed" };
              },
              /**
               * The message was read. Called from the end_call handler the
               * instant the model asks to hang up, which is the only moment
               * both AFTER the script was spoken and BEFORE the line falls
               * silent: a mailbox hangs up on silence, so a stamp scheduled
               * behind the playout grace loses to the mailbox's own hangup and
               * a delivered message reads as never left. Best-effort, and it
               * errs toward understating like the edge path does.
               */
              confirmSpoken: async () => {
                const { error } = await supabase.rpc("voice_session_context_merge", {
                  p_call_control_id: callControlId,
                  p_patch: { voicemail_spoken: true }
                });
                if (error) console.error("voice-bridge: voicemail_spoken stamp failed", error);
                // The call PAGE is a separate write, and on a live transfer
                // nothing else makes it: the edge's decorateTranscriptForVoicemail
                // runs only inside the outbound `flow_run` branch, so an
                // inbound leg would keep `voicemail_left: false` next to a
                // message that really went out. Only the row, never a
                // "[Voicemail]" turn: the edge needs one because its message
                // goes out through Telnyx `speak` after the media stream
                // stops, deaf to the transcriber, while here the model reads
                // the script aloud on the live stream and the turn is already
                // in the transcript.
                if (!transferVoicemailScript) return;
                const { error: rowErr } = await supabase
                  .from("voice_call_transcripts")
                  .update({ answering_machine_result: "machine", voicemail_left: true })
                  .eq("call_control_id", callControlId);
                if (rowErr) console.error("voice-bridge: transfer voicemail row write failed", rowErr);
              },
              /**
               * What the platform currently believes about this leg's machine
               * verdict, for the deterministic hold's poll. "speaking" beats
               * "live" on purpose: once someone holds the voicemail claim the
               * TTS is (about to be) playing, and unmuting the model under it
               * is the double-speak the claim exists to prevent. A failed or
               * empty read is "pending", which keeps the hold: the failsafe
               * window bounds it regardless.
               */
              checkResolution: async () => {
                try {
                  const { data: sessRow, error } = await supabase
                    .from("voice_handoff_sessions")
                    .select("context")
                    .eq("call_control_id", callControlId)
                    .maybeSingle();
                  if (error || !sessRow) return "pending";
                  const ctx = ((sessRow as { context?: unknown }).context ??
                    {}) as Record<string, unknown>;
                  if (
                    ctx.voicemail_claimed === true ||
                    typeof ctx.voicemail_speak_started_at === "string"
                  ) {
                    return "speaking";
                  }
                  // Withdrawal is EXPLICIT: `clearProvisionalMachine` (edge)
                  // writes `machine_detected: false` and `ios_screening:
                  // true`; it never deletes the key. An ABSENT key means the
                  // stamp has not landed yet (this poll can start before the
                  // execute() write on a slow path), and reading that as
                  // "live" would unmute the model at a mailbox and let it
                  // hang up before the sweep speaks, the exact incident the
                  // hold exists to prevent (Bugbot, PR #1742).
                  if (ctx.ios_screening === true || ctx.machine_detected === false) {
                    return "live";
                  }
                  return "pending";
                } catch (err) {
                  console.error("voice-bridge: voicemail resolution check threw", err);
                  return "pending";
                }
              }
            }
          : undefined;

      // Keypad access for the `press_digits` tool. Always provided when we have
      // an API key; the tool is only DECLARED for a session whose context asked
      // for the IVR gate, so no other persona gains a keypad.
      const dtmf: DtmfCapability | undefined = hangupApiKey
        ? {
            execute: async (digits: string) => {
              const result = await telnyxSendDtmf(hangupApiKey, callControlId, digits);
              if (!result.ok) {
                console.error("voice-bridge: send_dtmf failed", result.status, result.body);
                return { ok: false, detail: `telnyx ${result.status}` };
              }
              console.log("voice-bridge: send_dtmf", { callControlId, digits });
              return { ok: true, detail: "pressed" };
            }
          }
        : undefined;

      /** Compose the Gemini tool capability only when admin opted in + a forwarding target exists. */
      let transfer: TransferCapability | undefined;
      if (tenantSettings.transferEnabled && tenantSettings.forwardToE164) {
        const telnyxApiKey = process.env.TELNYX_API_KEY ?? "";
        const forwardE164 = tenantSettings.forwardToE164;
        const fromDid = toE164;
        transfer = {
          toE164: forwardE164,
          execute: async ({ reason }) => {
            if (!telnyxApiKey) {
              console.warn("voice-bridge: transfer requested but TELNYX_API_KEY missing");
              return { ok: false, detail: "transfer not configured" };
            }
            // Tag the transfer's B leg so telnyx-voice-call-end texts the owner
            // (recipient here) the warm-transfer outcome. Plain text; the helper
            // base64-encodes it for Telnyx. Format mirrors encodeWtClientState.
            const notifyCaller = trustedFromE164 || fromE164Info || "";
            const result = await telnyxTransferCall(telnyxApiKey, callControlId, {
              toE164: forwardE164,
              fromE164: fromDid,
              clientState: `wt:${businessId}:${notifyCaller}:${forwardE164}`
            });
            if (!result.ok) {
              console.error("voice-bridge: telnyx transfer failed", result.status, result.body);
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: transfer initiated", {
              callControlId,
              to: forwardE164,
              reason: reason ?? ""
            });
            return { ok: true, detail: "transfer initiated" };
          },
          // Translator mode: the tenant opted in AND telnyx-voice-inbound armed
          // this call's stream at answer time off the same column. Without the
          // answer-time arming the fork reaches only the caller, so staying on
          // would talk over them while the human hears nothing.
          translatorMode: tenantSettings.translatorModeEnabled,
          humanName:
            (typeof (biz as { owner_name?: string | null } | null)?.owner_name === "string"
              ? (biz as { owner_name?: string | null }).owner_name!.trim()
              : "") || undefined,
          // After a successful transfer, remove the AI's media fork so the
          // caller can talk to the human privately. Stops the Telnyx stream
          // (does NOT hang up the caller leg). Best-effort: even if this fails,
          // the bridge still closes the Gemini session so the AI goes silent.
          detach: async () => {
            if (!telnyxApiKey) return { ok: false, detail: "transfer not configured" };
            const result = await telnyxStreamingStop(telnyxApiKey, callControlId);
            if (!result.ok) {
              console.error("voice-bridge: telnyx streaming_stop failed", result.status, result.body);
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: transfer detach (streaming_stop)", { callControlId });
            return { ok: true, detail: "streaming stopped" };
          }
        };
      }

      // place_ai_call live transfer: the flow's per-session transfer config
      // SUPERSEDES the tenant-settings forward target, the flow author picked
      // exactly who this call may be transferred to. Sequence on invoke:
      //   1. pre-alert SMS to the transfer target (Amy's "LIVE TRANSFER is
      //      coming, pick up!"), best-effort so an SMS hiccup never blocks
      //      the actual transfer;
      //   2. Telnyx warm transfer with the same wt: client_state as the
      //      receptionist transfer (so forwarded-human-leg metering and the
      //      warm-transfer outcome notifications work unchanged);
      //   3. stamp `transfer_initiated` on the session (call-end reads it for
      //      the outcome) and resume the parked flow run with "transferred"
      //      immediately, a transferred human conversation can outlive the
      //      run's wait ceiling, so the outcome must not wait for hangup.
      if (intake && intakeTransferConfig) {
        const telnyxApiKey = process.env.TELNYX_API_KEY ?? "";
        const flowTransfer = intakeTransferConfig;
        const fromDid = toE164;
        transfer = {
          toE164: flowTransfer.toE164,
          execute: async ({ reason }) => {
            if (!telnyxApiKey) {
              console.warn("voice-bridge: flow transfer requested but TELNYX_API_KEY missing");
              return { ok: false, detail: "transfer not configured" };
            }
            if (flowTransfer.preSmsBody) {
              await sendTransferPreAlertSms({
                supabase,
                businessId,
                settings: tenantSettings,
                toE164: flowTransfer.toE164,
                body: flowTransfer.preSmsBody,
                callControlId
              });
            }
            const notifyCaller = trustedFromE164 || fromE164Info || "";
            const result = await telnyxTransferCall(telnyxApiKey, callControlId, {
              toE164: flowTransfer.toE164,
              fromE164: fromDid,
              clientState: `wt:${businessId}:${notifyCaller}:${flowTransfer.toE164}`
            });
            if (!result.ok) {
              console.error(
                "voice-bridge: flow transfer failed",
                result.status,
                result.body
              );
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: flow live transfer initiated", {
              callControlId,
              to: flowTransfer.toE164,
              reason: reason ?? ""
            });
            // Outcome bookkeeping AFTER the transfer succeeded. Best-effort:
            // call-end's hangup handler re-derives "transferred" from the
            // session stamp, and the timeout sweep backstops both.
            await stampTransferInitiated(supabase, callControlId);
            if (intakeFlowRun) {
              await resumeFlowRunWithCallOutcome(supabase, intakeFlowRun, "transferred");
            }
            return { ok: true, detail: "transfer initiated" };
          },
          // Same tenant opt-in as the receptionist transfer above. This
          // capability REPLACES that one on a flow-driven call, so without this
          // line the toggle would silently not apply to a tenant's main voice
          // flow. Every site that attaches a bridge stream arms off the same
          // column, so the fork can reach both legs here too.
          translatorMode: tenantSettings.translatorModeEnabled,
          humanName: flowTransfer.agentName || undefined,
          detach: async () => {
            if (!telnyxApiKey) return { ok: false, detail: "transfer not configured" };
            const result = await telnyxStreamingStop(telnyxApiKey, callControlId);
            if (!result.ok) {
              console.error(
                "voice-bridge: telnyx streaming_stop failed",
                result.status,
                result.body
              );
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: flow transfer detach (streaming_stop)", { callControlId });
            return { ok: true, detail: "streaming stopped" };
          }
        };
      }

      // reach_teammate: the second-leg warm-transfer ladder. SUPERSEDES both
      // transfer capabilities above (the flow author picked the ladder, so
      // neither the tenant forward target nor a single-target transfer
      // applies). The model still calls the same `transfer_to_owner` tool;
      // what changes is the topology underneath: the caller stays on the A
      // leg with the assistant while each teammate's phone rings on a fresh
      // B leg, and only a teammate who genuinely ANSWERS is bridged in. The
      // pre-alert SMS goes out per target as their phone starts ringing, so
      // when nobody answers, the assistant's "I've let the team know" line
      // is already true.
      if (intake && intakeReachConfig) {
        const telnyxApiKey = process.env.TELNYX_API_KEY ?? "";
        const reachConfig = intakeReachConfig;
        transfer = {
          toE164: reachConfig.targets[0]!.e164,
          execute: async ({ reason }) => {
            if (!telnyxApiKey) {
              console.warn("voice-bridge: reach requested but TELNYX_API_KEY missing");
              return { ok: false, detail: "transfer not configured" };
            }
            const result = await runReachLadder(
              supabase,
              {
                dial: (opts) => telnyxDialCall(telnyxApiKey, opts),
                bridge: (leg, opts) => telnyxBridgeCall(telnyxApiKey, leg, opts),
                hangup: (leg) => telnyxHangupCall(telnyxApiKey, leg),
                sendPreSms: async (toE164, body) => {
                  await sendTransferPreAlertSms({
                    supabase,
                    businessId,
                    settings: tenantSettings,
                    toE164,
                    body,
                    callControlId
                  });
                }
              },
              {
                businessId,
                aLegCallControlId: callControlId,
                config: reachConfig,
                log: (msg, extra) => console.log(`voice-bridge: ${msg}`, extra ?? {}),
                // B-leg dial refusals become queryable telemetry_events rows
                // instead of stdout-only lines (a Telnyx capacity 403 on
                // every rung used to read as "nobody answered").
                telemetry: recordDiag
              }
            );
            if (!result.ok) {
              console.log("voice-bridge: reach ladder exhausted", {
                callControlId,
                reason: reason ?? "",
                detail: result.detail
              });
              if (result.detail === "dials_refused") {
                // Every dial was refused before a phone rang (for example a
                // carrier channel-limit 403 on each rung): nobody was rung
                // and no pre-alert went out, so the model must not blame
                // the team for missing a call that never reached them.
                return {
                  ok: false,
                  detail:
                    "could not reach the team's phone lines just now; nobody was actually rung, so offer to take a message or try again shortly"
                };
              }
              // The honest failure the persona's script depends on: the
              // model tells the caller nobody could pick up right now and
              // that the team has been texted (pre-alerts went out with
              // each dial that actually rang).
              return { ok: false, detail: "nobody answered; the team was texted the heads-up" };
            }
            console.log("voice-bridge: reach ladder bridged", {
              callControlId,
              connected: result.connectedName,
              reason: reason ?? ""
            });
            // Same outcome bookkeeping as the single-target flow transfer:
            // stamp the session and resume the parked run NOW, because a
            // bridged human conversation can outlive the run's wait ceiling.
            await stampTransferInitiated(supabase, callControlId);
            if (intakeFlowRun) {
              await resumeFlowRunWithCallOutcome(supabase, intakeFlowRun, "transferred");
            }
            return { ok: true, detail: `connected to ${result.connectedName}` };
          },
          translatorMode: tenantSettings.translatorModeEnabled,
          humanName: reachConfig.targets[0]?.name || undefined,
          detach: async () => {
            if (!telnyxApiKey) return { ok: false, detail: "transfer not configured" };
            const result = await telnyxStreamingStop(telnyxApiKey, callControlId);
            if (!result.ok) {
              console.error(
                "voice-bridge: telnyx streaming_stop failed",
                result.status,
                result.body
              );
              return { ok: false, detail: `telnyx ${result.status}` };
            }
            console.log("voice-bridge: reach detach (streaming_stop)", { callControlId });
            return { ok: true, detail: "streaming stopped" };
          }
        };
      }

      if (geminiLiveEnabled && apiKey) {
        try {
          const envSessionMaxMs = readPositiveMs("GEMINI_LIVE_SESSION_MAX_MS", 14 * 60 * 1000);
          // Shorten the session when the shared AI budget is nearly gone (mid-call
          // half of the hard stop). budgetCapped drives the bridge's wind-down
          // wording ("the owner isn't available right now" vs the normal time cap).
          const sessionMaxMs = await computeBudgetDerivedSessionMaxMs(
            supabase,
            businessId,
            callControlId,
            envSessionMaxMs
          );
          const budgetCapped = sessionMaxMs < envSessionMaxMs;
          if (budgetCapped) {
            console.log("voice-bridge: session shortened by AI budget", {
              callControlId,
              envSessionMaxMs,
              sessionMaxMs
            });
          }
          const warnBeforeMs = readPositiveMs("GEMINI_LIVE_SESSION_WARN_BEFORE_MS", 60 * 1000);
          const finalNudgeBeforeMs = readPositiveMs("GEMINI_LIVE_SESSION_FINAL_NUDGE_MS", 15 * 1000);
          const model = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";

          // Prime Gemini's system instruction with the Rowboat vault so
          // identity/tone/long-term memory/website knowledge is already in
          // context when the greeting fires. A missing vault directory is
          // logged but never fatal, the bridge still works with a generic
          // receptionist persona.
          const vault = await loadVaultForPrompt().catch((err) => {
            console.warn("voice-bridge: vault load failed; proceeding without priming", err);
            return undefined;
          });
          if (vault) {
            console.log("voice-bridge: vault primed", {
              files: vault.presentFiles,
              chars: vault.totalChars
            });
          }

          const appBaseUrl = process.env.APP_BASE_URL ?? "";
          const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
          const voiceTools =
            appBaseUrl && gatewayToken
              ? {
                  appBaseUrl,
                  gatewayToken,
                  callControlId,
                  // Trusted number only: voice tools (and the interaction
                  // write-through they feed) must not act on a spoofed v1 caller.
                  callerE164: trustedFromE164
                }
              : undefined;

          // Transcription is behind a per-VPS flag so rollout can be staged.
          // Default off for one release; setting it to "true" (any casing)
          // enables inputAudioTranscription + outputAudioTranscription on the
          // Live session and persists turn rows.
          // HomeLight intake calls always need the transcript (we text it to
          // the owner), so force it on for those regardless of the rollout flag.
          const transcriptionEnabled =
            Boolean(intake) ||
            (process.env.VOICE_TRANSCRIPTION_ENABLED ?? "").toLowerCase() === "true";
          const transcriptAdapter = transcriptionEnabled
            ? createSupabaseTranscriptAdapter(supabase, {
                // Intake leads aren't existing customers and shouldn't bump a
                // customer_memories row for HomeLight's transfer line.
                recordCustomerInteraction: !callerIsStaff && !intake
              })
            : undefined;

          // Phase 3b: cross-channel customer memory read. If we recognize
          // this caller from prior SMS or voice interactions, pull the
          // rolling summary so Gemini Live can pick up where the last
          // conversation left off. Failure is non-fatal, first-time
          // callers (no row) and DB hiccups both fall back to the
          // vault-only prompt that voice has always used.
          //
          // The customer_memories table was added in
          // supabase/migrations/20260507000000_customer_memories.sql.
          // On VPS instances whose Supabase still predates that
          // migration, the call returns a 4xx error which we swallow,
          // again, a degraded prompt is acceptable, a refused call is
          // not.
          let customerMemorySummary: string | undefined;
          // Staff (owner/team) are not customers, don't pull a customer
          // continuity note for them (mirrors the SMS gate not treating them
          // as a customer profile).
          // trustedFromE164 (not fromE164Info): never surface another contact's
          // rolling summary off a spoofed, unsigned v1 caller number (#268).
          if (trustedFromE164 && !callerIsStaff) {
            try {
              // Alias-aware: a number merged into another profile
              // (alias_e164s) resolves to the surviving row. On a Supabase
              // predating the merge migration this errors like a missing
              // table would, swallowed below, degraded prompt.
              const { data: memRow } = await supabase
                .from("contacts")
                .select("summary_md, pinned_md, display_name, total_interaction_count")
                .eq("business_id", businessId)
                .or(`customer_e164.eq.${trustedFromE164},alias_e164s.cs.{${trustedFromE164}}`)
                .maybeSingle();
              if (memRow) {
                const segments: string[] = [];
                const name = (memRow as { display_name?: string | null }).display_name?.trim();
                if (name) segments.push(`Caller: ${name}`);
                const total = (memRow as { total_interaction_count?: number }).total_interaction_count ?? 0;
                if (total > 0) {
                  segments.push(`Prior interactions with this business: ${total}.`);
                }
                const pinned = (memRow as { pinned_md?: string | null }).pinned_md?.trim();
                if (pinned) segments.push(`Owner-pinned notes: ${pinned}`);
                const summary = (memRow as { summary_md?: string | null }).summary_md?.trim();
                if (summary) segments.push(summary);
                customerMemorySummary = segments.length > 0 ? segments.join("\n") : undefined;
              }
            } catch (memErr) {
              console.warn("voice-bridge: customer_memories lookup failed (non-fatal)", {
                callControlId,
                error: memErr instanceof Error ? memErr.message : String(memErr)
              });
            }
          }

          // AiFlow context bridge (voice twin of the SMS worker's block): a
          // lead an automation recently texted may CALL instead of texting
          // back, without this the receptionist restarts intake on a caller
          // whose details the workflow already collected. Best-effort: null
          // on any failure (loadVoiceFlowContext never throws), degraded
          // prompt, never a refused call. Staff callers are skipped for the
          // same reason as the memory note.
          let flowContextNote: string | undefined;
          if (trustedFromE164 && !callerIsStaff) {
            flowContextNote =
              (await loadVoiceFlowContext(supabase, businessId, trustedFromE164)) ?? undefined;
          }

          // Cross-channel recent-interactions timeline (contact-context.ts):
          // the caller's raw SMS thread + recent call summaries from the last
          // hours. Mid-first-conversation the rolling summary above is still
          // EMPTY (the summarize sweep runs later), a lead who was texting
          // minutes ago and now calls would otherwise reach a receptionist
          // with no idea the exchange happened (the voice twin of the
          // 2026-07-14 Truly SMS incident). Same best-effort/staff gates.
          let recentInteractionsNote: string | undefined;
          if (trustedFromE164 && !callerIsStaff) {
            recentInteractionsNote =
              (await loadVoiceContactTimeline(supabase, businessId, trustedFromE164)) ??
              undefined;
          }

          // Booking-status line (booking-context.ts): the caller's live
          // Calendly state, fetched from the platform with this box's own
          // gateway bearer. Same trusted-number + staff gates; fail-open,
          // a platform hiccup only costs the line, never the call.
          let bookingStatusNote: string | undefined;
          if (trustedFromE164 && !callerIsStaff) {
            const bookingLine = await loadVoiceBookingLine({
              appBaseUrl: process.env.APP_BASE_URL,
              gatewayToken: process.env.ROWBOAT_GATEWAY_TOKEN,
              businessId,
              phone: trustedFromE164
            });
            if (bookingLine) bookingStatusNote = `Booking status: ${bookingLine}`;
          }

          // Language: the caller's stored preference, else the tenant default.
          // Every other channel already reads these two columns; voice used to
          // hardcode English, so a Spanish-speaking caller was greeted in the
          // wrong language on every call. Best-effort by contract: a failed
          // contact read degrades to the tenant default, never a refused call.
          // Settings → Coworker tools for the bridge-local translator tool.
          // HTTP-proxied voice tools are gated app-side by
          // agentToolDisabledResponse; a bridge-local one has no such
          // chokepoint, so read the owner's row here or the toggle would be
          // decoration. Only staff callers can reach the tool at all, so skip
          // the read entirely for a customer call.
          // Tier first: the tool toggle is an owner preference, not an
          // entitlement, and #1028 gated only the post-transfer path. Reuses
          // the tier read loadTenantTelnyxSettings already did.
          const translatorOnRequestEnabled = callerIsStaff && tenantSettings.translatorTierAllowed
            ? await isBridgeToolEnabled(supabase, {
                businessId,
                agentKey: "voice",
                toolKey: "start_translator_mode",
                // Registry default for this tool (src/lib/agent-tools/registry.ts).
                defaultEnabled: true
              })
            : false;

          const languagePrefs = resolveVoiceLanguagePrefs({
            contactPreferredLanguage: trustedFromE164
              ? await loadContactPreferredLanguage(supabase, businessId, trustedFromE164)
              : null,
            businessDefaultLanguage: (biz as { default_customer_language?: string | null } | null)
              ?.default_customer_language
          });

          // SPOKEN-NUMBER FIREWALL seeds: every number the model could
          // legitimately speak that does NOT already ride the system
          // instruction or a tool response. The guard fails toward allowing
          // (an unseeded legitimate number would be cut as fabricated, the
          // one failure the guard must never have), so this list leans wide:
          // party numbers, configured business numbers, transfer and reach
          // targets, and the authored voicemail script's text.
          const numberGuardOpts = rollout.numberGuard
            ? {
                seedTexts: [
                  intakeVoicemailScript,
                  intake?.persona ?? "",
                  intake?.contextNote ?? ""
                ],
                seedNumbers: [
                  trustedFromE164,
                  fromE164Info,
                  tenantSettings.forwardToE164,
                  tenantSettings.smsFromE164,
                  (notifPrefs as { phone_number?: string | null } | null)?.phone_number,
                  (biz as { phone?: string | null } | null)?.phone,
                  intakeNotifyE164,
                  intakeAlsoNotifyE164,
                  intakeTransferConfig?.toE164,
                  intakeReachConfig?.fromE164,
                  ...(intakeReachConfig?.targets.map((t) => t.e164) ?? [])
                ],
                // Best-effort context record so the daily call-integrity sweep
                // reports a cut number as BLOCKED instead of paging a human
                // about audio nobody heard. Inbound receptionist calls may
                // have no handoff session row; the merge failing is fine, the
                // suppression diag and telemetry still carry the event.
                recordSuppressed: async (numbers: string[]) => {
                  const { error } = await supabase.rpc("voice_session_context_merge", {
                    p_call_control_id: callControlId,
                    p_patch: { suppressed_spoken_numbers: numbers }
                  });
                  if (error) {
                    console.error("voice-bridge: suppressed-number record failed", error);
                  }
                }
              }
            : undefined;

          const bridge = await createGeminiTelnyxBridge({
            ws,
            businessId,
            callControlId,
            apiKey,
            model,
            sessionMaxMs,
            budgetCapped,
            warnBeforeMs,
            finalNudgeBeforeMs,
            businessName,
            businessTimezone,
            transfer,
            hangup,
            voicemail,
            dtmf,
            detachMedia,
            direction: callDirection,
            vault,
            // Trusted number only: this flows into the transcript's caller_e164
            // and record_customer_interaction. A spoofed v1 caller resolves to
            // "" → no interaction is written against another contact (#268).
            callerE164: trustedFromE164,
            voiceTools,
            transcriptAdapter,
            customerMemorySummary,
            flowContextNote,
            recentInteractionsNote,
            bookingStatusNote,
            languagePrefs,
            // Per-tenant voice, resolved in the bridge against the box env and
            // the platform default. Read per call, so an admin change lands on
            // the next call with no redeploy.
            tenantVoiceName: tenantSettings.voiceName,
            translatorOnRequestEnabled,
            callerIdentity,
            intake,
            recordDiag,
            numberGuard: numberGuardOpts,
            deterministicVoicemail,
            onBeepDetected:
              deterministicVoicemail && hangupApiKey
                ? async ({ detectedAtMs, speak }) => {
                    let offsetMs: number | null = null;
                    try {
                      const { data: sessRow } = await supabase
                        .from("voice_handoff_sessions")
                        .select("context")
                        .eq("call_control_id", callControlId)
                        .maybeSingle();
                      const ctx = ((sessRow as { context?: unknown } | null)?.context ??
                        {}) as Record<string, unknown>;
                      if (typeof ctx.machine_stamped_at === "string") {
                        const stamped = Date.parse(ctx.machine_stamped_at);
                        if (Number.isFinite(stamped)) offsetMs = detectedAtMs - stamped;
                      }
                    } catch (err) {
                      console.error("voice-bridge: beep stamp read failed", err);
                    }
                    recordDiag("voice_bridge_beep_detected", { offset_ms: offsetMs, speak });
                    if (!speak) return;
                    const outcome = await speakVoicemailOnBridge(
                      {
                        rpc: (fn, args) => supabase.rpc(fn, args),
                        apiKey: hangupApiKey,
                        fetchImpl: fetch,
                        nowIso: () => new Date().toISOString()
                      },
                      callControlId,
                      intakeVoicemailScript,
                      { trigger: "bridge_beep" }
                    );
                    recordDiag("voice_bridge_beep_speak", { outcome });
                  }
                : undefined
          });
          onTelnyxGemini = bridge.onTelnyxMessage;
          geminiTeardown = bridge.teardown;
          geminiGetLead = bridge.getLead;
          geminiGetUsage = bridge.getUsage;
          geminiLiveModel = model;
          geminiStartedAtMs = Date.now();
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error("voice-bridge: Gemini Live unavailable (continuing without AI audio)", reason);
          recordDiag("voice_bridge_gemini_init_failed", { reason });
          // For a HomeLight ai_intake call the missed-call SMS would text the
          // tenant's forward number and label the caller as HomeLight's transfer
          // line, wrong recipient and wrong story for a connected live seller.
          // Skip it; the no-lead intake SMS below still notifies the intake owner.
          if (!intake) {
            await sendMissedCallSms({
              supabase,
              businessId,
              settings: tenantSettings,
              callerE164: fromE164Info || "unknown",
              businessName,
              reason: `Gemini Live init failed: ${reason}`
            });
          }
        }
      } else if (!geminiLiveEnabled) {
        console.warn("voice-bridge: GEMINI_LIVE_ENABLED=false; AI audio pipe disabled (media stream still accepted)");
        if (!intake) {
          await sendMissedCallSms({
            supabase,
            businessId,
            settings: tenantSettings,
            callerE164: fromE164Info || "unknown",
            businessName,
            reason: "AI audio disabled (flag off)"
          });
        }
      } else {
        console.warn("voice-bridge: GOOGLE_API_KEY or GEMINI_API_KEY unset; AI audio pipe disabled");
        if (!intake) {
          await sendMissedCallSms({
            supabase,
            businessId,
            settings: tenantSettings,
            callerE164: fromE164Info || "unknown",
            businessName,
            reason: "AI audio disabled (no API key)"
          });
        }
      }

      let lastLastSeenWriteMs = Date.now();
      ws.on("message", (data: RawData) => {
        const rawUtf8 = rawDataToUtf8(data);
        onTelnyxGemini?.(rawUtf8);

        const now = Date.now();
        if (now - lastLastSeenWriteMs < LAST_SEEN_UPDATE_INTERVAL_MS) return;
        lastLastSeenWriteMs = now;
        void supabase
          .from("voice_active_sessions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("call_control_id", callControlId);
      });

      ws.on("error", (err: Error) => {
        // Telnyx-side WS errors were previously swallowed by the default
        // event handler, surface them so we can correlate them with
        // "ring then silence" reports.
        console.error("voice-bridge: telnyx ws error", {
          callControlId,
          message: err.message
        });
      });

      ws.on("close", (code: number, reason: Buffer) => {
        console.log("voice-bridge: telnyx ws close", {
          callControlId,
          code,
          reason: reason?.toString?.("utf8") ?? ""
        });
        recordDiag("voice_bridge_ws_close", {
          code,
          reason: reason?.toString?.("utf8") ?? ""
        });
        clearInterval(hb);
        const endedAt = new Date().toISOString();
        void (async () => {
          // Finalize the Gemini session/transcript first. For HomeLight intake
          // we then text the owner the captured lead + transcript, which needs
          // the transcript rows flushed (finalize awaits its in-flight writes).
          try {
            await geminiTeardown?.();
          } catch (err) {
            console.error("voice-bridge: teardown error", err);
          }
          // Meter this Live session's Gemini spend into the shared AI budget.
          // Done after teardown so `getUsage()` returns the final cumulative
          // frame. Prefer the EXACT usageMetadata; if the session closed without
          // ever reporting billable tokens, fall back to a conservative
          // duration-based estimate so spend still advances (Google bills the
          // audio regardless, a skipped POST would let the budget gates keep
          // allowing voice on an exhausted pool). Best-effort, never blocks
          // reservation settle.
          try {
            if (geminiLiveModel) {
              const captured = geminiGetUsage?.() ?? null;
              const durationEstimate = estimateLiveUsageFromDuration(
                geminiStartedAtMs,
                Date.now()
              );
              // Meter whichever implies MORE spend (never undercount). A sparse or
              // early cumulative usageMetadata frame can under-report a long call
              // (e.g. only a small promptTokenCount was ever seen), so when the
              // duration-based floor is larger we use it instead. Compare by a
              // Live-audio cost proxy (input ≈ $3/1M, output ≈ $12/1M).
              const liveCostProxy = (u: GeminiLiveUsage | null): number =>
                u ? u.promptTokens * 3 + u.outputTokens * 12 : 0;
              const useCaptured =
                liveCostProxy(captured) >= liveCostProxy(durationEstimate);
              const usage = useCaptured ? captured : durationEstimate;
              // A truthy-but-zero usage (session opened, no tokens billed) must
              // still RELEASE the hold, meterGeminiLiveSpend skips the settle
              // POST when there's nothing billable, so route the zero case
              // straight to release rather than leaving the hold to expire.
              const hasBillable =
                !!usage && (usage.promptTokens > 0 || usage.outputTokens > 0);
              if (hasBillable) {
                // Settles the reservation (release hold + record exact spend).
                await meterGeminiLiveSpend({
                  businessId,
                  model: geminiLiveModel,
                  usage: usage as GeminiLiveUsage,
                  callControlId
                });
              } else {
                await releaseAiBudgetReservation(supabase, callControlId);
              }
            } else {
              // Bridge never started (init failed / disabled): free the hold the
              // inbound gate placed so it can't pin budget until it expires.
              await releaseAiBudgetReservation(supabase, callControlId);
            }
          } catch (err) {
            console.error("voice-bridge: meter Gemini Live spend error", err);
          }
          // What the AI got out of the person itself. On a referral line the
          // partner withholds the seller's number until after this call, so the
          // conversation is frequently the ONLY source for it. Persist it on the
          // session so a flow parked on `wait_for_call` can hydrate its vars and
          // run the whole follow-up (contact record, QT email, agent hand-off)
          // even when the portal never releases anything.
          //
          // Written BEFORE the resume below so the worker never reads a session
          // that has not been filled in yet.
          //
          // The same read also feeds the finished-call alert below: the LIVE
          // context note (voice_brief rewrites land there mid-call) and the
          // voicemail stamps. A failed read degrades to an unenriched alert.
          let alertCtx: IntakeAlertContext = {
            machineDetected: false,
            voicemailSpoken: false,
            voicemailBeingLeft: false
          };
          if (intake) {
            try {
              // Re-read rather than reuse the context parsed at attach. Two
              // things change DURING the call: a voice_brief step appends to the
              // note, and a `wait_for_call` step stamps `flow_run` when it parks
              // (about a minute in). The link read at attach is therefore null
              // for exactly the calls this feature exists for.
              const { data: liveRow } = await supabase
                .from("voice_handoff_sessions")
                .select("context")
                .eq("call_control_id", callControlId)
                .maybeSingle();
              const liveCtx = ((liveRow as { context?: Record<string, unknown> } | null)
                ?.context ?? {}) as Record<string, unknown>;
              alertCtx = extractIntakeAlertContext(liveCtx);
              const liveAi = (liveCtx.ai_takeover ?? {}) as Record<string, unknown>;
              const captured = geminiGetLead ? geminiGetLead() : null;
              if (captured && Object.keys(captured).length > 0) {
                await supabase
                  .from("voice_handoff_sessions")
                  .update({
                    context: {
                      ...liveCtx,
                      ai_takeover: { ...liveAi, captured }
                    }
                  })
                  .eq("call_control_id", callControlId);
              }
              // Release a flow parked on this call, using the link as it stands
              // NOW. Ordered after the write above so the worker can never wake
              // to a session whose captured fields have not landed yet, this is
              // why the bridge owns the resume and the call-end webhook does not
              // (the overdue sweep is the backstop for a bridge that dies here).
              const liveLink = (liveCtx.flow_run ?? null) as FlowRunLink | null;
              if (liveLink && callDirection === "inbound") {
                await resumeFlowRunWithCallOutcome(supabase, liveLink, "answered");
              }
            } catch (err) {
              console.error("voice-bridge: persist captured lead / resume failed", err);
            }
          }
          // Only notify when the Gemini bridge actually ran (geminiGetLead is
          // set on successful bridge init). If Gemini never started (init
          // failure / disabled / no key) we must NOT text the owner a phantom
          // "lead" with no captured fields and no transcript.
          if (intake && intakeNotifyE164 && geminiGetLead) {
            // Direction decides what the remote number means. Inbound: the ANI
            // is the transfer partner's line, "Transferred via" only. Outbound:
            // the platform dialed the LEAD, so that number goes on the Lead
            // line and the CRM contact row for it (name, email, lead source)
            // rides along. The lookup keys on the SIGNED caller only, matching
            // the trust rule the persona/memory paths follow (issue #268); the
            // unsigned value still renders as a number, just without a lookup.
            const outboundLeadE164 =
              callDirection === "outbound" ? trustedFromE164 || fromE164Info || "" : "";
            const known =
              callDirection === "outbound" && trustedFromE164
                ? await lookupIntakeKnownLead(supabase, businessId, trustedFromE164)
                : undefined;
            // The details go to whoever works the lead, and (when configured) a
            // copy to the owner. Deduped so one number never gets it twice, and
            // sent in sequence so the primary recipient is never starved by a
            // failure on the copy.
            const recipients = [
              intakeNotifyE164,
              ...(intakeAlsoNotifyE164 && intakeAlsoNotifyE164 !== intakeNotifyE164
                ? [intakeAlsoNotifyE164]
                : [])
            ];
            for (const notifyE164 of recipients) {
              try {
                await sendIntakeLeadSms({
                  supabase,
                  businessId,
                  settings: tenantSettings,
                  notifyE164,
                  callControlId,
                  // The ANI is the transfer partner's line (e.g. HomeLight), not
                  // the seller, so pass it only as the "transferred via"
                  // reference, and only for the inbound direction it describes.
                  transferFromE164:
                    callDirection === "inbound" ? trustedFromE164 || fromE164Info || "" : "",
                  businessName,
                  lead: geminiGetLead(),
                  starFrame: intakeStarFrame,
                  callDirection,
                  leadE164: outboundLeadE164,
                  known,
                  // Prefer the live note (voice_brief may have rewritten it
                  // mid-call); fall back to the attach-time copy.
                  flowContextNote: alertCtx.contextNote ?? intake.contextNote ?? "",
                  voicemail: {
                    detected: alertCtx.machineDetected,
                    messageLeft: alertCtx.voicemailSpoken,
                    messageBeingLeft: alertCtx.voicemailBeingLeft
                  }
                });
              } catch (err) {
                console.error("voice-bridge: intake SMS error", err, { notifyE164 });
              }
            }
          }
          await supabase
            .from("voice_active_sessions")
            .update({ ended_at: endedAt })
            .eq("call_control_id", callControlId);
          const { error: settleErr } = await supabase.rpc("voice_record_bridge_media_end", {
            p_call_control_id: callControlId
          });
          if (settleErr) {
            console.error("voice_record_bridge_media_end", callControlId, settleErr.message);
          }
        })();
      });
    });
    })();
  });

  server.listen(PORT, () => {
    console.log(`voice-bridge listening :${PORT} (HTTP + WS /voice/stream)`);
  });

  // Graceful shutdown: drain active WebSockets and stop accepting new upgrades so
  // SIGTERM from `docker stop` / orchestrator rollouts doesn't sever live calls with
  // no chance to settle. We close the HTTP server first (stops new connections), then
  // send a 1012 "Service Restart" close frame to each live WS so Telnyx hangs up
  // cleanly; the `ws.on("close", ...)` handler runs per-socket and flushes
  // voice_record_bridge_media_end. If clients don't close within the timeout we
  // force-terminate them to avoid an unbounded shutdown.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`voice-bridge: ${signal} received; draining WebSockets…`);

    server.close(() => {
      console.log("voice-bridge: HTTP server closed");
    });

    for (const client of wss.clients) {
      try {
        client.close(1012, "server_shutdown");
      } catch (err) {
        console.warn("voice-bridge: error closing client", err);
      }
    }

    const forceExitMs = 10_000;
    const forceTimer = setTimeout(() => {
      console.warn("voice-bridge: forcing exit after drain timeout");
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      process.exit(0);
    }, forceExitMs);
    forceTimer.unref?.();

    wss.close(() => {
      clearTimeout(forceTimer);
      console.log("voice-bridge: WebSocket server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
