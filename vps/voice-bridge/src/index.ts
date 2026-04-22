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
import { createGeminiTelnyxBridge, type TransferCapability } from "./gemini-telnyx-bridge.js";
import { loadVaultForPrompt } from "./vault-loader.js";
import { telnyxTransferCall, telnyxSendPlainSms } from "./telnyx-call-actions.js";

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

function signMac(payload: {
  v: number;
  call_control_id: string;
  business_id: string;
  to_e164: string;
  exp: number;
  nonce: string;
}): string {
  const canonical = JSON.stringify({
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

async function heartbeat(supabase: SupabaseClient, businessId: string): Promise<void> {
  await supabase
    .from("business_telnyx_settings")
    .upsert(
      {
        business_id: businessId,
        bridge_last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id" }
    );
}

function main(): void {
  if (!STREAM_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("voice-bridge: set STREAM_URL_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
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
    // Informational only (unsigned). See telnyx-voice-inbound: used to craft
    // operator SMS fallback; never a routing key.
    const fromE164Info = url.searchParams.get("from_e164_info") ?? "";

    if (v !== 1 || !callControlId || !businessId || !toE164 || !nonce || !mac) {
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
      v: 1,
      call_control_id: callControlId,
      business_id: businessId,
      to_e164: toE164,
      exp,
      nonce
    });
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

      void heartbeat(supabase, businessId);
      const hb = setInterval(() => {
        void heartbeat(supabase, businessId);
      }, 30_000);

      let geminiTeardown: (() => Promise<void>) | undefined;
      let onTelnyxGemini: ((rawUtf8: string) => void) | undefined;

      const geminiFlag = (process.env.GEMINI_LIVE_ENABLED ?? "true").trim().toLowerCase();
      const geminiLiveEnabled = geminiFlag !== "false" && geminiFlag !== "0";
      const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";

      const tenantSettings = await loadTenantTelnyxSettings(supabase, businessId);
      const { data: biz } = await supabase
        .from("businesses")
        .select("name")
        .eq("id", businessId)
        .maybeSingle();
      const businessName = typeof biz?.name === "string" && biz.name.length > 0 ? biz.name : "your business";

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
            const result = await telnyxTransferCall(telnyxApiKey, callControlId, {
              toE164: forwardE164,
              fromE164: fromDid
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
          }
        };
      }

      if (geminiLiveEnabled && apiKey) {
        try {
          const sessionMaxMs = readPositiveMs("GEMINI_LIVE_SESSION_MAX_MS", 14 * 60 * 1000);
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
                  callerE164: fromE164Info || ""
                }
              : undefined;

          const bridge = await createGeminiTelnyxBridge({
            ws,
            businessId,
            callControlId,
            apiKey,
            model,
            sessionMaxMs,
            warnBeforeMs,
            finalNudgeBeforeMs,
            businessName,
            transfer,
            vault,
            callerE164: fromE164Info || "",
            voiceTools
          });
          onTelnyxGemini = bridge.onTelnyxMessage;
          geminiTeardown = bridge.teardown;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error("voice-bridge: Gemini Live unavailable (continuing without AI audio)", reason);
          await sendMissedCallSms({
            settings: tenantSettings,
            callerE164: fromE164Info || "unknown",
            businessName,
            reason: `Gemini Live init failed: ${reason}`
          });
        }
      } else if (!geminiLiveEnabled) {
        console.warn("voice-bridge: GEMINI_LIVE_ENABLED=false; AI audio pipe disabled (media stream still accepted)");
        await sendMissedCallSms({
          settings: tenantSettings,
          callerE164: fromE164Info || "unknown",
          businessName,
          reason: "AI audio disabled (flag off)"
        });
      } else {
        console.warn("voice-bridge: GOOGLE_API_KEY or GEMINI_API_KEY unset; AI audio pipe disabled");
        await sendMissedCallSms({
          settings: tenantSettings,
          callerE164: fromE164Info || "unknown",
          businessName,
          reason: "AI audio disabled (no API key)"
        });
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

      ws.on("close", () => {
        clearInterval(hb);
        void geminiTeardown?.();
        const endedAt = new Date().toISOString();
        void (async () => {
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
