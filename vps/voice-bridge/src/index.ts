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
  type CallerIdentity,
  type CapturedLead,
  type IntakeCapability,
  type GeminiLiveUsage
} from "./gemini-telnyx-bridge.js";
import { loadVaultForPrompt } from "./vault-loader.js";
import {
  telnyxTransferCall,
  telnyxSendPlainSms,
  telnyxHangupCall,
  telnyxStreamingStop
} from "./telnyx-call-actions.js";
import { composeIntakeLeadSms } from "./intake.js";
import type { TranscriptAdapter } from "./voice-transcript.js";
import { startIdleHeartbeatLoop, writeHeartbeat } from "./heartbeat.js";

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
// telnyx-voice-inbound) use — hardcoding $5/$10 here would desync voice from an
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
 * AI budget (`owner_chat_model_spend` vs the $5/$10 tier cap + purchased credit)
 * so a single long call can't blow the whole pool. This is the mid-call half of
 * the hard stop: the pre-call gate in telnyx-voice-inbound already refuses when
 * the pool is fully exhausted; this shortens the session when only a little
 * budget is left, and the bridge's graceful wind-down (with budget wording)
 * closes the call before it overspends.
 *
 * Combined two-way audio costs ~0.375 micro-USD/ms (25 tok/s each way at the
 * $3-in/$12-out audio rates), intentionally CONSERVATIVE — overestimating cost
 * yields a shorter cap, never a longer one. Fails OPEN: any read error returns
 * `envMaxMs` (never shorten a call over a DB blip), and the result is clamped to
 * a small floor so we never answer-then-immediately-hang-up.
 */
async function computeBudgetDerivedSessionMaxMs(
  supabase: SupabaseClient,
  businessId: string,
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
    if (subStart) periodStart = subStart;

    const { data: spendRow } = await supabase
      .from("owner_chat_model_spend")
      .select("spend_micros")
      .eq("business_id", businessId)
      .eq("period_start", periodStart)
      .maybeSingle();
    const spent = Number(
      (spendRow as { spend_micros?: number | string } | null)?.spend_micros ?? 0
    );

    let creditMicros = 0;
    const { data: creditRaw, error: creditErr } = await supabase.rpc("chat_active_credit_micros", {
      p_business_id: businessId
    });
    if (!creditErr) {
      const n = Number(creditRaw ?? 0);
      if (Number.isFinite(n) && n > 0) creditMicros = n;
    }

    const remainingMicros = baseCapMicros + creditMicros - spent;
    if (!Number.isFinite(remainingMicros) || remainingMicros <= 0) {
      // The pre-call gate refuses an over-budget call, but clamp to the floor
      // (not 0) rather than trust a racy read to zero out the session.
      return Math.min(envMaxMs, minMs);
    }
    // The pre-call gate refuses whenever remaining budget is below one
    // min-session's cost (it subtracts that same margin from the cap), so an
    // answered call almost always has budgetMs >= minMs and the floor is not the
    // binding limit. The `Math.max(minMs, …)` here only covers the small race
    // window where spend advanced between the gate read and this read; it caps
    // any resulting overspend at ~one min-session rather than hanging up instantly.
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
 * never a customer. Best-effort — any DB hiccup degrades to "customer" so a
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
    // Leave name unset when owner_name is blank (don't fabricate "the owner" —
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
};

/**
 * Supabase-backed `TranscriptAdapter`. Writes are direct (service-role) —
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
  const { data } = await supabase
    .from("business_telnyx_settings")
    .select(
      "forward_to_e164, transfer_enabled, sms_fallback_enabled, telnyx_sms_from_e164, telnyx_messaging_profile_id"
    )
    .eq("business_id", businessId)
    .maybeSingle();
  const row = (data ?? null) as null | {
    forward_to_e164: string | null;
    transfer_enabled: boolean | null;
    sms_fallback_enabled: boolean | null;
    telnyx_sms_from_e164: string | null;
    telnyx_messaging_profile_id: string | null;
  };
  return {
    forwardToE164: row?.forward_to_e164 ?? null,
    transferEnabled: row?.transfer_enabled ?? true,
    smsFallbackEnabled: row?.sms_fallback_enabled ?? true,
    smsFromE164: row?.telnyx_sms_from_e164 ?? null,
    messagingProfileId: row?.telnyx_messaging_profile_id ?? null
  };
}

/**
 * Send the owner a "missed AI call" SMS when the Gemini Live session could
 * not start. This path is only ever hit when `sms_fallback_enabled` is on
 * AND a `forward_to_e164` is configured; we never SMS the caller.
 */
async function sendMissedCallSms(params: {
  settings: TenantTelnyxSettings;
  callerE164: string;
  businessName: string;
  reason: string;
}): Promise<void> {
  const { settings, callerE164, businessName, reason } = params;
  if (!settings.smsFallbackEnabled || !settings.forwardToE164 || !settings.smsFromE164) return;
  const apiKey = process.env.TELNYX_API_KEY ?? "";
  if (!apiKey) return;
  const text =
    `[${businessName}] your AI receptionist couldn't take a live call from ${callerE164}. ` +
    `Please call them back. (Reason: ${reason.slice(0, 80)})`;
  const res = await telnyxSendPlainSms(apiKey, {
    toE164: settings.forwardToE164,
    fromE164: settings.smsFromE164,
    messagingProfileId: settings.messagingProfileId ?? undefined,
    text
  });
  if (!res.ok) {
    console.error("voice-bridge: fallback SMS failed", res.status, res.body);
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
 * never reported `usageMetadata` (some sessions — very short calls, transport
 * errors — close without a usage frame). Without this the spend POST is skipped
 * entirely, leaving `owner_chat_model_spend` flat while Google still bills the
 * audio, so the pre-call/mid-call budget gates would keep allowing voice on an
 * already-exhausted pool. Gemini Live audio is ~25 tokens/sec each direction; we
 * count both directions for the full call (conservative — never undercount) so
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

async function meterGeminiLiveSpend(params: {
  businessId: string;
  model: string;
  usage: GeminiLiveUsage;
  /** True when `usage` is a duration-based estimate (no usageMetadata frame). */
  estimated?: boolean;
}): Promise<void> {
  const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (!appBaseUrl || !gatewayToken) return;
  // Nothing billable (session never produced tokens) — skip the round trip.
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
 * After a HomeLight AI-takeover call ends, text the owner (notify number) a
 * structured lead summary plus the full transcript. Best-effort: a missing SMS
 * config or transcript just trims the message; we never throw.
 */
async function sendIntakeLeadSms(params: {
  supabase: SupabaseClient;
  settings: TenantTelnyxSettings;
  notifyE164: string;
  callControlId: string;
  /** The live-transfer line the call arrived on (transfer partner), not the seller. */
  transferFromE164: string;
  businessName: string;
  lead: CapturedLead;
}): Promise<void> {
  const { supabase, settings, notifyE164, callControlId, transferFromE164, businessName, lead } = params;
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
    maxChars: INTAKE_SMS_MAX_CHARS
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
  // is missing (single-tenant container with no provisioned business yet) —
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
    // decision (staff persona, memory recognition) — see issue #268. Empty
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
      const { data: biz } = await supabase
        .from("businesses")
        .select("name, timezone, owner_name, phone")
        .eq("id", businessId)
        .maybeSingle();
      const businessName = typeof biz?.name === "string" && biz.name.length > 0 ? biz.name : "your business";
      const businessTimezone = typeof biz?.timezone === "string" && biz.timezone.length > 0 ? biz.timezone : null;

      // Owner / team / customer gate — same intent as the SMS worker. Owner
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
        // Trusted (v2-signed) number only — a spoofed v1 caller must never get
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
              persona?: string;
              capture_fields?: unknown;
            } | null;
          };
          if (ctx.outbound === true) callDirection = "outbound";
          const ai = ctx.ai_takeover ?? undefined;
          intakeNotifyE164 = typeof ai?.notify_e164 === "string" ? ai.notify_e164 : "";
          intake = {
            persona: typeof ai?.persona === "string" ? ai.persona : undefined,
            captureFields: Array.isArray(ai?.capture_fields)
              ? (ai!.capture_fields as unknown[]).filter((x): x is string => typeof x === "string")
              : undefined
          };
          console.log("voice-bridge: HomeLight intake mode", {
            callControlId,
            notify: intakeNotifyE164 || null
          });
        }
      }

      // Let the assistant hang up when the conversation is over. Available on
      // every call (inbound + outbound) whenever we have a Telnyx API key — the
      // bridge gates the `end_call` tool on this capability being present.
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

      if (geminiLiveEnabled && apiKey) {
        try {
          const envSessionMaxMs = readPositiveMs("GEMINI_LIVE_SESSION_MAX_MS", 14 * 60 * 1000);
          // Shorten the session when the shared AI budget is nearly gone (mid-call
          // half of the hard stop). budgetCapped drives the bridge's wind-down
          // wording ("the owner isn't available right now" vs the normal time cap).
          const sessionMaxMs = await computeBudgetDerivedSessionMaxMs(
            supabase,
            businessId,
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
          // logged but never fatal — the bridge still works with a generic
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
          // conversation left off. Failure is non-fatal — first-time
          // callers (no row) and DB hiccups both fall back to the
          // vault-only prompt that voice has always used.
          //
          // The customer_memories table was added in
          // supabase/migrations/20260507000000_customer_memories.sql.
          // On VPS instances whose Supabase still predates that
          // migration, the call returns a 4xx error which we swallow —
          // again, a degraded prompt is acceptable, a refused call is
          // not.
          let customerMemorySummary: string | undefined;
          // Staff (owner/team) are not customers — don't pull a customer
          // continuity note for them (mirrors the SMS gate not treating them
          // as a customer profile).
          // trustedFromE164 (not fromE164Info): never surface another contact's
          // rolling summary off a spoofed, unsigned v1 caller number (#268).
          if (trustedFromE164 && !callerIsStaff) {
            try {
              // Alias-aware: a number merged into another profile
              // (alias_e164s) resolves to the surviving row. On a Supabase
              // predating the merge migration this errors like a missing
              // table would — swallowed below, degraded prompt.
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
            direction: callDirection,
            vault,
            // Trusted number only: this flows into the transcript's caller_e164
            // and record_customer_interaction. A spoofed v1 caller resolves to
            // "" → no interaction is written against another contact (#268).
            callerE164: trustedFromE164,
            voiceTools,
            transcriptAdapter,
            customerMemorySummary,
            callerIdentity,
            intake,
            recordDiag
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
          // line — wrong recipient and wrong story for a connected live seller.
          // Skip it; the no-lead intake SMS below still notifies the intake owner.
          if (!intake) {
            await sendMissedCallSms({
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
        // event handler — surface them so we can correlate them with
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
          // audio regardless — a skipped POST would let the budget gates keep
          // allowing voice on an exhausted pool). Best-effort — never blocks
          // reservation settle.
          try {
            if (geminiLiveModel) {
              const captured = geminiGetUsage?.() ?? null;
              const hasBilledTokens =
                captured != null &&
                (captured.promptTokens > 0 || captured.outputTokens > 0);
              const usage = hasBilledTokens
                ? captured
                : estimateLiveUsageFromDuration(geminiStartedAtMs, Date.now());
              if (usage) {
                await meterGeminiLiveSpend({
                  businessId,
                  model: geminiLiveModel,
                  usage,
                  estimated: !hasBilledTokens
                });
              }
            }
          } catch (err) {
            console.error("voice-bridge: meter Gemini Live spend error", err);
          }
          // Only notify when the Gemini bridge actually ran (geminiGetLead is
          // set on successful bridge init). If Gemini never started (init
          // failure / disabled / no key) we must NOT text the owner a phantom
          // "lead" with no captured fields and no transcript.
          if (intake && intakeNotifyE164 && geminiGetLead) {
            try {
              await sendIntakeLeadSms({
                supabase,
                settings: tenantSettings,
                notifyE164: intakeNotifyE164,
                callControlId,
                // The ANI is the transfer partner's line (e.g. HomeLight), not
                // the seller — pass it only as the "transferred via" reference.
                transferFromE164: trustedFromE164 || fromE164Info || "",
                businessName,
                lead: geminiGetLead()
              });
            } catch (err) {
              console.error("voice-bridge: intake SMS error", err);
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
