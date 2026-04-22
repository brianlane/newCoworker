import WebSocket from "ws";
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from "@google/genai";
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

export type TransferCapability = {
  /** E.164 destination (owner/staff cell). */
  toE164: string;
  /** Called when the model invokes the transfer tool. Resolved value is echoed back to the model. */
  execute: (args: { reason?: string }) => Promise<{ ok: boolean; detail?: string }>;
};

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
  /** When set, registers a `transfer_to_owner` function tool on the Live session. */
  transfer?: TransferCapability;
};

function systemInstructionForBusiness(businessName: string, hasTransfer: boolean): string {
  const base = [
    `You are the AI phone receptionist for ${businessName}.`,
    "You are on a live phone call with a human caller. Keep replies concise, natural, and spoken (not bulleted).",
    "Be warm and professional. If you don't know something specific to this business, say you'll have someone follow up.",
    "Do not mention APIs, models, tokens, or internal session limits to the caller unless a coordinator message explicitly tells you what to say."
  ];
  if (hasTransfer) {
    base.push(
      "If the caller explicitly asks to speak to a human, a manager, the owner, or indicates the matter is urgent/sensitive (emergencies, complaints, legal, medical), briefly acknowledge it, tell them you're connecting them now, then call the `transfer_to_owner` tool. Do not call the tool for routine questions you can answer yourself."
    );
  } else {
    base.push(
      "This account has not set up human transfer. If the caller asks for a human, take a clear callback message (name, number, best time, reason) and tell them someone will follow up soon."
    );
  }
  return base.join(" ");
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

  const transferTool = opts.transfer
    ? [
        {
          functionDeclarations: [
            {
              name: "transfer_to_owner",
              description:
                "Warm-transfer the live phone call to the business owner/staff. Call ONLY when the caller explicitly asks for a human, indicates urgency, or raises a matter you cannot handle. Before calling this tool, briefly reassure the caller you're connecting them now.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  reason: {
                    type: Type.STRING,
                    description:
                      "One short sentence describing why a human is needed (e.g. 'caller asked for manager about billing dispute')."
                  }
                },
                required: []
              }
            }
          ]
        }
      ]
    : undefined;

  session = await ai.live.connect({
    model: opts.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstructionForBusiness(opts.businessName, Boolean(opts.transfer)),
      tools: transferTool
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        if (ended || opts.ws.readyState !== WebSocket.OPEN) return;
        handleModelToolCalls(message);
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

  /**
   * Forward any `tool_call` frames the Live API emits to the bound capability
   * (currently only `transfer_to_owner`). Telnyx's `/actions/transfer` is
   * fire-and-forget for the bridge — once it returns 200 the carrier is the
   * one deciding how to bridge the second leg, and our WS will get a `close`
   * shortly after — so we just echo a terse status back to the model so it
   * can close out its last turn gracefully if it is still speaking.
   */
  function handleModelToolCalls(message: LiveServerMessage): void {
    const calls = message.toolCall?.functionCalls;
    if (!calls || calls.length === 0) return;
    for (const call of calls) {
      if (call.name === "transfer_to_owner" && opts.transfer) {
        const reason = typeof call.args?.reason === "string" ? (call.args.reason as string) : undefined;
        // Wrap the whole IIFE in a try/catch. `execute` can throw on any
        // network-layer failure (Telnyx fetch timeout, DNS blip, AbortError,
        // etc.) and the `void` would otherwise leak the rejection and crash
        // the bridge process under Node ≥15, taking every active call on
        // this VPS down with it. On failure we still send a tool response
        // back to the model so it can close its turn gracefully.
        void (async () => {
          let result: { ok: boolean; detail?: string };
          try {
            result = await opts.transfer!.execute({ reason });
          } catch (err) {
            console.error("gemini-bridge: transfer execute threw", err);
            result = {
              ok: false,
              detail: err instanceof Error ? `transfer error: ${err.message}` : "transfer error"
            };
          }
          try {
            session.sendToolResponse({
              functionResponses: [
                {
                  id: call.id,
                  name: "transfer_to_owner",
                  response: {
                    ok: result.ok,
                    detail: result.detail ?? (result.ok ? "transfer initiated" : "transfer failed")
                  }
                }
              ]
            });
          } catch (err) {
            console.error("gemini-bridge: sendToolResponse failed", err);
          }
        })();
      } else {
        try {
          session.sendToolResponse({
            functionResponses: [
              {
                id: call.id,
                name: call.name ?? "unknown",
                response: { ok: false, detail: "tool not available" }
              }
            ]
          });
        } catch (err) {
          console.error("gemini-bridge: sendToolResponse (unknown tool) failed", err);
        }
      }
    }
  }

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
