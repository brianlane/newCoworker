import WebSocket from "ws";
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";
import { parsePcmRateFromMime, resamplePCM16Mono } from "./audio-resample.js";
import { telnyxMediaMessageFromPcmBase64, tryParseTelnyxMediaPayloadBase64 } from "./telnyx-media-json.js";

const TELNYX_PCM_RATE = 16000;
const GEMINI_OUTPUT_DEFAULT_RATE = 24000;

/**
 * WebSocket downlink backpressure threshold (bytes buffered in the send queue before we
 * start dropping Gemini-generated PCM frames). Telnyx media frames at 16 kHz PCM16 mono
 * average ~640 bytes per 20 ms JSON frame; 256 KiB corresponds to ~8 seconds of audio
 * backlog, well past the point where the caller hears old audio. Dropping frames here
 * bounds memory on a slow network and keeps playback close to real-time.
 */
const DOWNLINK_BACKPRESSURE_HIGH_WATERMARK_BYTES = 256 * 1024;

export type GeminiBridgeOptions = {
  ws: WebSocket;
  businessId: string;
  callControlId: string;
  apiKey: string;
  model: string;
  /** Hard stop for this Live session (ms). */
  sessionMaxMs: number;
  /** First spoken coordinator prompt this many ms before `sessionMaxMs`. */
  warnBeforeMs: number;
  /** Second, firmer coordinator prompt this many ms before `sessionMaxMs`. */
  finalNudgeBeforeMs: number;
  businessName: string;
};

function systemInstructionForBusiness(businessName: string): string {
  return [
    `You are the AI phone receptionist for ${businessName}.`,
    "You are on a live phone call with a human caller. Keep replies concise, natural, and spoken (not bulleted).",
    "Be warm and professional. If you don't know something specific to this business, say you'll have someone follow up.",
    "Do not mention APIs, models, tokens, or internal session limits to the caller unless a coordinator message explicitly tells you what to say."
  ].join(" ");
}

function extractModelAudioParts(message: LiveServerMessage): Array<{ dataB64: string; mimeType?: string }> {
  const out: Array<{ dataB64: string; mimeType?: string }> = [];
  const parts = message.serverContent?.modelTurn?.parts;
  if (!Array.isArray(parts)) return out;
  for (const p of parts) {
    const inline = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data && typeof inline.data === "string") {
      const mt = inline.mimeType ?? "";
      if (!mt || mt.includes("audio") || mt.includes("pcm")) {
        out.push({ dataB64: inline.data, mimeType: inline.mimeType });
      }
    }
  }
  return out;
}

type DownlinkTelemetry = {
  droppedFrames: number;
  lastDropWarnAtMs: number;
};

function sendPcmToTelnyx(ws: WebSocket, pcm16le: Int16Array, telemetry: DownlinkTelemetry): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Backpressure guard: drop frames once the socket's buffered-but-unsent bytes exceed
  // the high watermark. Without this, a slow or stalled Telnyx socket lets every Gemini
  // PCM frame accumulate in Node's send queue, growing RSS unboundedly and making the
  // caller hear stale audio once the socket drains. Dropping the newest frame is the
  // right call for real-time voice — retries cannot help (the moment has passed).
  if (ws.bufferedAmount > DOWNLINK_BACKPRESSURE_HIGH_WATERMARK_BYTES) {
    telemetry.droppedFrames += 1;
    const now = Date.now();
    if (now - telemetry.lastDropWarnAtMs > 5_000) {
      telemetry.lastDropWarnAtMs = now;
      console.warn(
        "gemini-bridge: downlink backpressure — dropping frames",
        { bufferedAmount: ws.bufferedAmount, droppedFrames: telemetry.droppedFrames }
      );
    }
    return;
  }
  const buf = Buffer.from(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength);
  ws.send(telnyxMediaMessageFromPcmBase64(buf.toString("base64")));
}

/**
 * Gemini Live (native audio) ↔ Telnyx bidirectional L16 @16 kHz JSON media frames.
 */
export async function createGeminiTelnyxBridge(opts: GeminiBridgeOptions): Promise<{
  onTelnyxMessage: (rawUtf8: string) => void;
  teardown: () => Promise<void>;
}> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  let ended = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const downlinkTelemetry: DownlinkTelemetry = {
    droppedFrames: 0,
    lastDropWarnAtMs: 0
  };

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };

  let session!: Session;

  const teardown = async () => {
    if (ended) return;
    ended = true;
    clearTimers();
    try {
      session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      session.close();
    } catch {
      /* ignore */
    }
  };

  session = await ai.live.connect({
    model: opts.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstructionForBusiness(opts.businessName)
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        if (ended || opts.ws.readyState !== WebSocket.OPEN) return;
        for (const chunk of extractModelAudioParts(message)) {
          try {
            const raw = Buffer.from(chunk.dataB64, "base64");
            if (raw.length < 2 || raw.length % 2 !== 0) continue;
            const inSamples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
            const inRate = parsePcmRateFromMime(chunk.mimeType, GEMINI_OUTPUT_DEFAULT_RATE);
            const outSamples = resamplePCM16Mono(inSamples, inRate, TELNYX_PCM_RATE);
            sendPcmToTelnyx(opts.ws, outSamples, downlinkTelemetry);
          } catch (e) {
            console.error("gemini-bridge: downlink chunk", e);
          }
        }
      },
      onerror: (e: ErrorEvent) => {
        console.error("gemini-bridge: Live API error", e.message ?? String(e));
      },
      onclose: () => {
        ended = true;
        clearTimers();
      }
    }
  });

  const { sessionMaxMs, warnBeforeMs, finalNudgeBeforeMs } = opts;
  const name = opts.businessName;
  const warnAt = Math.max(0, sessionMaxMs - warnBeforeMs);
  const nudgeAt = Math.max(0, sessionMaxMs - finalNudgeBeforeMs);

  timers.push(
    setTimeout(() => {
      if (ended) return;
      const mins = Math.max(1, Math.round(warnBeforeMs / 60000));
      session.sendClientContent({
        turns: `[Coordinator — speak aloud] The AI session will end in about ${mins} minute(s). Give the caller a warm heads-up that you're wrapping up, and that ${name} can help them directly afterward if needed.`,
        turnComplete: true
      });
    }, warnAt)
  );

  timers.push(
    setTimeout(() => {
      if (ended) return;
      session.sendClientContent({
        turns: `[Coordinator — speak aloud] Finish your thought and deliver a very brief, warm goodbye now. Let them know someone at ${name} can follow up if they still need help.`,
        turnComplete: true
      });
    }, nudgeAt)
  );

  timers.push(
    setTimeout(() => {
      if (ended) return;
      void (async () => {
        try {
          session.sendClientContent({
            turns: `[Coordinator — speak aloud] Session time limit reached. Say one short, friendly goodbye and thank them for calling ${name}.`,
            turnComplete: true
          });
          await new Promise((r) => setTimeout(r, 1200));
        } catch {
          /* ignore */
        }
        await teardown();
      })();
    }, sessionMaxMs)
  );

  const onTelnyxMessage = (rawUtf8: string) => {
    if (ended) return;
    const b64 = tryParseTelnyxMediaPayloadBase64(rawUtf8);
    if (!b64) return;
    try {
      session.sendRealtimeInput({
        media: { mimeType: `audio/pcm;rate=${TELNYX_PCM_RATE}`, data: b64 }
      });
    } catch (e) {
      console.error("gemini-bridge: uplink", e);
    }
  };

  return { onTelnyxMessage, teardown };
}
