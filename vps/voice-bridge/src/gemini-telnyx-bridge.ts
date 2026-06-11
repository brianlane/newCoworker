import WebSocket from "ws";
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from "@google/genai";
import { parsePcmRateFromMime, resamplePCM16Mono } from "./audio-resample.js";
import { parseTelnyxFrame, telnyxMediaMessageFromPcmBase64 } from "./telnyx-media-json.js";
import { decodeTelnyxMediaPayload, RtpEncoder } from "./rtp-frame.js";
import { composeVaultPromptSection, type VaultSnapshot } from "./vault-loader.js";
import {
  createTranscriptRecorder,
  type TranscriptAdapter,
  type TranscriptRecorder
} from "./voice-transcript.js";

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

/**
 * Maximum time a single Gemini Live tool handler is allowed to take before we
 * respond to the model with `ok: false, detail: "timeout"`. The call is still
 * live and the caller hears silence while we wait, so we keep this tight.
 * 3.5s is a compromise that allows most Nango/Telnyx round trips (typically
 * 200–1200 ms) while still leaving room for a warm-up retry on the app side.
 */
const TOOL_CALL_TIMEOUT_MS = 3500;

export type TransferCapability = {
  /** E.164 destination (owner/staff cell). */
  toE164: string;
  /** Called when the model invokes the transfer tool. Resolved value is echoed back to the model. */
  execute: (args: { reason?: string }) => Promise<{ ok: boolean; detail?: string }>;
};

/**
 * Configuration for the voice tool suite — a small set of HTTP adapters the
 * platform Next.js app exposes under `/api/voice/tools/*`. The bridge passes
 * every Gemini Live tool call through these adapters, which in turn broker
 * Nango (calendar/email), Telnyx (SMS), and CRM logging.
 *
 * Keeping the integrations server-side means:
 *   - Nango secrets never touch the VPS.
 *   - The adapters can enforce multi-tenant auth from one place.
 *   - A single deploy rolls out behavior changes without rebuilding the bridge.
 */
export type VoiceToolsConfig = {
  /** e.g. `https://app.newcoworker.ai`. When blank, the voice tool suite is disabled. */
  appBaseUrl: string;
  /** Shared bearer token from `.env`. Sent as `Authorization: Bearer ...`. */
  gatewayToken: string;
  /** Call identifier, echoed to the app for log correlation. */
  callControlId: string;
  /** Caller's E.164 number as reported by Telnyx. May be empty / anonymous. */
  callerE164?: string;
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
  /** Vault markdown (soul/identity/memory/website) rendered into the system prompt. */
  vault?: VaultSnapshot;
  /**
   * Optional caller E.164 (raw from Telnyx) — forwarded to voice tools so the
   * app can attribute appointments/capture records to the right contact.
   */
  callerE164?: string;
  /** HTTP adapters for the knowledge/calendar/email/sms/capture tool suite. */
  voiceTools?: VoiceToolsConfig;
  /**
   * When set, Gemini Live's `inputAudioTranscription` and
   * `outputAudioTranscription` are enabled and the bridge writes one row per
   * completed turn through this adapter. Leave undefined to disable the
   * feature entirely (behaviour preserved from before the feature shipped).
   */
  transcriptAdapter?: TranscriptAdapter;
  /**
   * Phase 3b: optional rolling cross-channel summary for the caller's
   * customer profile (one continuous "memory" across SMS + voice for
   * this E.164). Appended after the vault section so the model treats
   * it as caller-specific context, not business-wide.
   *
   * Trimmed by the caller (in vps/voice-bridge/src/index.ts) to
   * VOICE_CUSTOMER_MEMORY_MAX_CHARS so it can never breach the
   * 12 KB Live system-instruction ceiling enforced by vault-loader.ts.
   * When omitted (first-time caller, no Phase 2 summarizer rollup
   * yet), the prompt is identical to the pre-3b shape.
   */
  customerMemorySummary?: string;
};

/**
 * Hard cap on the inline voice customer-memory snippet. Sized to leave
 * Gemini Live's 12 KB system-instruction ceiling firmly intact even
 * when a maximally-filled vault is also present (vault loader's own
 * cap is 12 KB minus a small reserve; this snippet is layered on top).
 *
 * 800 chars covers every real-world summary observed in test (mean ~280,
 * 95th percentile ~520, hard tail at ~720). Larger summaries are
 * deliberately truncated client-side rather than letting the prompt
 * grow — a bigger summary is rarely a more useful one (the model
 * actually skims the first ~3 sentences in practice), and skew between
 * the dashboard's full-fat summary and the voice-trimmed snippet is
 * acceptable on this surface.
 */
export const VOICE_CUSTOMER_MEMORY_MAX_CHARS = 800;

const WEEKDAYS_UTC = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

/**
 * Date awareness for the voice surface. Mirrors
 * `supabase/functions/_shared/datetime_line.ts` (the bridge is rsynced to
 * the VPS standalone, so it can't import across the repo) — keep the two in
 * sync. Without this the model can't resolve "tomorrow at 2pm" into the ISO
 * times the calendar tools require. UTC-pinned: businesses don't store a
 * timezone yet.
 */
export function currentDateTimeLine(now: Date = new Date()): string {
  const iso = now.toISOString();
  const weekday = WEEKDAYS_UTC[now.getUTCDay()];
  return (
    `Current date/time: ${iso} (${weekday}, UTC). ` +
    `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against this ` +
    `timestamp when calling calendar or scheduling tools, and pass ISO 8601 times.`
  );
}

export function systemInstructionForBusiness(
  businessName: string,
  hasTransfer: boolean,
  hasVoiceTools: boolean,
  vault?: VaultSnapshot,
  customerMemorySummary?: string
): string {
  const base = [
    `You are the AI phone receptionist for ${businessName}.`,
    "You are on a live phone call with a human caller. Keep replies concise, natural, and spoken (not bulleted).",
    "Be warm and professional. If you don't know something specific to this business, say you'll have someone follow up.",
    "Do not mention APIs, models, tokens, or internal session limits to the caller unless a coordinator message explicitly tells you what to say.",
    currentDateTimeLine()
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
  if (hasVoiceTools) {
    base.push(
      [
        "You can act on the caller's behalf by calling these tools:",
        "- `business_knowledge_lookup` when the caller asks something specific to this business that your briefing below doesn't answer directly.",
        "- `calendar_find_slots` then `calendar_book_appointment` when the caller wants to schedule something (consultations, viewings, intake calls).",
        "- `send_follow_up_sms` to text the caller a short summary or link.",
        "- `send_follow_up_email` to email them; if the tool returns `email_not_connected`, explain you'll send it by text instead and call `send_follow_up_sms`.",
        "- `capture_caller_details` at any point a caller provides their name, phone, email, or reason for calling so the owner has a CRM record.",
        "- `customer_lookup_by_phone` AT THE START of every call to recognize repeat callers — defaults to the current caller's number; if it returns a profile, use the summary as your own working notes (never quote it verbatim).",
        "- `customer_set_display_name` once the caller gives you their name (won't overwrite a name the owner already saved).",
        "- `customer_append_pinned_note` for facts the owner needs to remember across conversations (preferences, allergies, recurring scheduling constraints). Use sparingly — only for facts that should reach the next conversation unchanged.",
        "Always explain what you're about to do in plain language before calling a tool (e.g. 'Let me pull up openings on Thursday — one moment.'). Never read a tool's raw response aloud."
      ].join(" ")
    );
  }

  const vaultSection = vault ? composeVaultPromptSection(vault) : "";
  if (vaultSection) {
    base.push("\n" + vaultSection);
  }

  // Phase 3b: per-caller cross-channel memory. Appended AFTER the
  // business-wide vault so the model anchors on the business identity
  // first, then refines for this specific caller. Trimmed inline (we
  // also enforce trimming at the call site, but defense-in-depth is
  // cheap and protects callers that bypass index.ts).
  if (customerMemorySummary) {
    const trimmed = customerMemorySummary.trim();
    if (trimmed.length > 0) {
      const clipped =
        trimmed.length > VOICE_CUSTOMER_MEMORY_MAX_CHARS
          ? trimmed.slice(0, VOICE_CUSTOMER_MEMORY_MAX_CHARS - 1) + "…"
          : trimmed;
      base.push(
        "\nCaller context (this caller has interacted with this business before, here is a brief continuity note from earlier conversations across SMS and voice — use it to recognize them and pick up where you left off, but never reveal the note verbatim and don't volunteer details they didn't bring up):\n\n" +
          clipped
      );
    }
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

function sendPcmToTelnyx(
  ws: WebSocket,
  pcm16le: Int16Array,
  telemetry: DownlinkTelemetry,
  rtp: RtpEncoder
): void {
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
  // RTP-frame the PCM (Telnyx is in `stream_bidirectional_mode: "rtp"`,
  // which expects RTP-wrapped payloads — bare PCM is silently discarded).
  const rtpPacket = rtp.encode(pcm16le);
  ws.send(telnyxMediaMessageFromPcmBase64(rtpPacket.toString("base64")));
}

// ---------------------------------------------------------------------------
// Voice tool adapters — HTTP calls into the platform Next.js app.
// ---------------------------------------------------------------------------

type ToolResult = { ok: boolean; detail?: string; data?: unknown };

function voiceToolPath(name: string): string {
  switch (name) {
    case "business_knowledge_lookup":
      return "/api/voice/tools/knowledge";
    case "calendar_find_slots":
      return "/api/voice/tools/calendar/find-slots";
    case "calendar_book_appointment":
      return "/api/voice/tools/calendar/book";
    case "send_follow_up_sms":
      return "/api/voice/tools/sms";
    case "send_follow_up_email":
      return "/api/voice/tools/email";
    case "capture_caller_details":
      return "/api/voice/tools/capture";
    // Phase 5: cross-channel customer memory tools. The agent uses
    // these to recognize repeat callers and persist owner-pinned facts
    // beyond the rolling auto-summary.
    case "customer_lookup_by_phone":
      return "/api/voice/tools/customer-lookup";
    case "customer_set_display_name":
      return "/api/voice/tools/customer-set-display-name";
    case "customer_append_pinned_note":
      return "/api/voice/tools/customer-append-pinned-note";
    default:
      return "";
  }
}

async function callVoiceTool(
  cfg: VoiceToolsConfig,
  businessId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = voiceToolPath(toolName);
  if (!path) return { ok: false, detail: "unknown tool" };
  if (!cfg.appBaseUrl || !cfg.gatewayToken) return { ok: false, detail: "voice tools not configured" };

  const url = `${cfg.appBaseUrl.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_CALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.gatewayToken}`
      },
      body: JSON.stringify({
        businessId,
        callControlId: cfg.callControlId,
        callerE164: cfg.callerE164 ?? "",
        args
      })
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        detail:
          (parsed && typeof parsed === "object" && "error" in parsed && parsed.error
            ? String((parsed as { error: unknown }).error)
            : `http_${response.status}`)
      };
    }
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      const typed = parsed as { ok: boolean; detail?: string; data?: unknown };
      return { ok: Boolean(typed.ok), detail: typed.detail, data: typed.data };
    }
    return { ok: true, data: parsed ?? undefined };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, detail: "timeout" };
    }
    return {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 120) : "network_error"
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildVoiceToolDeclarations() {
  return [
    {
      name: "business_knowledge_lookup",
      description:
        "Look up a specific fact about this business (hours, services, pricing, policies, location) when your static briefing doesn't answer the caller's question. Returns a short factual summary.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          question: {
            type: Type.STRING,
            description: "A short, concrete question to answer from the business's knowledge base."
          }
        },
        required: ["question"]
      }
    },
    {
      name: "calendar_find_slots",
      description:
        "Find open appointment slots on the business calendar for a given window. Use when the caller wants to schedule something. Returns up to ~6 candidate slots in ISO-8601.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          purpose: {
            type: Type.STRING,
            description: "Short reason for the appointment (e.g. 'property viewing', 'consultation')."
          },
          earliest: {
            type: Type.STRING,
            description: "Earliest acceptable start time, ISO-8601. Defaults to 'as soon as possible'."
          },
          latest: {
            type: Type.STRING,
            description: "Latest acceptable end time, ISO-8601. Defaults to one week out."
          },
          durationMinutes: {
            type: Type.NUMBER,
            description: "Requested slot length in minutes. Defaults to 30."
          }
        },
        required: ["purpose"]
      }
    },
    {
      name: "calendar_book_appointment",
      description:
        "Book an appointment on the business calendar. Only call after `calendar_find_slots` confirmed a slot and the caller agreed to it.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          startIso: { type: Type.STRING, description: "Slot start in ISO-8601 with timezone." },
          endIso: { type: Type.STRING, description: "Slot end in ISO-8601 with timezone." },
          attendeeName: { type: Type.STRING, description: "Caller's name." },
          attendeeEmail: { type: Type.STRING, description: "Caller's email if known." },
          attendeePhone: { type: Type.STRING, description: "Caller's phone if known." },
          summary: {
            type: Type.STRING,
            description: "One-sentence subject/summary of the appointment."
          },
          notes: {
            type: Type.STRING,
            description: "Any extra context the owner should know before the meeting."
          }
        },
        required: ["startIso", "endIso", "attendeeName", "summary"]
      }
    },
    {
      name: "send_follow_up_sms",
      description:
        "Send the caller a short follow-up SMS (links, addresses, summaries). Keep to <= 300 chars.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          toE164: {
            type: Type.STRING,
            description: "Destination phone in E.164. Defaults to the caller's ANI if omitted."
          },
          body: { type: Type.STRING, description: "Message body. Plain text." }
        },
        required: ["body"]
      }
    },
    {
      name: "send_follow_up_email",
      description:
        "Email the caller a follow-up. Requires an active workspace connection (Gmail or Outlook). If none is connected the tool returns `email_not_connected`; fall back to SMS or a spoken promise.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          toEmail: { type: Type.STRING, description: "Recipient email address." },
          subject: { type: Type.STRING, description: "Short subject line." },
          bodyText: { type: Type.STRING, description: "Plain-text email body." }
        },
        required: ["toEmail", "subject", "bodyText"]
      }
    },
    {
      name: "capture_caller_details",
      description:
        "Log caller-provided details (name, phone, email, reason, preferences) so the owner can follow up. Call as soon as the caller gives you any of these details.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          phone: { type: Type.STRING, description: "Phone, E.164 if known." },
          email: { type: Type.STRING },
          reason: {
            type: Type.STRING,
            description: "One-sentence reason for the call."
          },
          notes: {
            type: Type.STRING,
            description: "Any other useful context — preferences, urgency, constraints."
          },
          urgency: {
            type: Type.STRING,
            description: "'low', 'normal', or 'high' — high escalates to the owner."
          }
        },
        required: []
      }
    },
    {
      name: "customer_lookup_by_phone",
      description:
        "Look up the cross-channel customer profile (display name, rolling summary, last channel/date, total interaction count) for a caller's phone. Defaults to the current caller's phone when called without args. Use to recognize repeat callers and continue prior conversations naturally — but never read the summary verbatim, treat it as your own working notes.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to look up. Omit to use the current caller's phone."
          }
        },
        required: []
      }
    },
    {
      name: "customer_set_display_name",
      description:
        "Persist the caller's name on their customer profile so future calls/SMS recognize them. Call this when the caller gives their name on the call. Won't overwrite a name the owner already set from the dashboard.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          displayName: {
            type: Type.STRING,
            description:
              "The caller's name as you heard it. Will be normalized server-side."
          },
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to attribute the name to. Omit for the current caller."
          }
        },
        required: ["displayName"]
      }
    },
    {
      name: "customer_append_pinned_note",
      description:
        "Append a permanent fact to this customer's pinned notes (e.g. 'wife is allergic to nuts', 'closes at 4 every other Friday'). The note survives every future summary and is visible to the owner on the dashboard. Use sparingly — only for facts that should reach the next conversation verbatim.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          note: {
            type: Type.STRING,
            description: "The fact to pin, in the caller's words. Keep concise."
          },
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to attribute the note to. Omit for the current caller."
          }
        },
        required: ["note"]
      }
    }
  ];
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
  // Per-call RTP encoder for Gemini → Telnyx audio (bidirectional_mode=rtp).
  // PT is adopted from the first uplink frame so the synthetic stream's
  // RTP type matches what Telnyx negotiated.
  const rtpEncoder = new RtpEncoder();
  // Diagnostic counters (logged at first occurrence and on teardown). The
  // counters are kept inexpensive — incrementing booleans/integers — but
  // are critical for diagnosing "ring then silence" in production where
  // the only other tells are Telnyx delivery records and a bridge log
  // that's quiet because the happy path never warns.
  const diag = {
    firstUplinkLogged: false,
    firstDownlinkLogged: false,
    setupCompleteLogged: false,
    greetingTriggered: false,
    uplinkFrames: 0,
    uplinkBytesPostHeader: 0,
    downlinkFrames: 0,
    downlinkBytesPostHeader: 0,
    // Tracks peak |sample| seen since the last heartbeat. Pure silence
    // stays <100; real speech routinely peaks >5000. Reset every heartbeat
    // tick so the next window reports its own peak rather than the running
    // max for the whole call.
    uplinkPeakSampleWindow: 0,
    // Snapshot of frame totals at the previous heartbeat so we can suppress
    // heartbeat logs when nothing has changed (idle WS / call already ended
    // but `ended=false` not yet propagated).
    lastHeartbeatUplinkFrames: 0,
    lastHeartbeatDownlinkFrames: 0
  };

  const voiceToolsReady =
    Boolean(opts.voiceTools?.appBaseUrl) && Boolean(opts.voiceTools?.gatewayToken);

  const transcriptRecorder: TranscriptRecorder | null = opts.transcriptAdapter
    ? createTranscriptRecorder(opts.transcriptAdapter, {
        businessId: opts.businessId,
        callControlId: opts.callControlId,
        callerE164: opts.callerE164 ?? "",
        model: opts.model
      })
    : null;

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };

  let session!: Session;

  const teardown = async () => {
    // Two-part teardown:
    //   (1) Always log the session totals. Previously this was gated on
    //       `!ended`, which silently swallowed the totals when Gemini hung
    //       up before the Telnyx WS closed — the exact signal we needed to
    //       diagnose the May 2026 "ring then silence" outage.
    //   (2) The transcript recorder must run `finalize` even when `ended`
    //       is already true. An upstream Live-session close (session
    //       expiry, quota, network drop) fires `onclose` first; without
    //       running finalize here, the transcript row stays stuck at
    //       status='in_progress' with a NULL `ended_at`.
    // Note: `session.close()` itself is one-shot — calling it twice on a
    // dead session throws — so we still gate the network-side teardown on
    // `!ended`.
    console.log("gemini-bridge: teardown summary", {
      callControlId: opts.callControlId,
      endedFlagPriorToTeardown: ended,
      setupComplete: diag.setupCompleteLogged,
      greetingTriggered: diag.greetingTriggered,
      uplinkFrames: diag.uplinkFrames,
      uplinkBytesPostHeader: diag.uplinkBytesPostHeader,
      downlinkFrames: diag.downlinkFrames,
      downlinkBytesPostHeader: diag.downlinkBytesPostHeader
    });
    if (!ended) {
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
    }
    if (transcriptRecorder) {
      try {
        await transcriptRecorder.finalize();
      } catch (err) {
        console.error("gemini-bridge: transcript finalize", err);
      }
    }
  };

  const declarations: Array<{ name: string; description: string; parameters: unknown }> = [];
  if (opts.transfer) {
    declarations.push({
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
    });
  }
  if (voiceToolsReady) {
    for (const decl of buildVoiceToolDeclarations()) declarations.push(decl);
  }
  const toolsForSession =
    declarations.length > 0
      ? [{ functionDeclarations: declarations as never }]
      : undefined;

  // `inputAudioTranscription` / `outputAudioTranscription` keys are documented
  // Live API fields that turn on caller + assistant transcripts delivered on
  // the `serverContent` channel. We only set them when the recorder is wired
  // so a VPS without the feature flag runs the same shape as before.
  const transcriptionConfig = transcriptRecorder
    ? {
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    : {};

  session = await ai.live.connect({
    model: opts.model,
    config: {
      responseModalities: [Modality.AUDIO],
      ...(transcriptionConfig as Record<string, unknown>),
      systemInstruction: systemInstructionForBusiness(
        opts.businessName,
        Boolean(opts.transfer),
        voiceToolsReady,
        opts.vault,
        opts.customerMemorySummary
      ),
      tools: toolsForSession
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        if (ended || opts.ws.readyState !== WebSocket.OPEN) return;
        if (!diag.setupCompleteLogged && message.setupComplete) {
          diag.setupCompleteLogged = true;
          console.log("gemini-bridge: setupComplete", { callControlId: opts.callControlId });
          // Gemini Live waits for the user to speak by default. On a phone
          // call the caller expects the assistant to greet first — without
          // this nudge they hear silence after ringback (no audio activity
          // means VAD never marks a turn complete and the model stays mute).
          // Sending a coordinator-style prompt with `turnComplete: true`
          // makes Gemini emit its first audio chunk immediately.
          if (!diag.greetingTriggered) {
            diag.greetingTriggered = true;
            try {
              session.sendClientContent({
                turns: `[Coordinator — speak aloud now] The caller has just connected. Greet them warmly in one short sentence (e.g. "Hi, thanks for calling ${opts.businessName} — how can I help?") and wait for their reply.`,
                turnComplete: true
              });
              console.log("gemini-bridge: greeting prompt sent", {
                callControlId: opts.callControlId
              });
            } catch (err) {
              console.error("gemini-bridge: greeting prompt failed", err);
            }
          }
        }
        handleModelToolCalls(message);
        if (transcriptRecorder) {
          void transcriptRecorder.ingest(message);
        }
        for (const chunk of extractModelAudioParts(message)) {
          try {
            const raw = Buffer.from(chunk.dataB64, "base64");
            if (raw.length < 2 || raw.length % 2 !== 0) continue;
            const inSamples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
            const inRate = parsePcmRateFromMime(chunk.mimeType, GEMINI_OUTPUT_DEFAULT_RATE);
            const outSamples = resamplePCM16Mono(inSamples, inRate, TELNYX_PCM_RATE);
            if (!diag.firstDownlinkLogged) {
              diag.firstDownlinkLogged = true;
              console.log("gemini-bridge: first downlink chunk", {
                callControlId: opts.callControlId,
                mimeType: chunk.mimeType,
                inRate,
                inSamples: inSamples.length,
                outSamples: outSamples.length
              });
            }
            diag.downlinkFrames += 1;
            diag.downlinkBytesPostHeader += outSamples.byteLength;
            sendPcmToTelnyx(opts.ws, outSamples, downlinkTelemetry, rtpEncoder);
          } catch (e) {
            console.error("gemini-bridge: downlink chunk", e);
          }
        }
      },
      onerror: (e: ErrorEvent) => {
        console.error("gemini-bridge: Live API error", {
          callControlId: opts.callControlId,
          message: e.message ?? String(e),
          uplinkFrames: diag.uplinkFrames,
          downlinkFrames: diag.downlinkFrames
        });
        if (transcriptRecorder) {
          void transcriptRecorder.finalize({ errored: true });
        }
      },
      onclose: (e?: CloseEvent) => {
        // Always log; previously this was silent and masked upstream session
        // drops (quota / model rejects / config error) as "silence after
        // ringback" because the bridge looked healthy from the Telnyx side.
        console.log("gemini-bridge: Live API onclose", {
          callControlId: opts.callControlId,
          code: e?.code,
          reason: e?.reason,
          wasClean: e?.wasClean,
          setupComplete: diag.setupCompleteLogged,
          greetingTriggered: diag.greetingTriggered,
          uplinkFrames: diag.uplinkFrames,
          downlinkFrames: diag.downlinkFrames
        });
        ended = true;
        clearTimers();
        // Kick the recorder finalize as soon as the Live session closes.
        // `teardown` (called from ws.on("close")) will do the same — both paths
        // hit the recorder's internal `finalized` guard so whichever fires
        // first wins and the second is a no-op. This protects against the
        // case where Gemini closes first (session expiry / upstream drop) and
        // teardown might otherwise short-circuit before finalizing the row.
        if (transcriptRecorder) {
          void transcriptRecorder.finalize();
        }
      }
    }
  });

  function sendToolResponse(id: string | undefined, name: string, response: ToolResult): void {
    try {
      session.sendToolResponse({
        functionResponses: [
          {
            id,
            name,
            response: {
              ok: response.ok,
              detail: response.detail ?? (response.ok ? "ok" : "error"),
              ...(response.data !== undefined ? { data: response.data } : {})
            }
          }
        ]
      });
    } catch (err) {
      console.error("gemini-bridge: sendToolResponse failed", { name, err });
    }
  }

  /**
   * Forward tool_call frames from the Live API to our registered handlers.
   *
   * `transfer_to_owner` stays bridge-local because its latency matters most
   * (the caller is being put through to a human) and the wrapper is a direct
   * Telnyx call. Everything else delegates to the platform app via an HTTP
   * adapter so that Nango credentials, calendar logic, and CRM writes live
   * in one place.
   */
  function handleModelToolCalls(message: LiveServerMessage): void {
    const calls = message.toolCall?.functionCalls;
    if (!calls || calls.length === 0) return;
    for (const call of calls) {
      const name = call.name ?? "unknown";
      if (name === "transfer_to_owner" && opts.transfer) {
        const reason = typeof call.args?.reason === "string" ? (call.args.reason as string) : undefined;
        // `execute` may throw on network-layer failures; catching here stops
        // the unhandled rejection from tearing down every active call on the
        // VPS under Node >= 15.
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
          sendToolResponse(call.id, name, {
            ok: result.ok,
            detail: result.detail ?? (result.ok ? "transfer initiated" : "transfer failed")
          });
        })();
        continue;
      }

      const toolsReady = voiceToolsReady && opts.voiceTools;
      if (toolsReady && voiceToolPath(name)) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        void (async () => {
          const result = await callVoiceTool(
            opts.voiceTools!,
            opts.businessId,
            name,
            args
          );
          sendToolResponse(call.id, name, result);
        })();
        continue;
      }

      sendToolResponse(call.id, name, { ok: false, detail: "tool not available" });
    }
  }

  const { sessionMaxMs, warnBeforeMs, finalNudgeBeforeMs } = opts;
  const name = opts.businessName;
  const warnAt = Math.max(0, sessionMaxMs - warnBeforeMs);
  const nudgeAt = Math.max(0, sessionMaxMs - finalNudgeBeforeMs);

  // Diagnostic heartbeat so production logs show the audio pipeline is still
  // alive throughout the call (or, more usefully, when it stalls). Fires
  // every 15s and is suppressed when no frames moved since the last tick,
  // so a healthy call produces ≤1 heartbeat per 15s and an idle/closing
  // session produces zero. Cleared with the rest of the timers in
  // `clearTimers()`.
  const heartbeat = setInterval(() => {
    if (ended) return;
    const uplinkDelta = diag.uplinkFrames - diag.lastHeartbeatUplinkFrames;
    const downlinkDelta = diag.downlinkFrames - diag.lastHeartbeatDownlinkFrames;
    if (uplinkDelta === 0 && downlinkDelta === 0) return;
    console.log("gemini-bridge: heartbeat", {
      callControlId: opts.callControlId,
      setupComplete: diag.setupCompleteLogged,
      greetingTriggered: diag.greetingTriggered,
      uplinkFrames: diag.uplinkFrames,
      uplinkBytes: diag.uplinkBytesPostHeader,
      uplinkPeakSinceLast: diag.uplinkPeakSampleWindow,
      downlinkFrames: diag.downlinkFrames,
      downlinkBytes: diag.downlinkBytesPostHeader
    });
    diag.lastHeartbeatUplinkFrames = diag.uplinkFrames;
    diag.lastHeartbeatDownlinkFrames = diag.downlinkFrames;
    diag.uplinkPeakSampleWindow = 0;
  }, 15000);
  timers.push(heartbeat as unknown as NodeJS.Timeout);

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

  // Track which non-media event names we've already logged so that
  // start/stop/error/mark frames each surface exactly once per call. Without
  // this guard a chatty client (DTMF + marks + keepalives) could spam the
  // log; without the log entirely, May-2026-style "ring then silence" is
  // hard to distinguish from a normal call where Telnyx sends only marks.
  const seenNonMediaEvents = new Set<string>();
  const onTelnyxMessage = (rawUtf8: string) => {
    if (ended) return;
    // Always JSON.parse and route by event name. A previous fast-path used
    // `rawUtf8.includes('"event":"media"')` to skip the parse, but that
    // substring check breaks the moment Telnyx serializes the frame with
    // whitespace between key and value (`"event": "media"`) — every audio
    // frame would silently land in the non-media branch and be dropped.
    const parsed = parseTelnyxFrame(rawUtf8);
    if (parsed.kind === "unparseable") return;
    if (parsed.kind === "non-media") {
      const eventName = parsed.event;
      if (!seenNonMediaEvents.has(eventName)) {
        seenNonMediaEvents.add(eventName);
        console.log("gemini-bridge: telnyx ws non-media", {
          callControlId: opts.callControlId,
          event: eventName,
          head: rawUtf8.slice(0, 240)
        });
      }
      return;
    }
    const b64 = parsed.payload;
    try {
      // Telnyx delivers an RTP packet (12-byte header + L16 payload) base64'd
      // when `stream_bidirectional_mode` is "rtp". Strip the header so Gemini
      // sees clean PCM, and mirror the observed payload type onto our
      // downlink encoder so Telnyx accepts our synthetic frames.
      const decoded = decodeTelnyxMediaPayload(b64);
      if (decoded.payload.length === 0) return;
      rtpEncoder.adoptPayloadType(decoded.payloadType);
      // One-shot first-frame log so we can confirm Telnyx is delivering
      // the negotiated codec/cadence (640 bytes = 20 ms of L16 16 kHz; the
      // header hex starts with `0xff`/`0x80` for RTP, anything else means
      // raw L16 — both are decoded correctly by `decodeTelnyxMediaPayload`).
      if (!diag.firstUplinkLogged) {
        diag.firstUplinkLogged = true;
        const rawBytes = Buffer.from(b64, "base64");
        console.log("gemini-bridge: first uplink frame", {
          callControlId: opts.callControlId,
          rawBytes: rawBytes.length,
          rawHeaderHex: rawBytes.subarray(0, 16).toString("hex"),
          payloadBytes: decoded.payload.length,
          rtpPayloadType: decoded.payloadType
        });
      }
      diag.uplinkFrames += 1;
      diag.uplinkBytesPostHeader += decoded.payload.length;
      // Track peak amplitude across this heartbeat window. Pure silence
      // stays <100; speech routinely peaks >5000. Reported by the heartbeat
      // tick and reset there.
      if (decoded.payload.length >= 2 && decoded.payload.length % 2 === 0) {
        const samples = new Int16Array(
          decoded.payload.buffer,
          decoded.payload.byteOffset,
          decoded.payload.length / 2
        );
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]!);
          if (a > peak) peak = a;
        }
        if (peak > diag.uplinkPeakSampleWindow) diag.uplinkPeakSampleWindow = peak;
      }
      // Use the modern `audio:` field. Passing `media:` makes the SDK
      // serialize the chunk as `realtime_input.media_chunks`, which the
      // Gemini Live API now closes the WS on with code 1007:
      //   "realtime_input.media_chunks is deprecated.
      //    Use audio, video, or text instead."
      // That's exactly what manifested as "ring then silence" on calls —
      // Gemini accepted ~10 inbound frames, hit the deprecation guard, and
      // hung up before generating any response audio. The SDK's
      // liveSendRealtimeInputParametersToMldev converter routes `audio:`
      // straight to the new server field via `tAudioBlob`.
      session.sendRealtimeInput({
        audio: {
          mimeType: `audio/pcm;rate=${TELNYX_PCM_RATE}`,
          data: decoded.payload.toString("base64")
        }
      });
    } catch (e) {
      console.error("gemini-bridge: uplink", e);
    }
  };

  return { onTelnyxMessage, teardown };
}
