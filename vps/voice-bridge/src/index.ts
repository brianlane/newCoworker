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
import { createGeminiTelnyxBridge } from "./gemini-telnyx-bridge.js";

loadEnv();

const PORT = Number(process.env.VOICE_BRIDGE_PORT ?? "8090");
const STREAM_SECRET = process.env.STREAM_URL_SIGNING_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUSINESS_ID = process.env.BUSINESS_ID ?? "";
/** Min ms between `voice_active_sessions.last_seen_at` writes per call (audio ~50/s otherwise). */
const _lastSeenMs = Number(process.env.VOICE_SESSION_LAST_SEEN_INTERVAL_MS ?? "15000");
const LAST_SEEN_UPDATE_INTERVAL_MS =
  Number.isFinite(_lastSeenMs) && _lastSeenMs >= 1000 ? _lastSeenMs : 15_000;

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

  const supabase: SupabaseClient = createClient<any>(SUPABASE_URL, SUPABASE_SERVICE_KEY);
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

    wss.handleUpgrade(req, socket, head, async (ws) => {
      const { data: consumed } = await supabase
        .from("stream_url_nonces")
        .update({ consumed_at: new Date().toISOString() })
        .eq("nonce", nonce)
        .is("consumed_at", null)
        .select("nonce")
        .maybeSingle();

      if (!consumed?.nonce) {
        ws.close(4401, "nonce");
        return;
      }

      await supabase.from("voice_active_sessions").upsert(
        {
          call_control_id: callControlId,
          business_id: businessId,
          stream_nonce: nonce,
          last_seen_at: new Date().toISOString()
        },
        { onConflict: "call_control_id" }
      );

      await supabase
        .from("voice_reservations")
        .update({ ws_connected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("call_control_id", callControlId);

      void heartbeat(supabase, businessId);
      const hb = setInterval(() => {
        void heartbeat(supabase, businessId);
      }, 30_000);

      let geminiTeardown: (() => Promise<void>) | undefined;
      let onTelnyxGemini: ((rawUtf8: string) => void) | undefined;

      const geminiLiveEnabled =
        (process.env.GEMINI_LIVE_ENABLED ?? "true").trim().toLowerCase() !== "false" &&
        (process.env.GEMINI_LIVE_ENABLED ?? "true").trim().toLowerCase() !== "0";
      const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
      if (geminiLiveEnabled && apiKey) {
        try {
          const { data: biz } = await supabase
            .from("businesses")
            .select("name")
            .eq("id", businessId)
            .maybeSingle();
          const businessName = typeof biz?.name === "string" && biz.name.length > 0 ? biz.name : "your business";
          const sessionMaxMs = readPositiveMs("GEMINI_LIVE_SESSION_MAX_MS", 14 * 60 * 1000);
          const warnBeforeMs = readPositiveMs("GEMINI_LIVE_SESSION_WARN_BEFORE_MS", 60 * 1000);
          const finalNudgeBeforeMs = readPositiveMs("GEMINI_LIVE_SESSION_FINAL_NUDGE_MS", 15 * 1000);
          const model = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";
          const bridge = await createGeminiTelnyxBridge({
            ws,
            businessId,
            callControlId,
            apiKey,
            model,
            sessionMaxMs,
            warnBeforeMs,
            finalNudgeBeforeMs,
            businessName
          });
          onTelnyxGemini = bridge.onTelnyxMessage;
          geminiTeardown = bridge.teardown;
        } catch (e) {
          console.error("voice-bridge: Gemini Live unavailable (continuing without AI audio)", e);
        }
      } else if (!geminiLiveEnabled) {
        console.warn("voice-bridge: GEMINI_LIVE_ENABLED=false; AI audio pipe disabled (media stream still accepted)");
      } else {
        console.warn("voice-bridge: GOOGLE_API_KEY or GEMINI_API_KEY unset; AI audio pipe disabled");
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
  });

  server.listen(PORT, () => {
    console.log(`voice-bridge listening :${PORT} (HTTP + WS /voice/stream)`);
  });
}

main();
