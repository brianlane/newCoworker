import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from "@google/genai";
import { parsePcmRateFromMime, StreamingResampler } from "./audio-resample.js";
import { parseTelnyxFrame, telnyxMediaMessageFromPcmBase64 } from "./telnyx-media-json.js";
import { decodeTelnyxMediaPayload } from "./rtp-frame.js";
import { type VaultSnapshot } from "./vault-loader.js";
import {
  DEFAULT_INTAKE_CAPTURE_FIELDS,
  intakeOpener,
  intakeSystemInstruction,
  type CapturedLead
} from "./intake.js";
import {
  createTranscriptRecorder,
  type TranscriptAdapter,
  type TranscriptRecorder
} from "./voice-transcript.js";
import { readLiveUsage, type GeminiLiveUsage } from "./live-usage.js";
import { buildVoiceToolDeclarations } from "./tool-declarations.js";

export { readLiveUsage, type GeminiLiveUsage };

const TELNYX_PCM_RATE = 16000;
const GEMINI_OUTPUT_DEFAULT_RATE = 24000;

/**
 * Resolved `@google/genai` package version at boot. Persisted in the
 * `voice_bridge_gemini_session_start` telemetry so we can confirm — without
 * SSHing the VPS — which SDK the running container actually has. A major
 * bump (1.x → 2.x) changed the Live API contract and is the prime suspect
 * for the May-2026 "greeting then dead air" regression; this lets us verify
 * a redeploy actually reverted the pin. Resolved defensively: some package
 * `exports` maps don't expose `./package.json`, in which case we report
 * "unknown" rather than crashing the bridge import.
 */
const GENAI_SDK_VERSION: string = (() => {
  const req = createRequire(import.meta.url);
  // 1.x exposed ./package.json directly; try that first.
  try {
    const pkg = req("@google/genai/package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // 2.x tightened its `exports` map and no longer publishes ./package.json,
    // so fall through to resolving the package root from its entry point.
  }
  try {
    let dir = dirname(req.resolve("@google/genai"));
    for (let i = 0; i < 8; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
        if (j.name === "@google/genai" && j.version) return j.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore — reported as "unknown" below
  }
  return "unknown";
})();

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

/**
 * Per-tool overrides for tools whose app-side work is legitimately slower
 * than the default budget — aborting them early is worse than the wait:
 *
 *  - `calendar_book_appointment` COMMITS a provider write. A cold booking
 *    (shared-calendar ensure + Nango proxy to Google/Microsoft) can take
 *    5–10s, and the bridge's abort is client-side only — the app keeps
 *    going and the event gets created anyway. On a real Truly Insurance
 *    call (2026-07-15) the 3.5s abort made the model tell the caller their
 *    chosen time was "no longer available" while the booking silently
 *    succeeded, then book a SECOND slot — a double booking. The model can
 *    narrate ("one moment while I confirm that") so the extra silence is
 *    acceptable for a commit.
 *  - `calendar_find_slots` fans out over provider free/busy reads and was
 *    observed at 2.3–2.8s warm — too close to 3.5s for a cold call.
 */
const TOOL_CALL_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  calendar_book_appointment: 15_000,
  calendar_find_slots: 8_000
};

/**
 * Model-facing guidance when a tool call hits the bridge timeout. Booking
 * gets explicit recovery steps because a timed-out booking may have
 * SUCCEEDED app-side (the abort does not cancel the server's work): the
 * idempotency ledger makes an identical retry safe — it returns the
 * already-created event (`already_booked`) instead of double-booking.
 */
const TOOL_TIMEOUT_MESSAGES: Record<string, string> = {
  calendar_book_appointment:
    "The booking system was slow to respond — the booking may still have completed. Do NOT " +
    "tell the caller the time is unavailable and do NOT pick a different time. Tell the " +
    "caller you're just confirming, then call calendar_book_appointment ONCE more with " +
    "exactly the same arguments: if the first attempt went through you'll get " +
    "already_booked (treat as confirmed), otherwise the retry books it. If the retry also " +
    "times out, call notify_team with the caller's chosen time and say a team member will " +
    "confirm."
};

export type TransferCapability = {
  /** E.164 destination (owner/staff cell). */
  toE164: string;
  /** Called when the model invokes the transfer tool. Resolved value is echoed back to the model. */
  execute: (args: { reason?: string }) => Promise<{ ok: boolean; detail?: string }>;
  /**
   * Detach the AI from the call after a SUCCESSFUL warm transfer: stop the
   * Telnyx media fork so the bridge stops injecting/hearing audio, while the
   * caller stays bridged to the transfer target. MUST NOT hang up the caller's
   * leg (that would drop the human-to-human bridge). Best-effort; the bridge
   * tears the Gemini session down regardless so the AI goes silent either way.
   */
  detach?: () => Promise<{ ok: boolean; detail?: string }>;
  /**
   * Ms to wait after a successful transfer before detaching, so the assistant's
   * brief "connecting you now" line finishes playing first. Defaults to 2000.
   */
  graceMs?: number;
};

/**
 * Lets the assistant hang up the live call once the conversation is genuinely
 * over (the caller said goodbye / there's nothing left to do). When set, the
 * bridge registers an `end_call` tool; on invocation it acknowledges, waits a
 * short grace period so the spoken goodbye plays out, then `execute()` hangs
 * the Telnyx leg up (which closes the media WS and settles the reservation).
 */
export type HangupCapability = {
  /** Hang the Telnyx call up. Resolved value is for logging only. */
  execute: (args: { reason?: string }) => Promise<{ ok: boolean; detail?: string }>;
  /** Ms to wait after the model calls end_call before hanging up (goodbye playout). */
  graceMs?: number;
};

/**
 * HomeLight live-transfer "AI takeover" intake. When set, the bridge runs a
 * dedicated lead-intake persona instead of the receptionist persona: it greets
 * as the owner's office, registers a `capture_lead` tool, and accumulates the
 * lead fields so the caller (index.ts) can text the owner a summary + the
 * transcript after the call. See voice_handoff_chains.ai_takeover.
 */
export type IntakeCapability = {
  /** Opening line / persona the AI worker should lead with. */
  persona?: string;
  /** Lead fields to collect (defaults to name, phone, address, timeframe, notes). */
  captureFields?: string[];
  /**
   * What the AI already KNOWS about the person (a place_ai_call step's
   * rendered contextTemplate) — injected into the system prompt with a
   * never-re-ask rule so the AI doesn't ask for details the flow already
   * extracted.
   */
  contextNote?: string;
  /**
   * place_ai_call live transfer: when true (and the host wired a transfer
   * capability), the intake session ALSO gets the transfer tool — the flow
   * explicitly authorized connecting this callee to a person once they
   * confirm it's a good time. Off for classic HomeLight intake, which is
   * capture-only by design.
   */
  allowTransfer?: boolean;
  /** Display name of the transfer target ("one moment while I get Dave on the line"). */
  transferAgentName?: string;
};

export type { CapturedLead } from "./intake.js";

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

// The system-instruction builder (persona/tool/context prompt composition —
// incl. CallerIdentity and the context-block caps) lives in
// system-instruction.ts so repo-root tests and typecheck can import it
// without this module's VPS-only runtime deps (@google/genai, ws).
// Re-exported so existing importers keep one entry point.
export {
  systemInstructionForBusiness,
  VOICE_CUSTOMER_MEMORY_MAX_CHARS,
  VOICE_FLOW_CONTEXT_MAX_CHARS,
  VOICE_RECENT_INTERACTIONS_MAX_CHARS,
  type CallerIdentity
} from "./system-instruction.js";
import { systemInstructionForBusiness, type CallerIdentity } from "./system-instruction.js";

export type GeminiBridgeOptions = {
  ws: WebSocket;
  businessId: string;
  callControlId: string;
  apiKey: string;
  model: string;
  /** Hard stop for this Live session (ms). */
  sessionMaxMs: number;
  /**
   * True when `sessionMaxMs` is the AI-BUDGET-derived cap (the shared AI budget
   * is nearly exhausted), rather than the normal env time limit. Switches the
   * graceful wind-down wording from "someone can help you afterward" to "the
   * owner isn't available right now, please text us" — we can't fall back to a
   * local model on a live call, so the honest framing is unavailability.
   */
  budgetCapped?: boolean;
  /** First spoken coordinator prompt this many ms before `sessionMaxMs`. */
  warnBeforeMs: number;
  /** Second, firmer coordinator prompt this many ms before `sessionMaxMs`. */
  finalNudgeBeforeMs: number;
  businessName: string;
  /** Business IANA timezone for the date/time prompt line; undefined/null = UTC. */
  businessTimezone?: string | null;
  /** When set, registers a `transfer_to_owner` function tool on the Live session. */
  transfer?: TransferCapability;
  /** When set, registers an `end_call` tool so the assistant can hang up when done. */
  hangup?: HangupCapability;
  /**
   * Whether the business received this call (inbound) or placed it (outbound).
   * Recorded on the transcript so the dashboard can tag the call. Defaults to
   * inbound (the historical behaviour) when omitted.
   */
  direction?: "inbound" | "outbound";
  /**
   * When set, the session runs the HomeLight lead-intake persona instead of the
   * normal receptionist/staff personas (the live client was connected after both
   * Dave and Amy missed the warm transfer). Mutually exclusive with the customer
   * CRM/transfer tools — only `capture_lead` is registered.
   */
  intake?: IntakeCapability;
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
  /**
   * AiFlow context bridge (voice twin of the SMS worker's block): what the
   * business's automations recently collected from / last texted this
   * caller, so the receptionist continues that conversation instead of
   * restarting intake. Built by loadVoiceFlowContext in
   * vps/voice-bridge/src/flow-run-context.ts; clipped here to
   * VOICE_FLOW_CONTEXT_MAX_CHARS (same 12 KB-ceiling discipline as the
   * customer-memory snippet). Undefined = no recent automation activity —
   * the prompt is identical to the pre-bridge shape.
   */
  flowContextNote?: string;
  /**
   * Optional per-caller cross-channel recent-interactions timeline
   * (contact-context.ts loadVoiceContactTimeline): the caller's raw SMS
   * thread + recent call summaries from the last hours, covering the gap
   * where the rolling summary is still empty. Clipped in
   * system-instruction.ts to VOICE_RECENT_INTERACTIONS_MAX_CHARS.
   */
  recentInteractionsNote?: string;
  /**
   * Optional booking-status line (booking-context.ts loadVoiceBookingLine):
   * the caller's live Calendly state fetched from the platform, so a
   * reschedule/cancel made on calendly.com is visible on the call. Clipped
   * in system-instruction.ts to VOICE_BOOKING_STATUS_MAX_CHARS. Undefined =
   * no booking context — the prompt is identical to the pre-feature shape.
   */
  bookingStatusNote?: string;
  /**
   * Who the caller is (owner / team member / customer). When the caller is
   * staff, the system instruction switches from the customer receptionist
   * script to an internal-assistant persona — same intent as the SMS worker's
   * team/owner gate. Undefined is treated as a customer (backwards compatible).
   */
  callerIdentity?: CallerIdentity;
  /**
   * Optional diagnostics sink. When set, the bridge emits a structured
   * timeline of Gemini Live lifecycle events (session start, setup complete,
   * greeting sent, error, close, teardown) including the close code/reason and
   * audio frame counters. Wired in index.ts to `telemetry_record` so the
   * timeline lands in `telemetry_events` and can be queried after a test call
   * — the VPS stdout where these previously lived is not reachable from here.
   * Implementations MUST NOT throw; the bridge invokes this defensively but
   * a throwing sink should never tear down a live call.
   */
  recordDiag?: (eventType: string, payload: Record<string, unknown>) => void;
};

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
  telemetry: DownlinkTelemetry
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
  // Telnyx's `stream_bidirectional_mode: "rtp"` `media.payload` is the base64
  // RTP *payload* — raw codec samples with NO 12-byte RTP header. The Telnyx
  // media-streaming spec says so explicitly ("base64-encoded RTP payload
  // without RTP headers") and it's symmetric with the inbound frames, which we
  // already consume as header-less raw L16. Prepending an RTP header here made
  // Telnyx render the 12 header bytes as 6 L16 samples of noise at the start of
  // every chunk — an audible click/"typing" sound under the assistant's voice.
  // Send the raw little-endian L16 samples (16 kHz, mono) instead.
  const audio = Buffer.from(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength);
  ws.send(telnyxMediaMessageFromPcmBase64(audio.toString("base64")));
}

// ---------------------------------------------------------------------------
// Voice tool adapters — HTTP calls into the platform Next.js app.
// ---------------------------------------------------------------------------

type ToolResult = { ok: boolean; detail?: string; data?: unknown; message?: string };

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
    case "notify_team":
      return "/api/voice/tools/notify-team";
    // Phase 5: cross-channel customer memory tools. The agent uses
    // these to recognize repeat callers and persist owner-pinned facts
    // beyond the rolling auto-summary.
    case "customer_lookup_by_phone":
      return "/api/voice/tools/customer-lookup";
    case "customer_set_display_name":
      return "/api/voice/tools/customer-set-display-name";
    case "customer_append_pinned_note":
      return "/api/voice/tools/customer-append-pinned-note";
    // Business documents: text the caller an expiring link to a
    // client-facing document (audience + expiration enforced server-side).
    case "document_share":
      return "/api/voice/tools/document-share";
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
  const timeoutMs = TOOL_CALL_TIMEOUT_OVERRIDES_MS[toolName] ?? TOOL_CALL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const typed = parsed as { ok: boolean; detail?: string; data?: unknown; message?: string };
      return {
        ok: Boolean(typed.ok),
        detail: typed.detail,
        data: typed.data,
        // Model-facing guidance the app routes attach on notable outcomes
        // (booking failed / already_booked / in-progress). Dropping it here
        // left Gemini with a bare detail code and no recovery steps.
        ...(typeof typed.message === "string" ? { message: typed.message } : {})
      };
    }
    return { ok: true, data: parsed ?? undefined };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const message = TOOL_TIMEOUT_MESSAGES[toolName];
      return { ok: false, detail: "timeout", ...(message ? { message } : {}) };
    }
    return {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 120) : "network_error"
    };
  } finally {
    clearTimeout(timer);
  }
}

// buildVoiceToolDeclarations moved to tool-declarations.ts (dependency-free
// module) so repo-root e2e tests can exercise the REAL declarations without
// the bridge's VPS-only runtime deps. Import at the top of this file.

/**
 * Gemini Live (native audio) ↔ Telnyx bidirectional L16 @16 kHz JSON media frames.
 */
export async function createGeminiTelnyxBridge(opts: GeminiBridgeOptions): Promise<{
  onTelnyxMessage: (rawUtf8: string) => void;
  teardown: () => Promise<void>;
  /** Lead fields captured during a HomeLight intake call (empty otherwise). */
  getLead: () => CapturedLead;
  /**
   * Final cumulative Gemini Live token usage (modality-split) for this session,
   * or null if the model never reported `usageMetadata`. Read at session end by
   * index.ts to meter the spend into the shared AI budget.
   */
  getUsage: () => GeminiLiveUsage | null;
}> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  let ended = false;
  // Latest cumulative usage frame seen from Gemini Live (running session
  // totals). Kept by max totalTokens so a trailing zero/partial frame can't
  // clobber the real count; metered once at session end.
  let latestUsage: GeminiLiveUsage | null = null;
  // Set once the model invokes `end_call` so a repeated/duplicate call can't
  // schedule two hangups (the second would race teardown on a dead leg).
  let endCallRequested = false;
  // Set once a warm transfer succeeds so we detach the AI exactly once (a
  // duplicate transfer tool-call can't schedule two teardowns).
  let transferDetachRequested = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const downlinkTelemetry: DownlinkTelemetry = {
    droppedFrames: 0,
    lastDropWarnAtMs: 0
  };
  // Per-call streaming resampler for the Gemini (24 kHz) → Telnyx (16 kHz)
  // downlink. Stateful across chunks so the phase stays continuous — a stateless
  // per-chunk resample injects a step discontinuity at every chunk boundary,
  // which is audible as a periodic click/"typing" sound during AI speech.
  // Lazily constructed on the first chunk so it locks onto the model's actual
  // output rate (parsed from the chunk mime type), and rebuilt if that changes.
  let downlinkResampler: StreamingResampler | null = null;
  // Uplink framing is a per-stream property, but the only per-frame signal is
  // the RTP V=2 bits in byte 0 — which raw L16 sample bytes hit ~25% of the
  // time, causing sporadic header-mis-strips that ship malformed PCM to Gemini
  // (WS 1007). Decide the mode by majority vote over the first frames, then
  // lock: a single ambiguous first frame (e.g. a header-only RTP packet, which
  // the decoder reports as wasRtp:false) can't mislock the stream, and a real
  // RTP stream votes ~100% RTP while raw L16's coincidental false positives
  // stay a clear minority. Until locked we honor the per-frame decision (the
  // carry guard below keeps that 1007-safe either way).
  const UPLINK_MODE_LOCK_FRAMES = 25;
  let uplinkRtpMode: boolean | null = null;
  let uplinkRtpVotes = 0;
  let uplinkFramesForVote = 0;
  // Gemini Live's L16 input must be a whole number of 16-bit samples. If a
  // decoded frame ever has an odd byte length we hold the trailing byte and
  // prepend it to the next frame, keeping perfect sample alignment instead of
  // dropping audio. (Belt-and-suspenders behind the mode lock above.)
  let uplinkCarryByte: Buffer | null = null;
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

  // Defensive diagnostics emitter. Snapshots the live pipeline counters into
  // every event so a single telemetry row tells the whole story (did setup
  // complete? did the greeting fire? how many frames moved before the close?).
  // Never throws — a broken sink must not affect the call.
  const emitDiag = (eventType: string, extra: Record<string, unknown> = {}): void => {
    if (!opts.recordDiag) return;
    try {
      opts.recordDiag(eventType, {
        setup_complete: diag.setupCompleteLogged,
        greeting_triggered: diag.greetingTriggered,
        uplink_frames: diag.uplinkFrames,
        downlink_frames: diag.downlinkFrames,
        dropped_frames: downlinkTelemetry.droppedFrames,
        ...extra
      });
    } catch (err) {
      console.error("gemini-bridge: recordDiag threw", err);
    }
  };

  // Compact, bounded trail of Gemini Live message/send tags. The 1007
  // "invalid argument" close that kills calls after the greeting can't be
  // reproduced synthetically, so we record what actually crosses the wire
  // (tool calls, tool responses, server-content flags, goAway) and emit the
  // whole trail on close. Capped so a long call can't grow it unbounded.
  const msgTrail: string[] = [];
  const pushTrail = (tag: string): void => {
    msgTrail.push(tag);
    if (msgTrail.length > 60) msgTrail.shift();
  };

  // Outbound-frame tap (debug): the 1007 invalid-argument kill is on a message
  // WE send to Gemini, but it can't be reproduced synthetically. Tap the Live
  // session's own WebSocket `send` so the trail shows exactly which frames went
  // out (and in what order) right before the close. We record frame *kind* +
  // size only — never the base64 audio or caller PII.
  const sendTrail: string[] = [];
  const pushSend = (tag: string): void => {
    sendTrail.push(tag);
    if (sendTrail.length > 40) sendTrail.shift();
  };
  const tapSessionSocket = (sess: Session): void => {
    try {
      const holder = sess as unknown as { conn?: { send?: unknown }; ws?: { send?: unknown } };
      const sock =
        holder.conn && typeof holder.conn.send === "function"
          ? holder.conn
          : holder.ws && typeof holder.ws.send === "function"
            ? holder.ws
            : null;
      if (!sock) {
        pushSend("no-socket");
        return;
      }
      const target = sock as { send: (...a: unknown[]) => unknown };
      const orig = target.send.bind(target);
      target.send = (...args: unknown[]) => {
        try {
          const data = args[0];
          if (typeof data === "string") {
            if (data.includes("realtimeInput") || data.includes("realtime_input")) pushSend("rt:" + data.length);
            else if (data.includes("clientContent") || data.includes("client_content")) pushSend("cc:" + data.length);
            else if (data.includes("toolResponse") || data.includes("tool_response")) pushSend("tr:" + data.length);
            else if (data.includes("setup")) pushSend("setup:" + data.length);
            else pushSend("other:" + data.slice(0, 60));
          } else {
            pushSend("bin:" + (data && typeof (data as { length?: number }).length === "number" ? (data as { length: number }).length : "?"));
          }
        } catch {
          /* never let the tap break the send */
        }
        return orig(...args);
      };
    } catch (err) {
      pushSend("tap-failed:" + (err instanceof Error ? err.message : String(err)));
    }
  };

  const voiceToolsReady =
    Boolean(opts.voiceTools?.appBaseUrl) && Boolean(opts.voiceTools?.gatewayToken);

  const transcriptRecorder: TranscriptRecorder | null = opts.transcriptAdapter
    ? createTranscriptRecorder(opts.transcriptAdapter, {
        businessId: opts.businessId,
        callControlId: opts.callControlId,
        callerE164: opts.callerE164 ?? "",
        model: opts.model,
        direction: opts.direction ?? "inbound"
      })
    : null;

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };

  let session!: Session;
  // The greeting cue races session assignment: Gemini can deliver
  // `setupComplete` while `ai.live.connect` is still awaiting (the SDK calls
  // onmessage from inside connect), so the handler may run before `session`
  // is assigned. These flags let the handler defer the cue to right after
  // connect resolves instead of throwing on an undefined session.
  let sessionAssigned = false;
  let greetingPending = false;

  /**
   * Prompt the model to speak its opening line. Idempotent (greetingTriggered)
   * and only called with `session` assigned.
   *
   * This MUST go through `sendRealtimeInput({ text })`, not
   * `sendClientContent`. The caller's audio is streamed via
   * `sendRealtimeInput` with Gemini's automatic VAD, so the whole session
   * lives in the "realtime" turn regime. Injecting a manual
   * `sendClientContent` turn mixes the two turn models: the greeting turn
   * itself succeeds, but the *next* auto-VAD turn (the caller's first real
   * reply) is then rejected by the server with WS close 1007 "Request
   * contains an invalid argument." — i.e. the AI speaks its opening line and
   * the call dies the moment the caller answers. `sendRealtimeInput({ text })`
   * injects the greeting cue inside the realtime stream, keeping every turn
   * consistent.
   */
  const sendGreetingCue = (): void => {
    if (diag.greetingTriggered) return;
    diag.greetingTriggered = true;
    try {
      const greetIdentity = opts.callerIdentity;
      const greetIsStaff = greetIdentity != null && greetIdentity.kind !== "customer";
      let greetingText: string;
      if (intake) {
        const outboundIntake = intake.allowTransfer || opts.direction === "outbound";
        // Shared with intakeSystemInstruction so the cue can never quote a
        // different opening line than the system prompt scripted.
        const opener = intakeOpener(
          opts.businessName,
          intake.persona,
          outboundIntake ? "outbound" : "inbound"
        );
        // "Only once / never restart" mirrors the system instruction's
        // barge-in guard on every variant. A transfer-enabled session
        // follows its call script; a plain outbound call runs its capture
        // checklist WITHOUT the callback-number ask (we just dialed their
        // number); the inbound seller intake keeps the full checklist.
        greetingText = intake.allowTransfer
          ? `[Coordinator — speak aloud now] The person has just answered the phone. Say your opening line ONCE ("${opener}"), then stop and listen — never repeat the opener, even if they talk over it — and follow your call script.`
          : opts.direction === "outbound"
            ? `[Coordinator — speak aloud now] The person has just answered the phone. Say your opening line ONCE ("${opener}"), then stop and listen — never repeat the opener, even if they talk over it — and continue per your instructions, calling capture_lead as you learn details. Never ask for their phone number.`
            : `[Coordinator — speak aloud now] A seller lead has just been connected. Greet them warmly with your opening line ("${opener}") — say it only once, never restart it — and begin the short intake — get their name, callback number, property address, and timeframe, calling capture_lead as you go.`;
      } else if (greetIsStaff) {
        // Owner vs team wording, and handle staff WITHOUT a stored name
        // (otherwise they'd get the customer receptionist greeting that
        // contradicts the staff system instruction).
        const staffName = greetIdentity!.name?.trim();
        const role =
          greetIdentity!.kind === "owner" ? "the business owner" : "a member of the team";
        const subject = staffName
          ? `${staffName} (${role}, not a customer)`
          : `${role} (not a customer)`;
        const example = staffName
          ? `e.g. "Hey ${staffName}, what can I do for you?"`
          : `e.g. "Hey, what can I do for you?"`;
        greetingText = `[Coordinator — speak aloud now] ${subject} has just connected. Greet them warmly${staffName ? " by name" : ""} in one short sentence (${example}) — do not run the customer intake script — and wait for their reply.`;
      } else {
        greetingText = `[Coordinator — speak aloud now] The caller has just connected. Greet them warmly in one short sentence (e.g. "Hi, thanks for calling ${opts.businessName} — how can I help?") and wait for their reply.`;
      }
      session.sendRealtimeInput({ text: greetingText });
      console.log("gemini-bridge: greeting prompt sent", {
        callControlId: opts.callControlId
      });
      emitDiag("voice_bridge_gemini_greeting_sent", { method: "sendRealtimeInput" });
    } catch (err) {
      console.error("gemini-bridge: greeting prompt failed", err);
      emitDiag("voice_bridge_gemini_greeting_failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

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
    emitDiag("voice_bridge_gemini_teardown", {
      ended_flag_prior_to_teardown: ended,
      uplink_bytes: diag.uplinkBytesPostHeader,
      downlink_bytes: diag.downlinkBytesPostHeader
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

  const intake = opts.intake;
  // On a call WE placed (outbound / place_ai_call transfer), the never-ask-
  // for-their-number rule extends to the tool surface: "phone" is filtered
  // out of the capture schema so the tool itself can't prompt the model to
  // ask for a callback number (empty after filtering degrades to notes,
  // mirroring intakeSystemInstruction). Inbound keeps the full default set.
  const intakeIsOutbound = Boolean(intake?.allowTransfer) || opts.direction === "outbound";
  const configuredCaptureFields =
    intake?.captureFields && intake.captureFields.length > 0
      ? intake.captureFields
      : DEFAULT_INTAKE_CAPTURE_FIELDS;
  const outboundCaptureFields = configuredCaptureFields.filter(
    (f) => f.trim().toLowerCase() !== "phone"
  );
  const intakeCaptureFields = intakeIsOutbound
    ? outboundCaptureFields.length > 0
      ? outboundCaptureFields
      : ["notes"]
    : configuredCaptureFields;
  // Lead fields accumulated from `capture_lead` calls; surfaced via getLead()
  // so index.ts can text the owner a structured summary after the call.
  const leadData: CapturedLead = {};

  const declarations: Array<{ name: string; description: string; parameters: unknown }> = [];
  if (intake) {
    // Intake sessions get ONLY the capture tool — no transfer / customer CRM
    // tools. The lead is being captured for a manual call-back, not bridged.
    // Build the schema from the chain's configured capture_fields so a tenant
    // that adds/changes fields can actually persist them (the tool handler and
    // post-call SMS already key off intakeCaptureFields).
    const KNOWN_FIELD_DESCRIPTIONS: Record<string, string> = {
      name: "Seller's full name.",
      // Outbound sessions never carry a "phone" field (filtered above), so
      // this callback wording can only surface on inbound intake.
      phone: "Best callback phone number.",
      address: "Property address they're selling.",
      timeframe: "Roughly when they want to sell (e.g. 'ASAP', '3 months', '6-12 months').",
      notes: "Anything else useful — price expectations, motivation, condition, constraints."
    };
    const captureProperties: Record<string, { type: Type; description: string }> = {};
    for (const field of intakeCaptureFields) {
      captureProperties[field] = {
        type: Type.STRING,
        description: KNOWN_FIELD_DESCRIPTIONS[field] ?? `The lead's ${field}.`
      };
    }
    declarations.push({
      name: "capture_lead",
      description: intakeIsOutbound
        ? "Record details you learn on this call for the office's follow-up notes. Call as soon as you learn any field, and again as you learn more. Always call before saying goodbye. Never ask for their phone number — you called them on it."
        : "Record details about this seller lead so the owner can call them back. Call as soon as you learn any field, and again as you learn more. Always call before saying goodbye.",
      parameters: {
        type: Type.OBJECT,
        properties: captureProperties,
        required: []
      }
    });
  }
  // The transfer tool: receptionist/staff sessions get the classic
  // ask-for-a-human wording; an intake session gets it ONLY when the flow
  // explicitly authorized a live transfer (place_ai_call), with wording tied
  // to the "is now a good time?" confirmation instead of caller escalation.
  if (opts.transfer && (!intake || intake.allowTransfer)) {
    const transferTargetName = intake?.transferAgentName?.trim();
    declarations.push({
      name: "transfer_to_owner",
      description: intake
        ? `Warm-transfer this live call to ${transferTargetName || "the team member handling this lead"}. Call ONLY after the person confirms that now is a good time to talk. Before calling this tool, tell them one moment while you get ${transferTargetName || "the right person"} on the line.`
        : "Warm-transfer the live phone call to the business owner/staff. Call ONLY when the caller explicitly asks for a human, indicates urgency, or raises a matter you cannot handle. Before calling this tool, briefly reassure the caller you're connecting them now.",
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
  // Staff (owner/team) callers are NOT customers: never register the customer
  // CRM tools for their session. Relying on the prompt alone ("don't use these")
  // still lets the model call them and create/edit a customer_memories profile
  // for a staff number. Withholding the declarations makes that impossible.
  const callerIsStaff =
    opts.callerIdentity != null && opts.callerIdentity.kind !== "customer";
  const STAFF_EXCLUDED_TOOLS = new Set([
    "capture_caller_details",
    "customer_lookup_by_phone",
    "customer_set_display_name",
    "customer_append_pinned_note"
  ]);
  if (!intake && voiceToolsReady) {
    for (const decl of buildVoiceToolDeclarations()) {
      if (callerIsStaff && STAFF_EXCLUDED_TOOLS.has(decl.name)) continue;
      declarations.push(decl);
    }
  }
  // `end_call` is available to every persona (receptionist, staff, and intake)
  // whenever the host wired a hangup capability — so the assistant can cleanly
  // end any call once it's over instead of leaving dead air on the line.
  const hasEndCall = Boolean(opts.hangup);
  if (hasEndCall) {
    declarations.push({
      name: "end_call",
      description:
        "Hang up the live phone call. Call this ONLY when the conversation is genuinely over (the caller said goodbye, confirmed they're all set, or there's nothing left to do) and AFTER you have spoken a brief goodbye. Never call it mid-conversation.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          reason: {
            type: Type.STRING,
            description: "One short phrase on why the call is ending (e.g. 'caller said goodbye')."
          }
        },
        required: []
      }
    });
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

  // Enterprise voice picker: a prebuilt Gemini Live voice name written into
  // the bridge .env by deploy-client.sh (VOICE_NAME, validated app-side
  // against the prebuilt-voice allow-list). Blank keeps the model default.
  const voiceName = (process.env.VOICE_NAME ?? "").trim();
  const speechConfig = voiceName
    ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } }
    : {};

  session = await ai.live.connect({
    model: opts.model,
    config: {
      responseModalities: [Modality.AUDIO],
      ...(speechConfig as Record<string, unknown>),
      ...(transcriptionConfig as Record<string, unknown>),
      systemInstruction: intake
        ? intakeSystemInstruction(
            opts.businessName,
            intake.persona,
            opts.businessTimezone,
            intakeCaptureFields,
            hasEndCall,
            intake.allowTransfer ? { agentName: intake.transferAgentName } : undefined,
            opts.direction === "outbound",
            intake.contextNote
          )
        : systemInstructionForBusiness(
            opts.businessName,
            Boolean(opts.transfer),
            voiceToolsReady,
            opts.vault,
            opts.customerMemorySummary,
            opts.businessTimezone,
            opts.callerIdentity,
            hasEndCall,
            opts.flowContextNote,
            opts.recentInteractionsNote,
            opts.bookingStatusNote
          ),
      tools: toolsForSession
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        if (ended || opts.ws.readyState !== WebSocket.OPEN) return;
        // Capture cumulative token usage for billing. Gemini Live reports
        // running session totals, so keep the frame with the largest total —
        // metered once at teardown by index.ts (see getUsage()).
        {
          const u = readLiveUsage(message);
          if (u && (latestUsage === null || u.totalTokens >= latestUsage.totalTokens)) {
            latestUsage = u;
          }
        }
        // Message tap (debug): classify what Gemini sends so the trail emitted
        // on close shows the exact sequence leading to the 1007 invalid-argument
        // kill. Kept allocation-light; only tags are recorded, not payloads.
        {
          const m = message as unknown as {
            setupComplete?: unknown;
            toolCall?: { functionCalls?: Array<{ name?: string }> };
            toolCallCancellation?: unknown;
            goAway?: { timeLeft?: unknown };
            serverContent?: {
              interrupted?: unknown;
              turnComplete?: unknown;
              generationComplete?: unknown;
              modelTurn?: { parts?: unknown[] };
            };
          };
          if (m.setupComplete) pushTrail("setup");
          const tcNames = m.toolCall?.functionCalls?.map((c) => c.name ?? "?").join("+");
          if (tcNames) pushTrail("toolCall:" + tcNames);
          if (m.toolCallCancellation) pushTrail("toolCancel");
          if (m.goAway) {
            pushTrail("goAway");
            emitDiag("voice_bridge_gemini_go_away", {
              time_left: typeof m.goAway.timeLeft === "string" ? m.goAway.timeLeft : JSON.stringify(m.goAway.timeLeft ?? null)
            });
          }
          const sc = m.serverContent;
          if (sc) {
            const hasAudio = Array.isArray(sc.modelTurn?.parts) && sc.modelTurn!.parts!.length > 0;
            if (sc.interrupted) pushTrail("interrupted");
            if (hasAudio) pushTrail("modelAudio");
            if (sc.generationComplete) pushTrail("genComplete");
            if (sc.turnComplete) pushTrail("turnComplete");
          }
        }
        if (!diag.setupCompleteLogged && message.setupComplete) {
          diag.setupCompleteLogged = true;
          console.log("gemini-bridge: setupComplete", { callControlId: opts.callControlId });
          emitDiag("voice_bridge_gemini_setup_complete");
          // Gemini Live waits for the user to speak by default. On a phone
          // call the caller expects the assistant to greet first — without
          // this nudge they hear silence after ringback (no audio activity
          // means VAD never marks a turn complete and the model stays mute).
          //
          // `setupComplete` can be delivered WHILE `ai.live.connect` is still
          // awaiting (the SDK invokes onmessage from inside connect), i.e.
          // before the outer `session` variable is assigned — sending here
          // would throw and the caller would sit in silence until VAD picks
          // up their voice (the 45-seconds-of-dead-air bug on outbound
          // calls, Jul 15 2026). Defer to sendGreetingCue(), which runs now
          // when the session is already assigned, or right after connect
          // resolves otherwise.
          if (sessionAssigned) {
            sendGreetingCue();
          } else {
            greetingPending = true;
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
            if (!downlinkResampler || !downlinkResampler.matchesRate(inRate)) {
              downlinkResampler = new StreamingResampler(inRate, TELNYX_PCM_RATE);
            }
            const outSamples = downlinkResampler.process(inSamples);
            if (outSamples.length === 0) continue;
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
            sendPcmToTelnyx(opts.ws, outSamples, downlinkTelemetry);
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
        emitDiag("voice_bridge_gemini_error", {
          message: e?.message ?? String(e)
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
        emitDiag("voice_bridge_gemini_close", {
          code: e?.code ?? null,
          reason: e?.reason ?? null,
          was_clean: e?.wasClean ?? null,
          msg_trail: msgTrail.join(","),
          send_trail: sendTrail.slice(-16).join(",")
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

  sessionAssigned = true;
  // Flush a greeting cue that raced connect: `setupComplete` frequently
  // arrives while `ai.live.connect` is still awaiting (the SDK dispatches
  // onmessage from inside connect), in which case the handler deferred the
  // cue because `session` wasn't assigned yet. Send it now — without this
  // the callee hears silence until VAD reacts to THEIR voice.
  if (greetingPending) {
    greetingPending = false;
    sendGreetingCue();
  }

  // Tap the Live session's outbound WebSocket so the close telemetry shows the
  // exact frame sequence we sent (debug for the unreproducible 1007).
  tapSessionSocket(session);

  // Live session connected. Record the SDK version + model + capability flags
  // so a single telemetry row confirms exactly what code path this call took
  // (and which @google/genai is deployed — the regression suspect).
  emitDiag("voice_bridge_gemini_session_start", {
    sdk_version: GENAI_SDK_VERSION,
    model: opts.model,
    transcription_enabled: Boolean(transcriptRecorder),
    transfer_enabled: Boolean(opts.transfer),
    voice_tools_ready: voiceToolsReady,
    session_max_ms: opts.sessionMaxMs,
    budget_capped: Boolean(opts.budgetCapped)
  });

  function sendToolResponse(id: string | undefined, name: string, response: ToolResult): void {
    // Debug: capture exactly what we send back to Gemini for each tool. The
    // 1007 invalid-argument kill happens right around the tool round trip and
    // can't be reproduced synthetically, so we log the response shape (types,
    // not full PII) to catch a malformed functionResponse payload.
    let dataType = "none";
    if (response.data !== undefined) {
      dataType = Array.isArray(response.data) ? "array" : typeof response.data;
    }
    emitDiag("voice_bridge_gemini_tool_response", {
      name,
      has_id: Boolean(id),
      ok: response.ok,
      detail: typeof response.detail === "string" ? response.detail.slice(0, 120) : null,
      data_type: dataType,
      data_keys:
        response.data && typeof response.data === "object" && !Array.isArray(response.data)
          ? Object.keys(response.data as Record<string, unknown>).slice(0, 20)
          : null
    });
    pushTrail("toolResp:" + name);
    try {
      session.sendToolResponse({
        functionResponses: [
          {
            id,
            name,
            response: {
              ok: response.ok,
              detail: response.detail ?? (response.ok ? "ok" : "error"),
              ...(typeof response.message === "string" ? { message: response.message } : {}),
              ...(response.data !== undefined ? { data: response.data } : {})
            }
          }
        ]
      });
    } catch (err) {
      console.error("gemini-bridge: sendToolResponse failed", { name, err });
      emitDiag("voice_bridge_gemini_tool_response_throw", {
        name,
        error: err instanceof Error ? err.message : String(err)
      });
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
      // Debug: which tool the model invoked + its arg keys (not values, to
      // limit PII). Pinpoints whether a specific tool triggers the 1007.
      emitDiag("voice_bridge_gemini_tool_call", {
        name,
        has_id: Boolean(call.id),
        arg_keys: call.args && typeof call.args === "object" ? Object.keys(call.args).slice(0, 20) : []
      });
      if (name === "capture_lead" && intake) {
        // Bridge-local: merge the captured fields so getLead() can return them
        // for the post-call SMS. Non-empty string values only.
        const args = (call.args ?? {}) as Record<string, unknown>;
        const merged: string[] = [];
        for (const field of intakeCaptureFields) {
          const v = args[field];
          if (typeof v === "string" && v.trim()) {
            leadData[field] = v.trim();
            merged.push(field);
          }
        }
        sendToolResponse(call.id, name, {
          ok: merged.length > 0,
          detail: merged.length > 0 ? `captured: ${merged.join(", ")}` : "empty_capture"
        });
        continue;
      }

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
          // On a SUCCESSFUL warm transfer the caller is now bridged to a human,
          // so the AI must leave the line — otherwise it keeps injecting audio
          // into (and hearing) the bridged leg, talking over both parties. We
          // detach instead of hanging up: hanging up `callControlId` would drop
          // the caller's leg and kill the human-to-human bridge.
          if (result.ok && !transferDetachRequested) {
            transferDetachRequested = true;
            const graceMs = opts.transfer!.graceMs ?? 2000;
            // STANDALONE timer (not pushed to `timers`): teardown/clearTimers
            // must not cancel the detach, mirroring the end_call grace timer.
            setTimeout(() => {
              void (async () => {
                try {
                  if (opts.transfer!.detach) {
                    const d = await opts.transfer!.detach();
                    if (!d.ok) {
                      console.error("gemini-bridge: transfer detach failed", d.detail);
                      emitDiag("voice_bridge_transfer_detach_failed", { detail: d.detail ?? null });
                    } else {
                      emitDiag("voice_bridge_transfer_detach", { reason: reason ?? null });
                    }
                  } else {
                    emitDiag("voice_bridge_transfer_detach", { reason: reason ?? null });
                  }
                } catch (err) {
                  console.error("gemini-bridge: transfer detach threw", err);
                } finally {
                  // Close the Gemini session + finalize the transcript so the AI
                  // goes silent and the transcript captures everything up to the
                  // handoff. teardown is idempotent and does NOT hang up the leg.
                  await teardown();
                }
              })();
            }, graceMs);
          }
        })();
        continue;
      }

      if (name === "end_call" && opts.hangup) {
        const reason =
          typeof call.args?.reason === "string" ? (call.args.reason as string) : undefined;
        // Acknowledge immediately so the model's turn completes cleanly, then
        // hang up after a short grace so the spoken goodbye finishes playing.
        sendToolResponse(call.id, name, { ok: true, detail: "ending call" });
        if (!endCallRequested) {
          endCallRequested = true;
          const graceMs = opts.hangup.graceMs ?? 3000;
          // Deliberately a STANDALONE timer — NOT pushed to `timers`. The PSTN
          // leg is still up during the goodbye grace, so the hangup MUST survive
          // a clearTimers() (which fires on Gemini Live `onclose` and on
          // session-limit teardown). If the Live session drops mid-grace we
          // still need to hang the caller up rather than leave a live, silent
          // leg billing against the reservation.
          setTimeout(() => {
            void (async () => {
              try {
                const result = await opts.hangup!.execute({ reason });
                if (!result.ok) {
                  console.error("gemini-bridge: end_call hangup failed", result.detail);
                  emitDiag("voice_bridge_end_call_failed", { detail: result.detail ?? null });
                } else {
                  emitDiag("voice_bridge_end_call", { reason: reason ?? null });
                }
              } catch (err) {
                console.error("gemini-bridge: end_call execute threw", err);
              } finally {
                // Tear down regardless: even if the Telnyx hangup failed, the
                // model believes the call is over, so don't keep the Live
                // session (and its billing) open. teardown is idempotent.
                await teardown();
              }
            })();
          }, graceMs);
        }
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
  const budgetCapped = Boolean(opts.budgetCapped);
  // Scale the lead-in offsets to the ACTUAL session length. A budget-capped
  // session can be shorter than the default 60s `warnBeforeMs`, which would make
  // `sessionMaxMs - warnBeforeMs` clamp to 0 and fire the "start wrapping up" cue
  // immediately at answer — right over the greeting. Cap the warn lead-in to half
  // the session and the final-nudge lead-in to a quarter so the wind-down always
  // lands near the end, with the greeting given room first. (For a normal
  // ~14-minute session these mins are no-ops.)
  const effWarnBeforeMs = Math.min(warnBeforeMs, Math.floor(sessionMaxMs / 2));
  const effFinalNudgeBeforeMs = Math.min(finalNudgeBeforeMs, Math.floor(sessionMaxMs / 4));
  const warnAt = Math.max(0, sessionMaxMs - effWarnBeforeMs);
  const nudgeAt = Math.max(0, sessionMaxMs - effFinalNudgeBeforeMs);

  // Wind-down coordinator cues. When the binding limit is the AI BUDGET (not the
  // normal time cap) we can't offer "the assistant can keep helping" or "someone
  // will help you right after" — the AI genuinely can't continue — so we frame
  // it as the owner being unavailable and steer the caller to text instead.
  const warnText = budgetCapped
    ? `[Coordinator — speak aloud] You need to start wrapping up this call now. Warmly let the caller know you have to go shortly and that the owner isn't available right now, and invite them to send ${name} a text message so someone can follow up.`
    : `[Coordinator — speak aloud] The AI session will end in about ${Math.max(1, Math.round(effWarnBeforeMs / 60000))} minute(s). Give the caller a warm heads-up that you're wrapping up, and that ${name} can help them directly afterward if needed.`;
  const nudgeText = budgetCapped
    ? `[Coordinator — speak aloud] Finish your thought and give a very brief, warm goodbye now. Let them know the owner isn't available right now and that they can text ${name} and someone will get back to them.`
    : `[Coordinator — speak aloud] Finish your thought and deliver a very brief, warm goodbye now. Let them know someone at ${name} can follow up if they still need help.`;
  const finalText = budgetCapped
    ? `[Coordinator — speak aloud] Wrap up immediately. Say one short, friendly goodbye — the owner isn't available right now, so invite them to text ${name} — and thank them for calling.`
    : `[Coordinator — speak aloud] Session time limit reached. Say one short, friendly goodbye and thank them for calling ${name}.`;

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
      // Realtime text (not sendClientContent) so this coordinator cue stays in
      // the same auto-VAD turn regime as the caller's audio; a manual turn here
      // would make the caller's next reply close the session with 1007.
      session.sendRealtimeInput({ text: warnText });
    }, warnAt)
  );

  timers.push(
    setTimeout(() => {
      if (ended) return;
      session.sendRealtimeInput({ text: nudgeText });
    }, nudgeAt)
  );

  timers.push(
    setTimeout(() => {
      if (ended) return;
      void (async () => {
        try {
          session.sendRealtimeInput({ text: finalText });
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
      // Tally votes until we lock the per-stream framing mode (see the
      // declaration above for why a single-frame lock is unsafe).
      if (uplinkRtpMode === null) {
        uplinkFramesForVote += 1;
        if (decoded.wasRtp) uplinkRtpVotes += 1;
        if (uplinkFramesForVote >= UPLINK_MODE_LOCK_FRAMES) {
          uplinkRtpMode = uplinkRtpVotes * 2 >= uplinkFramesForVote;
        }
      }
      // Strip only when the stream is (or is leaning) RTP AND this specific
      // frame actually decoded as RTP — never strip a frame the decoder
      // couldn't parse as RTP.
      const stripThisFrame = (uplinkRtpMode ?? decoded.wasRtp) && decoded.wasRtp;
      let payload = stripThisFrame ? decoded.payload : Buffer.from(b64, "base64");
      if (payload.length === 0) return;
      // Guarantee whole 16-bit samples to Gemini. Prepend any carried-over odd
      // byte from the previous frame, then carry this frame's trailing byte if
      // the running length is odd. This is the definitive guard against the
      // 1007 "invalid argument" close caused by half-sample PCM chunks.
      if (uplinkCarryByte) {
        payload = Buffer.concat([uplinkCarryByte, payload]);
        uplinkCarryByte = null;
      }
      if (payload.length % 2 !== 0) {
        uplinkCarryByte = Buffer.from([payload[payload.length - 1]!]);
        payload = payload.subarray(0, payload.length - 1);
      }
      if (payload.length === 0) return;
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
          payloadBytes: payload.length,
          frameWasRtp: decoded.wasRtp,
          strippedThisFrame: stripThisFrame,
          rtpPayloadType: decoded.payloadType
        });
      }
      diag.uplinkFrames += 1;
      diag.uplinkBytesPostHeader += payload.length;
      // Track peak amplitude across this heartbeat window. Pure silence
      // stays <100; speech routinely peaks >5000. Reported by the heartbeat
      // tick and reset there.
      if (payload.length >= 2 && payload.length % 2 === 0) {
        const samples = new Int16Array(
          payload.buffer,
          payload.byteOffset,
          payload.length / 2
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
          data: payload.toString("base64")
        }
      });
    } catch (e) {
      console.error("gemini-bridge: uplink", e);
    }
  };

  return {
    onTelnyxMessage,
    teardown,
    getLead: () => ({ ...leadData }),
    getUsage: () => latestUsage
  };
}
