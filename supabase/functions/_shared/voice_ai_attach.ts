/**
 * Attaching the Gemini bridge to an ALREADY-ANSWERED call leg.
 *
 * Two webhooks need this identical sequence and must never drift:
 *   - telnyx-voice-call-end, when every ring_handoff missed and the AI takes
 *     over a live caller a human accepted;
 *   - telnyx-voice-inbound, when a voice flow sets `answerFirst` and the AI
 *     answers the partner's call itself (pressing the accept digits first).
 *
 * Both halves fail CLOSED: resolveBridgeTarget returns null when AI streaming
 * is off, the signing secret is missing, the bridge heartbeat is stale, or no
 * origin is configured, and the caller must then abort rather than connect a
 * live person to dead air.
 */
import { signStreamUrlMac, type StreamPayloadV2 } from "./stream_url.ts";
import { telnyxStreamingStart } from "./telnyx_call_actions.ts";
import { translatorAllowedForTier } from "./translator_tier.ts";

/** Structural client shape: the two callers hold differently-typed clients. */
type AttachSupabase = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error?: unknown }>;
      };
    };
    insert: (row: Record<string, unknown>) => PromiseLike<{
      error: { message: string } | null;
    }>;
  };
};

export type VoiceAiAttachDeps = {
  supabase: AttachSupabase;
  apiKey: string;
  streamSecret: string;
  defaultBridgeOrigin: string;
};

export type BridgeTarget = { origin: string; path: string; translatorArmed: boolean };

/**
 * Env read through `globalThis` (the cron_auth.ts convention) rather than the
 * `Deno` global directly: the Vitest suite imports this module to pin its
 * fail-closed guards, and the Node typecheck has no Deno types.
 */
type DenoEnv = { env: { get: (key: string) => string | undefined } };

function envValue(key: string): string | undefined {
  return (globalThis as unknown as { Deno?: DenoEnv }).Deno?.env?.get(key);
}

function envVoiceAiStreamEnabled(): boolean {
  const v = (envValue("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Resolve the bridge media target (origin + path), gated on a fresh bridge
 * heartbeat. Null means "do not attach": the caller aborts and ends the call
 * cleanly (or, on the AI-first path, falls back to ringing humans).
 */
export async function resolveBridgeTarget(
  deps: VoiceAiAttachDeps,
  businessId: string,
  toE164: string,
  label = "handoff"
): Promise<BridgeTarget | null> {
  if (!envVoiceAiStreamEnabled()) {
    console.warn(`${label}: AI stream disabled by flag; skipping takeover`);
    return null;
  }
  // Without the signing secret we would mint a stream URL with an empty MAC:
  // Telnyx streaming_start still returns 200 but the VPS bridge rejects the
  // WebSocket, leaving a connected person in silence with no cleanup. Gate here,
  // BEFORE any DTMF.
  if (!deps.streamSecret) {
    console.error(`${label}: STREAM_URL_SIGNING_SECRET missing; cannot attach AI`, { businessId });
    return null;
  }
  const { supabase, defaultBridgeOrigin } = deps;
  const [routeRes, settingsRes, bizRes] = await Promise.all([
    supabase
      .from("telnyx_voice_routes")
      .select("media_wss_origin, media_path")
      .eq("to_e164", toE164)
      .maybeSingle(),
    supabase
      .from("business_telnyx_settings")
      .select(
        "bridge_last_heartbeat_at, bridge_media_wss_origin, bridge_media_path, translator_mode_enabled"
      )
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase.from("businesses").select("tier").eq("id", businessId).maybeSingle()
  ]);
  const route = routeRes.data as { media_wss_origin?: string | null; media_path?: string | null } | null;
  const settings = settingsRes.data as {
    bridge_last_heartbeat_at?: string | null;
    bridge_media_wss_origin?: string | null;
    bridge_media_path?: string | null;
    translator_mode_enabled?: boolean | null;
  } | null;
  const biz = bizRes.data as { tier?: string | null } | null;

  const heartbeatTtlSec = (() => {
    const raw = Number(envValue("BRIDGE_HEARTBEAT_TTL_SEC") ?? "150");
    return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 150;
  })();
  const hb = settings?.bridge_last_heartbeat_at
    ? new Date(settings.bridge_last_heartbeat_at).getTime()
    : 0;
  if (!hb || Date.now() - hb > heartbeatTtlSec * 1000) {
    console.error(`${label}: bridge down, cannot attach AI`, { businessId });
    return null;
  }

  const origin = route?.media_wss_origin ?? settings?.bridge_media_wss_origin ?? defaultBridgeOrigin;
  if (!origin) {
    console.error(`${label}: no bridge origin`, { businessId });
    return null;
  }
  const pathRaw = route?.media_path ?? settings?.bridge_media_path ?? "/voice/stream";
  const pathTrimmed = pathRaw.trim().replace(/\/+$/, "") || "/voice/stream";
  const path = pathTrimmed.startsWith("/") ? pathTrimmed : `/${pathTrimmed}`;
  // Translator mode has to be armed when the stream STARTS (Telnyx cannot
  // re-point a running stream's target legs), so every site that attaches the
  // bridge reads the same tenant column AND the Standard+ tier gate (AI-first
  // and answer-time paths must not drift).
  const translatorArmed =
    settings?.translator_mode_enabled === true && translatorAllowedForTier(biz?.tier);
  return { origin, path, translatorArmed };
}

/**
 * Mint a signed v2 media-stream URL and attach the Gemini bridge to the
 * already-answered leg via streaming_start. Does NOT reserve voice budget: each
 * caller owns that decision (the takeover path is unmetered like the per-caller
 * transfer rules; the AI-first path reserves before calling this).
 */
export async function attachAiStream(
  deps: VoiceAiAttachDeps,
  args: {
    businessId: string;
    callControlId: string;
    toE164: string;
    fromE164: string;
    origin: string;
    path: string;
    /** Tenant opted into translator mode (resolveBridgeTarget). */
    translatorArmed?: boolean;
    label?: string;
  }
): Promise<boolean> {
  const { supabase, apiKey, streamSecret } = deps;
  const label = args.label ?? "handoff";
  const exp = Math.floor(Date.now() / 1000) + 120;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const streamPayload: StreamPayloadV2 = {
    v: 2,
    call_control_id: args.callControlId,
    business_id: args.businessId,
    to_e164: args.toE164,
    from_e164: args.fromE164,
    exp,
    nonce
  };
  const mac = await signStreamUrlMac(streamPayload, streamSecret);
  const expiresAt = new Date((exp + 60) * 1000).toISOString();
  const { error: nonceErr } = await supabase
    .from("stream_url_nonces")
    .insert({ nonce, expires_at: expiresAt });
  if (nonceErr) {
    console.error(`${label}: nonce insert failed`, nonceErr);
    return false;
  }

  const qs = new URLSearchParams({
    v: "2",
    call_control_id: args.callControlId,
    business_id: args.businessId,
    to_e164: args.toE164,
    exp: String(exp),
    nonce,
    mac
  });
  if (args.fromE164) qs.set("from_e164_info", args.fromE164);
  const streamUrl = `${args.origin.replace(/\/$/, "")}${args.path}?${qs.toString()}`
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:");

  const res = await telnyxStreamingStart(apiKey, args.callControlId, {
    streamUrl,
    ...(args.translatorArmed ? { targetLegs: "both" as const } : {})
  });
  if (!res.ok) {
    console.error(`${label}: streaming_start failed`, res.status, (await res.text()).slice(0, 300));
    return false;
  }
  return true;
}
