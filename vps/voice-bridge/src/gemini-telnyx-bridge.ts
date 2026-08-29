import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from "@google/genai";
import { parsePcmRateFromMime, StreamingResampler } from "./audio-resample.js";
import {
  parseTelnyxFrame,
  telnyxClearMessage,
  telnyxMediaMessageFromPcmBase64
} from "./telnyx-media-json.js";
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
  extractTranscriptionFrame,
  type TranscriptAdapter,
  type TranscriptRecorder
} from "./voice-transcript.js";
import { toolResponsePayload, type ToolResult } from "./tool-response-payload.js";
import {
  createSpokenNumberGuard,
  GUARD_MAX_CUES,
  NUMBER_SUPPRESSED_CUE,
  type SpokenNumberGuard,
  type SpokenNumberViolation
} from "./spoken-number-guard.js";
import {
  VOICEMAIL_DETERMINISTIC_END_CALL_REPLY,
  VOICEMAIL_DETERMINISTIC_TOOL_REPLY,
  VOICEMAIL_END_CALL_HOLD_MS
} from "./voicemail-mode.js";
import { readLiveUsage, type GeminiLiveUsage } from "./live-usage.js";
import { buildVoiceToolDeclarations } from "./tool-declarations.js";
import { resolveVoiceName } from "./voice-name.js";
import { voicemailPlausiblyDelivered } from "./voicemail-timing.js";
import { inputAudioTranscriptionConfig } from "./asr-language-hints.js";
import {
  decideIvrPress,
  IVR_REFALLBACK_MS,
  type IvrPressSource
} from "./ivr-gate-press.js";

export { readLiveUsage, type GeminiLiveUsage };

const TELNYX_PCM_RATE = 16000;
const GEMINI_OUTPUT_DEFAULT_RATE = 24000;

/**
 * Default ceiling on the INTERPRETED stretch of a call, measured from the
 * moment translator mode takes over. Generous on purpose: a real interpreted
 * conversation (an inspection, a quote, a scheduling back-and-forth) runs
 * longer than the AI-led calls the 14-minute session cap was sized for, and
 * cutting the interpreter off mid-sentence is a worse failure than the spend.
 * Override per box with VOICE_TRANSLATOR_MAX_MS.
 */
const TRANSLATOR_CEILING_DEFAULT_MS = 30 * 60 * 1000;

function readTranslatorCeilingMs(): number {
  const v = Number(process.env.VOICE_TRANSLATOR_MAX_MS);
  return Number.isFinite(v) && v > 0 ? v : TRANSLATOR_CEILING_DEFAULT_MS;
}

/**
 * Resolved `@google/genai` package version at boot. Persisted in the
 * `voice_bridge_gemini_session_start` telemetry so we can confirm, without
 * SSHing the VPS, which SDK the running container actually has. A major
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
    // ignore, reported as "unknown" below
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
 * than the default budget, aborting them early is worse than the wait:
 *
 *  - `calendar_book_appointment` COMMITS a provider write. A cold booking
 *    (shared-calendar ensure + Nango proxy to Google/Microsoft) can take
 *    5–10s, and the bridge's abort is client-side only, the app keeps
 *    going and the event gets created anyway. On a real Truly Insurance
 *    call (2026-07-15) the 3.5s abort made the model tell the caller their
 *    chosen time was "no longer available" while the booking silently
 *    succeeded, then book a SECOND slot, a double booking. The model can
 *    narrate ("one moment while I confirm that") so the extra silence is
 *    acceptable for a commit.
 *  - `calendar_find_slots` fans out over provider free/busy reads and was
 *    observed at 2.3–2.8s warm, too close to 3.5s for a cold call.
 */
const TOOL_CALL_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  calendar_book_appointment: 15_000,
  calendar_find_slots: 8_000
};

/**
 * Model-facing guidance when a tool call hits the bridge timeout. Booking
 * gets explicit recovery steps because a timed-out booking may have
 * SUCCEEDED app-side (the abort does not cancel the server's work): the
 * idempotency ledger makes an identical retry safe, it returns the
 * already-created event (`already_booked`) instead of double-booking.
 */
const TOOL_TIMEOUT_MESSAGES: Record<string, string> = {
  calendar_book_appointment:
    "The booking system was slow to respond, the booking may still have completed. Do NOT " +
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
  /**
   * TRANSLATOR MODE: stay on the bridged call as a live interpreter instead of
   * detaching. Requires the call to have been ARMED at answer time
   * (`stream_bidirectional_target_legs=both`), because Telnyx cannot re-point a
   * running stream's target legs and restarting the stream would tear this
   * session down. An unarmed call must NEVER set this: the fork would reach only
   * the caller, so the AI would talk over them while the human heard nothing.
   */
  translatorMode?: boolean;
  /** Name of the person being transferred to, when known. Used in the cue. */
  humanName?: string;
  /**
   * Speak one short line to the human as they join, telling them an interpreter
   * is on the line. Defaults to true; the person picking up otherwise has no
   * idea why a third voice is speaking.
   */
  discloseToHuman?: boolean;
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
 * "I reached a recording, not a person."
 *
 * Carrier AMD is the primary voicemail detector and it is NOT reliable: it
 * classified Jim Inderberg's mailbox as `human_residence` on 2026-08-17
 * (a personal greeting is one human voice talking, which is precisely what a
 * human-residence greeting sounds like). When it misses, nothing downstream
 * ever learns the truth: the flow records "spoke with them", the follow-up
 * text that only sends on no-answer is skipped, and the lead quietly dies in
 * a cadence that thinks it succeeded.
 *
 * The assistant is the one participant that actually HEARD the mailbox, so it
 * gets a way to say so. Invoking this is the model's machine verdict: the host
 * records it on the call (so the outcome resolves to no-answer and the call
 * page shows a voicemail) and, when the step configured a message, claims the
 * right to leave it and hands the script back to be read aloud.
 *
 * The claim is shared with the edge's own voicemail drop, so the two paths can
 * never both leave a message on one recording.
 */
export type VoicemailCapability = {
  execute: () => Promise<{
    /** False only when the record could not be written; the model still ends the call. */
    ok: boolean;
    /** The message to read aloud, present only when this side won the claim. */
    script?: string;
    /**
     * True when the OTHER path (the edge's own drop) holds the claim and is
     * speaking right now. Distinct from "no message configured" even though
     * both hand back no script, because the two need opposite endings: with a
     * message already playing into the recording, hanging up would cut it off
     * mid-sentence, so this case waits and lets the edge end the call.
     */
    alreadyBeingLeft?: boolean;
    detail?: string;
  }>;
  /**
   * Record that the message was actually delivered. Called the instant the
   * model asks to end the call after being handed a script, which is the only
   * moment that is both AFTER it read the message and BEFORE the line goes
   * quiet: a mailbox hangs up on silence, so anything scheduled behind the
   * end_call playout grace loses the race to the mailbox's own hangup and the
   * message reads as never left.
   */
  confirmSpoken?: () => Promise<void>;
};

/**
 * Lets the assistant press keypad digits on the live leg. Registered as the
 * `press_digits` tool, and used by the IVR gate below so a partner announcement
 * ("press 1 to accept this referral") is answered when it is actually HEARD.
 */
export type DtmfCapability = {
  /** Send the digits to the Telnyx leg. Resolved value is for logging only. */
  execute: (digits: string) => Promise<{ ok: boolean; detail?: string }>;
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
   * rendered contextTemplate), injected into the system prompt with a
   * never-re-ask rule so the AI doesn't ask for details the flow already
   * extracted.
   */
  contextNote?: string;
  /**
   * place_ai_call live transfer: when true (and the host wired a transfer
   * capability), the intake session ALSO gets the transfer tool, the flow
   * explicitly authorized connecting this callee to a person once they
   * confirm it's a good time. Off for classic HomeLight intake, which is
   * capture-only by design.
   */
  allowTransfer?: boolean;
  /** Display name of the transfer target ("one moment while I get Dave on the line"). */
  transferAgentName?: string;
  /**
   * MID-CALL brief source. An AI-first call (voice_ai_intake.answerFirst) is
   * answered within seconds of the partner's alert text, while the flow's own
   * portal read only finishes about a minute later. When set, the bridge polls
   * this for the session's current note and, the moment it changes, tells the
   * model what just arrived so it can work the details into the conversation it
   * is already having. Returns the note ("" when unavailable); never throws.
   */
  pollBrief?: () => Promise<string>;
  /**
   * IVR GATE. The call was answered into a partner's automated announcement
   * rather than a person, so the assistant must stay silent, press `digit` the
   * moment the recording asks it to accept, and only then wait for the human
   * the partner dials in. Needs a `dtmf` capability to do anything; without one
   * the gate is ignored and the session greets normally.
   *
   * `fallbackMs` is the backstop: a missed cue would cost the referral outright,
   * so the bridge presses the digit blindly once that long has passed with no
   * press. Pressing twice is harmless here (the announcement has moved on) but
   * is prevented anyway.
   */
  ivrGate?: { digit: string; fallbackMs?: number };
  /**
   * The step's authored voicemailTemplate text, when one exists. Two jobs:
   * the persona states the ONE callback number the script carries (the model
   * fabricated numbers precisely on calls where it held none), and the
   * spoken-number guard learns the script's numbers as legitimate.
   */
  voicemailScript?: string;
};

export type { CapturedLead } from "./intake.js";

/**
 * Configuration for the voice tool suite, a small set of HTTP adapters the
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

// The system-instruction builder (persona/tool/context prompt composition,
// incl. CallerIdentity and the context-block caps) lives in
// system-instruction.ts so repo-root tests and typecheck can import it
// without this module's VPS-only runtime deps (@google/genai, ws).
// Re-exported so existing importers keep one entry point.
export {
  systemInstructionForBusiness,
  translatorModeCue,
  translatorModeEndCue,
  VOICE_CUSTOMER_MEMORY_MAX_CHARS,
  VOICE_FLOW_CONTEXT_MAX_CHARS,
  VOICE_RECENT_INTERACTIONS_MAX_CHARS,
  type CallerIdentity,
  type VoiceLanguagePrefs
} from "./system-instruction.js";
import {
  systemInstructionForBusiness,
  translatorModeCue,
  translatorModeEndCue,
  type CallerIdentity,
  type VoiceLanguagePrefs
} from "./system-instruction.js";
import { createCallerSpeechLog } from "./caller-speech.js";
import { resolveInterpretDecision } from "./translator-gate.js";

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
   * owner isn't available right now, please text us", we can't fall back to a
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
   * When set, registers a `voicemail_reached` tool so the assistant can report
   * that it is talking to a recording. Wired for calls WE placed, where a
   * missed voicemail silently poisons the flow outcome (see
   * VoicemailCapability).
   */
  voicemail?: VoicemailCapability;
  /**
   * When set, registers a `press_digits` tool so the assistant can work a
   * partner IVR. Provided by index.ts whenever a Telnyx API key exists; the
   * tool is only DECLARED for a session that also asked for the IVR gate.
   */
  dtmf?: DtmfCapability;
  /**
   * Stop THIS call's media fork (Telnyx `streaming_stop`) without hanging the
   * leg up. Independent of `transfer`, because translator mode can also be
   * entered by staff on a tenant that has no transfer target configured at all:
   * relying on `transfer.detach` there would close the Gemini session at the
   * interpreter ceiling while leaving Telnyx streaming audio to a bridge that no
   * longer has a session. Provided by index.ts whenever a Telnyx API key exists.
   */
  detachMedia?: () => Promise<{ ok: boolean; detail?: string }>;
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
   * CRM/transfer tools, only `capture_lead` is registered.
   */
  intake?: IntakeCapability;
  /** Vault markdown (soul/identity/memory/website) rendered into the system prompt. */
  vault?: VaultSnapshot;
  /**
   * Optional caller E.164 (raw from Telnyx), forwarded to voice tools so the
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
   * customer-memory snippet). Undefined = no recent automation activity,
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
   * no booking context, the prompt is identical to the pre-feature shape.
   */
  bookingStatusNote?: string;
  /**
   * The caller's resolved language preference (contacts.preferred_language,
   * else the tenant's businesses.default_customer_language). Undefined keeps
   * the historical English default. Rides BOTH personas: the receptionist and
   * the intake takeover.
   */
  languagePrefs?: VoiceLanguagePrefs;
  /**
   * The tenant's chosen Gemini Live voice (`business_telnyx_settings.voice_name`),
   * or null/undefined to fall through to the box env and then the platform
   * default. Passed per call rather than read from env so an admin change
   * applies to the next call without redeploying the box.
   */
  tenantVoiceName?: string | null;
  /**
   * Settings → Coworker tools state for the bridge-local
   * `start_translator_mode` tool, resolved by index.ts (HTTP-proxied voice tools
   * are gated app-side instead). Undefined/false withholds the declaration, so a
   * disabled tool is not merely discouraged in the prompt.
   */
  translatorOnRequestEnabled?: boolean;
  /**
   * Who the caller is (owner / team member / customer). When the caller is
   * staff, the system instruction switches from the customer receptionist
   * script to an internal-assistant persona, same intent as the SMS worker's
   * team/owner gate. Undefined is treated as a customer (backwards compatible).
   */
  callerIdentity?: CallerIdentity;
  /**
   * Optional diagnostics sink. When set, the bridge emits a structured
   * timeline of Gemini Live lifecycle events (session start, setup complete,
   * greeting sent, error, close, teardown) including the close code/reason and
   * audio frame counters. Wired in index.ts to `telemetry_record` so the
   * timeline lands in `telemetry_events` and can be queried after a test call,
   * the VPS stdout where these previously lived is not reachable from here.
   * Implementations MUST NOT throw; the bridge invokes this defensively but
   * a throwing sink should never tear down a live call.
   */
  recordDiag?: (eventType: string, payload: Record<string, unknown>) => void;
  /**
   * SPOKEN-NUMBER FIREWALL (rollout-gated in index.ts via the
   * `voice_spoken_number_guard` platform setting). When set, the bridge runs
   * output transcription through a per-call allowlist and, the moment the
   * model's speech reveals a phone number nothing on this call supplied,
   * flushes Telnyx's queued audio (`{"event":"clear"}`) and drops the rest of
   * that model turn, so the digits never finish playing. See
   * spoken-number-guard.ts for the allowlist contract.
   */
  numberGuard?: {
    /** Text blobs whose numbers are legitimate (voicemail script, briefing, party numbers as text). */
    seedTexts: ReadonlyArray<string>;
    /** Known-legitimate numbers (party E.164s, configured business numbers). */
    seedNumbers: ReadonlyArray<unknown>;
    /**
     * Persist the full suppressed-number list for this call (best-effort).
     * index.ts merges it onto the handoff session context so the daily
     * call-integrity sweep can report the attempt as BLOCKED rather than
     * paging a human about audio nobody heard.
     */
    recordSuppressed?: (numbers: string[]) => Promise<void>;
  };
  /**
   * DETERMINISTIC VOICEMAIL DELIVERY (outbound legs with an authored script,
   * tenant enrolled in `voice_amd_resolution`; decided by
   * deterministicVoicemailArmed in voicemail-mode.ts). When true,
   * `voicemail_reached` stops handing the script to the model: the bridge
   * stamps the verdict, mutes the model's audio for the rest of the call,
   * refuses the model's `end_call` while the platform still owes the
   * voicemail, and the edge greeting handler or AMD resolution sweep speaks
   * the script over Telnyx TTS through the shared claim.
   */
  deterministicVoicemail?: boolean;
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
  // right call for real-time voice, retries cannot help (the moment has passed).
  if (ws.bufferedAmount > DOWNLINK_BACKPRESSURE_HIGH_WATERMARK_BYTES) {
    telemetry.droppedFrames += 1;
    const now = Date.now();
    if (now - telemetry.lastDropWarnAtMs > 5_000) {
      telemetry.lastDropWarnAtMs = now;
      console.warn(
        "gemini-bridge: downlink backpressure, dropping frames",
        { bufferedAmount: ws.bufferedAmount, droppedFrames: telemetry.droppedFrames }
      );
    }
    return;
  }
  // Telnyx's `stream_bidirectional_mode: "rtp"` `media.payload` is the base64
  // RTP *payload*, raw codec samples with NO 12-byte RTP header. The Telnyx
  // media-streaming spec says so explicitly ("base64-encoded RTP payload
  // without RTP headers") and it's symmetric with the inbound frames, which we
  // already consume as header-less raw L16. Prepending an RTP header here made
  // Telnyx render the 12 header bytes as 6 L16 samples of noise at the start of
  // every chunk, an audible click/"typing" sound under the assistant's voice.
  // Send the raw little-endian L16 samples (16 kHz, mono) instead.
  const audio = Buffer.from(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength);
  ws.send(telnyxMediaMessageFromPcmBase64(audio.toString("base64")));
}

// ---------------------------------------------------------------------------
// Voice tool adapters, HTTP calls into the platform Next.js app.
// ---------------------------------------------------------------------------

// ToolResult and the wire payload it becomes live in tool-response-payload.ts:
// the field enumeration there is pinned by a test, because an unforwarded
// field once cost twelve days of fabricated voicemail numbers (the
// `voicemail_reached` script never reached the model).

function voiceToolPath(name: string): string {
  switch (name) {
    case "business_knowledge_lookup":
      return "/api/voice/tools/knowledge";
    case "calendar_find_slots":
      return "/api/voice/tools/calendar/find-slots";
    case "calendar_book_appointment":
      return "/api/voice/tools/calendar/book";
    case "calendar_join_waitlist":
      return "/api/voice/tools/calendar/waitlist";
    case "send_follow_up_sms":
      return "/api/voice/tools/sms";
    case "send_follow_up_email":
      return "/api/voice/tools/email";
    case "capture_caller_details":
      return "/api/voice/tools/capture";
    // Staff-only: start one of the business's automations from a call. The
    // declaration is withheld from customer callers below, and the adapter
    // re-checks the caller server-side.
    case "run_aiflow":
      return "/api/voice/tools/run-aiflow";
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
  // The timestamp anchors the voicemail plausibility window: the line dies
  // at FIRST end_call + grace, wherever later duplicates land.
  let endCallRequested = false;
  let endCallRequestedAtMs = 0;
  // Set once `voicemail_reached` handed the model a message to read, so the
  // end_call handler knows to confirm the delivery (see confirmSpoken). The
  // timestamp and length are what let that handler check the read PLAUSIBLY
  // happened before stamping it delivered (see voicemail-timing.ts).
  let voicemailScriptGiven = false;
  let voicemailScriptGivenAtMs = 0;
  let voicemailScriptChars = 0;
  // DETERMINISTIC VOICEMAIL: set the moment `voicemail_reached` is accepted in
  // deterministic mode. From then on the model's audio never reaches the wire
  // (modelAudioMuted) and its `end_call` is refused for
  // VOICEMAIL_END_CALL_HOLD_MS, because on call 5e325829 the model ended the
  // leg 9 seconds after the machine verdict, before any deterministic speaker
  // could act. 0 means not pending.
  let voicemailDeterministicPendingAtMs = 0;
  // SPOKEN-NUMBER FIREWALL state. `modelAudioMuted` is permanent for the rest
  // of the call (machine legs); `suppressTurnAudio` drops the remainder of the
  // CURRENT model turn after a violation and resets at turnComplete.
  let modelAudioMuted = false;
  let suppressTurnAudio = false;
  let guardCuesSent = 0;
  // Set once a warm transfer succeeds so we detach the AI exactly once (a
  // duplicate transfer tool-call can't schedule two teardowns).
  let transferDetachRequested = false;
  /**
   * True from the moment a translator-armed transfer succeeds and the
   * interpreter cue lands. Suppresses the AI-led wind-down cues, drops the tool
   * surface, and is what keeps the media fork attached instead of detaching.
   */
  let translatorActive = false;
  /**
   * How interpreting began, which decides whether it can be ENDED mid-call.
   *
   * `staff_request`: the AI is on a staff member's own leg and they added the
   * other party themselves, so when they say the other person is gone the AI
   * should go back to being their assistant.
   *
   * `transfer`: a customer is bridged to a human. Leaving interpreter mode there
   * would drop the AI back into receptionist behavior in the middle of two
   * people's conversation, and the customer never consented to that, so this
   * path has no exit short of hanging up.
   */
  let translatorEntry: "transfer" | "staff_request" | null = null;
  /** Handle for the interpreted-stretch ceiling, so an exit can cancel it. */
  let translatorCeilingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True once the one-shot `sessionMaxMs` teardown has come and gone while
   * interpreting. That timer returns early rather than firing, so leaving
   * interpreter mode afterwards would strand an assistant-mode call with no
   * session cap at all (the interpreter ceiling is cancelled on exit), and open
   * Live billing until someone hangs up. The exit re-arms from this.
   */
  let sessionCapDeferredByTranslator = false;
  const sessionStartedAtMs = Date.now();
  /** Grace given back to the colleague when the cap already lapsed mid-interpretation. */
  const TRANSLATOR_EXIT_GRACE_MS = 90_000;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const downlinkTelemetry: DownlinkTelemetry = {
    droppedFrames: 0,
    lastDropWarnAtMs: 0
  };
  // Per-call streaming resampler for the Gemini (24 kHz) → Telnyx (16 kHz)
  // downlink. Stateful across chunks so the phase stays continuous, a stateless
  // per-chunk resample injects a step discontinuity at every chunk boundary,
  // which is audible as a periodic click/"typing" sound during AI speech.
  // Lazily constructed on the first chunk so it locks onto the model's actual
  // output rate (parsed from the chunk mime type), and rebuilt if that changes.
  let downlinkResampler: StreamingResampler | null = null;
  // Uplink framing is a per-stream property, but the only per-frame signal is
  // the RTP V=2 bits in byte 0, which raw L16 sample bytes hit ~25% of the
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
  // counters are kept inexpensive, incrementing booleans/integers, but
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
    // Model audio chunks withheld from the wire by the deterministic-voicemail
    // mute or the spoken-number firewall. Nonzero here plus zero suppressed
    // numbers means the mute did the work; a spike is a model that kept
    // talking to a mailbox.
    mutedChunks: 0,
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
  // Never throws, a broken sink must not affect the call.
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
  // size only, never the base64 audio or caller PII.
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

  /**
   * What the caller has said, kept for the translator gate's language
   * judgment at transfer time. Independent of the transcript adapter: the
   * decision is live and synchronous, and must not wait on a DB write.
   */
  const callerSpeech = createCallerSpeechLog();

  // SPOKEN-NUMBER FIREWALL. Seeded here with everything known before the
  // session opens; every later injection toward the model (coordinator cues
  // via the sendRealtimeInput tap below, tool responses in sendToolResponse,
  // the system instruction once composed) feeds it too, so the allowlist is
  // exactly "what the model was legitimately given", the same contract as
  // NO_INVENTED_CONTACT_LINE.
  const numberGuard: SpokenNumberGuard | null = opts.numberGuard ? createSpokenNumberGuard() : null;
  if (numberGuard && opts.numberGuard) {
    for (const t of opts.numberGuard.seedTexts) numberGuard.allowText(t);
    for (const n of opts.numberGuard.seedNumbers) numberGuard.allowNumber(n);
    numberGuard.allowNumber(opts.callerE164);
  }

  /**
   * A number left the model's mouth that nothing on this call supplied.
   * Ordered for speed: flush Telnyx's queued audio FIRST (the digits are
   * usually still in that queue, and every millisecond of queue drain is a
   * digit closer to the caller's ear), then suppress the rest of the turn,
   * then record, then correct the model.
   */
  const handleNumberViolations = (violations: SpokenNumberViolation[]): void => {
    suppressTurnAudio = true;
    try {
      if (opts.ws.readyState === WebSocket.OPEN) opts.ws.send(telnyxClearMessage());
    } catch (err) {
      console.error("gemini-bridge: telnyx clear failed", err);
    }
    for (const v of violations) {
      console.error("gemini-bridge: suppressed fabricated number", {
        callControlId: opts.callControlId,
        number: v.number,
        muted: modelAudioMuted
      });
      emitDiag("voice_bridge_spoken_number_suppressed", {
        number: v.number,
        turn_chars: v.turnText.length,
        muted: modelAudioMuted
      });
    }
    const record = opts.numberGuard?.recordSuppressed;
    if (record && numberGuard) {
      void record(numberGuard.suppressedNumbers()).catch((err) => {
        console.error("gemini-bridge: recordSuppressed failed", err);
      });
    }
    // On a muted leg (machine verdict) nobody hears the model either way, so
    // a correction would only burn tokens; the deterministic script path owns
    // the leg. On a live leg, tell the model once or twice, then rely on
    // suppression alone.
    if (!modelAudioMuted && guardCuesSent < GUARD_MAX_CUES) {
      guardCuesSent++;
      try {
        session.sendRealtimeInput({ text: NUMBER_SUPPRESSED_CUE });
      } catch (err) {
        console.error("gemini-bridge: number-suppressed cue failed", err);
      }
    }
  };

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

  /**
   * Bound the interpreted stretch. Deliberately a STANDALONE timer (like the
   * end_call grace): a clearTimers() must never be able to strand an open Live
   * session on a human conversation that could run for an hour.
   *
   * This is a runaway guard, not a budget policy. The tenant pays for what they
   * use, and the voice reserve gate plus the low-balance alert are what handle
   * spend; this only stops a session nobody is watching. When it fires the AI
   * leaves quietly: the two humans keep their bridged call, exactly as they
   * would have had translator mode never been armed.
   */
  const scheduleTranslatorCeiling = (): void => {
    const ceilingMs = readTranslatorCeilingMs();
    translatorCeilingTimer = setTimeout(() => {
      // Cleared when interpreting ENDS mid-call: without this the ceiling would
      // later detach and tear down a session that had gone back to being an
      // ordinary assistant call.
      if (ended || !translatorActive) return;
      // CLAIM the end synchronously, before any await. clearTimeout cannot stop
      // a callback already running, so without this a stop_translator_mode
      // landing during the detach would leave the call detached (no audio) but
      // never torn down. Claiming means a racing exit simply finds interpreting
      // already over and takes its no-op path.
      translatorActive = false;
      translatorEntry = null;
      translatorCeilingTimer = null;
      void (async () => {
        emitDiag("voice_bridge_translator_ceiling_reached", { ceiling_ms: ceilingMs });
        console.log("gemini-bridge: translator ceiling reached, leaving the call", {
          callControlId: opts.callControlId,
          ceilingMs
        });
        // Remove the fork FIRST so the humans keep talking privately, then close
        // the session. `detachMedia` rather than `transfer.detach`: staff can
        // enter translator mode on a tenant with no transfer target at all, and
        // that path has no transfer capability to borrow a detach from. Without
        // it Telnyx would keep streaming audio to a bridge whose session is gone.
        const detach = opts.detachMedia ?? opts.transfer?.detach;
        try {
          if (detach) {
            const d = await detach();
            if (!d.ok) {
              console.error("gemini-bridge: translator ceiling detach failed", d.detail);
              emitDiag("voice_bridge_translator_ceiling_detach_failed", {
                detail: d.detail ?? null
              });
            }
          }
        } catch (err) {
          console.error("gemini-bridge: translator ceiling detach threw", err);
        }
        await teardown();
      })();
    }, ceilingMs);
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
   * contains an invalid argument.", i.e. the AI speaks its opening line and
   * the call dies the moment the caller answers. `sendRealtimeInput({ text })`
   * injects the greeting cue inside the realtime stream, keeping every turn
   * consistent.
   */
  // IVR gate: only armed when the session asked for it AND a DTMF capability
  // exists to satisfy it. Without the capability the assistant could be told to
  // press a digit it has no way to send, which would hold the greeting back on a
  // call it can never accept. Read through `opts` rather than the `intake`
  // alias, which is declared far below: the alias is only safe inside closures.
  const ivrGate = opts.dtmf && opts.intake?.ivrGate ? opts.intake.ivrGate : undefined;
  let acceptPressed = false;
  let acceptPressInFlight = false;
  let acceptPressCount = 0;
  let acceptAttemptCount = 0;
  let lastAcceptPressAtMs = 0;
  // The digit whose press Telnyx ACCEPTED. The refallback must re-press what
  // actually worked: when the announcement names a different key than the
  // flow authored ("press 2 to accept") and the model pressed it, re-pressing
  // the authored digit would send the WRONG key into the menu.
  let lastOkAcceptDigits: string | null = null;
  let ivrRefallbackArmed = false;

  /** The opening line, shared so no cue can quote a different one. */
  const intakeOpenerText = (): string =>
    intakeOpener(
      opts.businessName,
      opts.intake?.persona,
      opts.intake?.allowTransfer || opts.direction === "outbound" ? "outbound" : "inbound"
    );

  /**
   * Hold the assistant silent while the partner's recording plays. Sent INSTEAD
   * of the greeting: speaking here would talk over the announcement, and the
   * person we actually want has not been dialed in yet.
   */
  let ivrListenCueSent = false;
  const sendIvrListenCue = (): void => {
    if (ivrListenCueSent) return;
    ivrListenCueSent = true;
    try {
      session.sendRealtimeInput({
        text:
          "[Coordinator, do NOT speak] This call was answered into an automated recording, not a person. " +
          "Say absolutely nothing. Listen to the announcement, and the moment it asks you to press a key to accept " +
          `(for example "press ${ivrGate?.digit ?? "1"} to accept"), call the press_digits tool with that digit. ` +
          "Do not speak before or after pressing. Someone will be connected to you shortly afterwards."
      });
      emitDiag("voice_bridge_ivr_gate_listening", { digit: ivrGate?.digit ?? "" });
    } catch (err) {
      console.error("gemini-bridge: IVR listen cue failed", err);
    }
  };

  /**
   * After the accept, the partner dials the customer in, so there is still no
   * one to greet. Arm the opener and let the model fire it when a human actually
   * speaks. Marks the greeting as triggered so nothing greets the recording.
   */
  const sendPostAcceptCue = (): void => {
    if (diag.greetingTriggered) return;
    diag.greetingTriggered = true;
    try {
      session.sendRealtimeInput({
        text:
          "[Coordinator, do NOT speak yet] The referral is accepted. Stay completely silent while the line connects. " +
          `The moment you hear a real person speak, say your opening line ONCE ("${intakeOpenerText()}"), never repeat it, ` +
          "and then begin the intake. If the automated recording is still asking you to press a key, call press_digits again."
      });
      emitDiag("voice_bridge_ivr_gate_accepted");
    } catch (err) {
      console.error("gemini-bridge: post-accept cue failed", err);
    }
  };

  /** One blind re-press if the first Telnyx-OK tone did not connect a human. */
  const armIvrRefallback = (): void => {
    if (!ivrGate || ivrRefallbackArmed) return;
    ivrRefallbackArmed = true;
    timers.push(
      setTimeout(() => {
        if (ended) return;
        void pressAcceptDigit(lastOkAcceptDigits ?? ivrGate.digit, "refallback");
      }, IVR_REFALLBACK_MS)
    );
  };

  /**
   * Press the accept digit (model cue, first backstop, or pre-human re-press).
   * Telnyx OK is not treated as "partner accepted forever": while under the
   * per-call press cap, model/refallback may send again (model has a cooldown;
   * the scheduled refallback does not, so a near-timer model press cannot eat it).
   */
  const pressAcceptDigit = async (
    digits: string,
    source: IvrPressSource
  ): Promise<boolean> => {
    const decision = decideIvrPress({
      ended,
      hasDtmf: Boolean(opts.dtmf),
      inFlight: acceptPressInFlight,
      acceptPressed,
      acceptPressCount,
      attemptCount: acceptAttemptCount,
      lastPressAtMs: lastAcceptPressAtMs,
      nowMs: Date.now(),
      source
    });
    if (decision.action === "deny" || !opts.dtmf) return false;

    // Claim BEFORE awaiting so the backstop timer cannot double-send mid-request.
    acceptPressInFlight = true;
    acceptAttemptCount += 1;
    if (!decision.repress) acceptPressed = true;
    try {
      const result = await opts.dtmf.execute(digits).catch((err) => ({
        ok: false,
        detail: err instanceof Error ? err.message : String(err)
      }));
      if (!result.ok) {
        // First press: unlock so the other path can retry. Re-press: leave
        // acceptPressed set. Stamp the clock on FAILURE too, so the cooldown
        // rate-limits a failing retry loop the same as a successful one; the
        // attempt cap above bounds it outright.
        if (!decision.repress) acceptPressed = false;
        lastAcceptPressAtMs = Date.now();
        console.error("gemini-bridge: accept digit failed", { source, detail: result.detail });
        emitDiag("voice_bridge_ivr_gate_press_failed", {
          source,
          detail: result.detail ?? "",
          repress: decision.repress
        });
        return false;
      }
      acceptPressCount += 1;
      lastAcceptPressAtMs = Date.now();
      lastOkAcceptDigits = digits;
      console.log("gemini-bridge: accept digit pressed", {
        callControlId: opts.callControlId,
        digits,
        source,
        attempt: acceptPressCount,
        repress: decision.repress
      });
      if (decision.repress) {
        emitDiag("voice_bridge_ivr_gate_repressed", {
          digits,
          source,
          attempt: acceptPressCount
        });
      } else {
        emitDiag("voice_bridge_ivr_gate_pressed", { digits, source });
        sendPostAcceptCue();
        armIvrRefallback();
      }
      return true;
    } finally {
      acceptPressInFlight = false;
    }
  };

  const sendGreetingCue = (): void => {
    if (diag.greetingTriggered) return;
    // A gated session greets a recording if it greets now. The opener is armed
    // by sendPostAcceptCue once the accept digit is in.
    if (ivrGate && !acceptPressed) {
      sendIvrListenCue();
      return;
    }
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
          ? `[Coordinator, speak aloud now] The person has just answered the phone. Say your opening line ONCE ("${opener}"), then stop and listen, never repeat the opener, even if they talk over it, and follow your call script.`
          : opts.direction === "outbound"
            ? `[Coordinator, speak aloud now] The person has just answered the phone. Say your opening line ONCE ("${opener}"), then stop and listen, never repeat the opener, even if they talk over it, and continue per your instructions, calling capture_lead as you learn details. Never ask for their phone number.`
            : `[Coordinator, speak aloud now] A seller lead has just been connected. Greet them warmly with your opening line ("${opener}"), say it only once, never restart it, and begin the short intake, get their name, callback number, property address, and timeframe, calling capture_lead as you go.`;
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
        greetingText = `[Coordinator, speak aloud now] ${subject} has just connected. Greet them warmly${staffName ? " by name" : ""} in one short sentence (${example}), do not run the customer intake script, and wait for their reply.`;
      } else {
        greetingText = `[Coordinator, speak aloud now] The caller has just connected. Greet them warmly in one short sentence (e.g. "Hi, thanks for calling ${opts.businessName}, how can I help?") and wait for their reply.`;
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
    //       up before the Telnyx WS closed, the exact signal we needed to
    //       diagnose the May 2026 "ring then silence" outage.
    //   (2) The transcript recorder must run `finalize` even when `ended`
    //       is already true. An upstream Live-session close (session
    //       expiry, quota, network drop) fires `onclose` first; without
    //       running finalize here, the transcript row stays stuck at
    //       status='in_progress' with a NULL `ended_at`.
    // Note: `session.close()` itself is one-shot, calling it twice on a
    // dead session throws, so we still gate the network-side teardown on
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
      downlink_bytes: diag.downlinkBytesPostHeader,
      muted_chunks: diag.mutedChunks,
      suppressed_numbers: numberGuard ? numberGuard.suppressedNumbers().length : 0
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
    // Intake sessions get ONLY the capture tool, no transfer / customer CRM
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
      notes: "Anything else useful, price expectations, motivation, condition, constraints."
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
        ? "Record details you learn on this call for the office's follow-up notes. Call as soon as you learn any field, and again as you learn more. Always call before saying goodbye. Never ask for their phone number, you called them on it."
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
  // The mirror image: starting one of the business's own automations, or asking
  // the receptionist to stop assisting and become an interpreter for the rest of
  // the call, is a STAFF action. Withholding the declaration from customer
  // callers is the strong gate (the prompt alone would still let the model try
  // it); each handler re-checks the caller as defense in depth.
  const STAFF_ONLY_TOOLS = new Set([
    "run_aiflow",
    "start_translator_mode",
    "stop_translator_mode"
  ]);
  /**
   * Tools handled ON THE BOX rather than proxied to `/api/voice/tools/*`. They
   * are registered separately below because they must NOT depend on
   * `voiceToolsReady` (the HTTP proxy's app URL + gateway token): they need no
   * app round trip, exactly like `transfer_to_owner` and `end_call`. A box
   * missing that config is degraded, but interpreting still works there.
   */
  const BRIDGE_LOCAL_TOOLS = new Set(["start_translator_mode", "stop_translator_mode"]);
  if (!intake && voiceToolsReady) {
    for (const decl of buildVoiceToolDeclarations()) {
      if (callerIsStaff && STAFF_EXCLUDED_TOOLS.has(decl.name)) continue;
      if (!callerIsStaff && STAFF_ONLY_TOOLS.has(decl.name)) continue;
      if (BRIDGE_LOCAL_TOOLS.has(decl.name)) continue;
      declarations.push(decl);
    }
  }
  // Bridge-local staff tools. Gated on the caller being staff and on the owner's
  // Settings → Coworker tools row (resolved by index.ts): a bridge-local tool has
  // no app-side adapter to answer `tool_disabled`, so withholding the declaration
  // is the enforcement.
  if (!intake && callerIsStaff && opts.translatorOnRequestEnabled) {
    // Both halves ship together: Gemini Live cannot add a tool mid-session, so
    // the way OUT of interpreting has to be declared before it ever starts.
    for (const decl of buildVoiceToolDeclarations()) {
      if (decl.name === "start_translator_mode" || decl.name === "stop_translator_mode") {
        declarations.push(decl);
      }
    }
  }
  // `press_digits` exists only for a gated session: it is the tool that clears
  // the partner IVR, and no other persona has a keypad to work.
  if (ivrGate) {
    declarations.push({
      name: "press_digits",
      description:
        "Press keypad digits on the phone line. Call this the INSTANT the automated recording asks you to " +
        `press a key to accept this referral (usually "${ivrGate.digit}"). Do not speak when you call it, and do not ` +
        "call it for anything else.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          digits: {
            type: Type.STRING,
            description: 'The digit(s) the recording asked for, e.g. "1".'
          }
        },
        required: ["digits"]
      }
    });
  }

  // `end_call` is available to every persona (receptionist, staff, and intake)
  // whenever the host wired a hangup capability, so the assistant can cleanly
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
  // `voicemail_reached` is the assistant's own machine verdict, for the calls
  // where carrier AMD guessing wrong is expensive (see VoicemailCapability).
  const hasVoicemailTool = Boolean(opts.voicemail);
  if (hasVoicemailTool) {
    declarations.push({
      name: "voicemail_reached",
      // Deterministic mode changes the CONTRACT, so the declaration must say
      // so: promising a `script` the response will never carry is exactly the
      // read-a-message-you-do-not-have bind that produced the fabricated
      // callback numbers.
      description: opts.deterministicVoicemail
        ? "Report that this call reached a RECORDING (a voicemail greeting, an answering machine, or a mailbox menu) rather than a live person. Call this as soon as you are confident, BEFORE saying anything else. The platform then leaves the approved message itself: after calling this, say nothing more for the rest of the call and do NOT call end_call, the call ends automatically."
        : "Report that this call reached a RECORDING (a voicemail greeting, an answering machine, or a mailbox menu) rather than a live person. Call this as soon as you are confident, BEFORE saying anything else. It returns `script` when there is a message to leave: read that text aloud word for word, then call end_call. When it returns no script, say nothing at all and call end_call immediately.",
      parameters: { type: Type.OBJECT, properties: {}, required: [] }
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
  //
  // The INPUT side carries language hints rather than the empty object it used
  // to send. An empty config means auto-detect across every language the model
  // knows, and on a noisy segment it guesses: Chris Bartelot's Aug 3 2026 call
  // was English throughout, yet one turn transcribed as Portuguese and another
  // as Korean. Hints narrow it to the languages this tenant actually serves
  // without pinning (Spanish callers must keep working), see
  // asr-language-hints.ts.
  //
  // The OUTPUT side stays unhinted on purpose: it transcribes our own speech,
  // whose language the model is already choosing deliberately, and constraining
  // it would fight the prompt's instruction to follow a caller who switches
  // language mid-call.
  // The spoken-number guard needs the transcription stream even on a session
  // that records no transcript (transcription is what reveals a number in the
  // model's audio before the audio finishes playing), so the guard forces the
  // config on. Only the RECORDING stays gated on transcriptAdapter.
  const transcriptionConfig = transcriptRecorder || numberGuard
    ? {
        inputAudioTranscription: inputAudioTranscriptionConfig({
          established: opts.languagePrefs?.established,
          defaultLang: opts.languagePrefs?.defaultLang
        }),
        outputAudioTranscription: {}
      }
    : {};

  // Voice: the tenant's own choice (read per call from
  // business_telnyx_settings.voice_name), else the box's VOICE_NAME env, else the
  // platform default. ALWAYS sent now: leaving it unset took Gemini's
  // undocumented per-model default, which Google warns can change and which was
  // observed differing between two identically configured boxes.
  const voiceName = resolveVoiceName({
    tenantVoiceName: opts.tenantVoiceName,
    envVoiceName: process.env.VOICE_NAME
  });
  const speechConfig = {
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
  };

  // Hoisted so the spoken-number guard learns every number the instruction
  // legitimately carries (the vault profile phone, flow-context numbers, the
  // voicemail script's callback number) before the model can speak one.
  const systemInstructionText = intake
    ? intakeSystemInstruction(
        opts.businessName,
        intake.persona,
        opts.businessTimezone,
        intakeCaptureFields,
        hasEndCall,
        intake.allowTransfer ? { agentName: intake.transferAgentName } : undefined,
        opts.direction === "outbound",
        intake.contextNote,
        opts.languagePrefs,
        hasVoicemailTool,
        Boolean(ivrGate),
        intake.voicemailScript,
        Boolean(opts.deterministicVoicemail)
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
        opts.bookingStatusNote,
        opts.languagePrefs,
        // Only teach the tool when it was actually declared above.
        declarations.some((d) => d.name === "start_translator_mode")
      );
  numberGuard?.allowText(systemInstructionText);

  session = await ai.live.connect({
    model: opts.model,
    config: {
      responseModalities: [Modality.AUDIO],
      ...(speechConfig as Record<string, unknown>),
      ...(transcriptionConfig as Record<string, unknown>),
      systemInstruction: systemInstructionText,
      tools: toolsForSession
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        if (ended || opts.ws.readyState !== WebSocket.OPEN) return;
        // Capture cumulative token usage for billing. Gemini Live reports
        // running session totals, so keep the frame with the largest total,
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
          // call the caller expects the assistant to greet first, without
          // this nudge they hear silence after ringback (no audio activity
          // means VAD never marks a turn complete and the model stays mute).
          //
          // `setupComplete` can be delivered WHILE `ai.live.connect` is still
          // awaiting (the SDK invokes onmessage from inside connect), i.e.
          // before the outer `session` variable is assigned, sending here
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
        // BEFORE the tool handler: transfer_to_owner arrives in the same
        // message batch as the caller's closing words, and the translator gate
        // reads those words. Ingesting afterwards would judge the language on a
        // transcript missing the sentence that prompted the transfer.
        callerSpeech.ingest(message);
        handleModelToolCalls(message);
        if (transcriptRecorder) {
          void transcriptRecorder.ingest(message);
        }
        // SPOKEN-NUMBER FIREWALL, and it must run BEFORE the audio loop below:
        // when the transcription revealing a fabricated number rides the same
        // server message as audio frames, those frames must never be sent at
        // all, and the `clear` inside handleNumberViolations flushes whatever
        // earlier messages already queued. Caller-side transcription feeds the
        // allowlist (repeating back what the person said is legitimate).
        if (numberGuard) {
          const frame = extractTranscriptionFrame(message);
          if (frame.callerText) numberGuard.noteCallerText(frame.callerText);
          if (frame.assistantText) {
            const violations = numberGuard.noteAssistantText(frame.assistantText);
            if (violations.length > 0) handleNumberViolations(violations);
          }
          if (frame.turnComplete) {
            numberGuard.endAssistantTurn();
            suppressTurnAudio = false;
          }
        }
        const audioChunks = extractModelAudioParts(message);
        // Withheld audio is COUNTED, never silently vanished: mutedChunks in
        // the teardown diag is how a "the AI went quiet" report is told apart
        // from a session that generated nothing.
        if (audioChunks.length > 0 && (modelAudioMuted || suppressTurnAudio)) {
          diag.mutedChunks += audioChunks.length;
        } else {
          for (const chunk of audioChunks) {
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
        // `teardown` (called from ws.on("close")) will do the same, both paths
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

  // Feed every coordinator text cue to the spoken-number guard from ONE
  // choke point rather than at each of the dozen cue sites: a cue site added
  // later that skipped seeding would make the guard cut a legitimately-given
  // number as fabricated, and a false positive is the one failure this guard
  // must never have. Installed before `sessionAssigned` flips so no cue can
  // race past it. Same wrap-the-send pattern as tapSessionSocket below.
  if (numberGuard) {
    const target = session as unknown as {
      sendRealtimeInput: (arg: Record<string, unknown>) => unknown;
    };
    const orig = target.sendRealtimeInput.bind(session);
    target.sendRealtimeInput = (arg: Record<string, unknown>) => {
      try {
        if (arg && typeof arg.text === "string") numberGuard.allowText(arg.text);
      } catch {
        // the guard must never break a send
      }
      return orig(arg);
    };
  }

  sessionAssigned = true;
  // Flush a greeting cue that raced connect: `setupComplete` frequently
  // arrives while `ai.live.connect` is still awaiting (the SDK dispatches
  // onmessage from inside connect), in which case the handler deferred the
  // cue because `session` wasn't assigned yet. Send it now, without this
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
  // (and which @google/genai is deployed, the regression suspect).
  emitDiag("voice_bridge_gemini_session_start", {
    sdk_version: GENAI_SDK_VERSION,
    model: opts.model,
    transcription_enabled: Boolean(transcriptRecorder),
    number_guard: Boolean(numberGuard),
    deterministic_voicemail: Boolean(opts.deterministicVoicemail),
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
      // `script` earns an explicit flag: for twelve days the voicemail script
      // was silently dropped from this payload, and this diag's
      // data_type:"none" is what finally proved it on the wire.
      has_script: typeof response.script === "string" && response.script !== "",
      data_keys:
        response.data && typeof response.data === "object" && !Array.isArray(response.data)
          ? Object.keys(response.data as Record<string, unknown>).slice(0, 20)
          : null
    });
    pushTrail("toolResp:" + name);
    // The payload builder lives in tool-response-payload.ts, where a test pins
    // every ToolResult field to the wire.
    const payload = toolResponsePayload(response);
    // Everything a tool hands the model is a legitimate source for spoken
    // numbers (slot confirmations, the voicemail script, capture echoes).
    numberGuard?.allowText(JSON.stringify(payload));
    try {
      session.sendToolResponse({
        functionResponses: [
          {
            id,
            name,
            response: payload
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
    // Whether THIS turn also asks to hang up. The loop below is synchronous
    // but the capabilities it kicks off are not, so a same-turn
    // `voicemail_reached` + `end_call` pair would otherwise start the
    // voicemail claim before the end_call handler can set
    // `endCallRequested`: the entry guard alone cannot see it (Bugbot,
    // PR #1672).
    const batchRequestsEndCall = calls.some((c) => c.name === "end_call");
    // Same shape, same turn, for the accept press: a `press_digits` +
    // `voicemail_reached` pair means the model is STILL in the partner's menu
    // and the press has not even reached Telnyx yet, so the voicemail guard
    // below must refuse rather than read a mailbox script into that menu
    // (Bugbot, PR #1716).
    const batchRequestsAcceptPress = calls.some((c) => c.name === "press_digits");
    for (const call of calls) {
      const name = call.name ?? "unknown";
      // Debug: which tool the model invoked + its arg keys (not values, to
      // limit PII). Pinpoints whether a specific tool triggers the 1007.
      emitDiag("voice_bridge_gemini_tool_call", {
        name,
        has_id: Boolean(call.id),
        arg_keys: call.args && typeof call.args === "object" ? Object.keys(call.args).slice(0, 20) : []
      });
      // Once interpreting, the model has no business taking actions: it is
      // relaying two humans' words, and anything it "books" or "sends" would be
      // its own reading of a conversation it is not part of. The prompt says so,
      // but the declarations stay registered from before the handoff (Gemini
      // Live cannot re-declare mid-session), so refuse them here too.
      if (translatorActive) {
        // Asking to START interpreting while already interpreting is a no-op,
        // not a failure. Observed live (Amy's tenant, 2026-07-26): the model
        // called start_translator_mode three times in ~600ms, and answering the
        // repeats with the generic "tools are unavailable" error had it
        // re-announce its readiness twice in a row to the staff member. Confirm
        // the state it is asking for instead.
        if (name === "start_translator_mode") {
          emitDiag("voice_bridge_translator_already_active", {});
          sendToolResponse(call.id, name, { ok: true, detail: "already interpreting" });
          continue;
        }
        // The way OUT has to survive the blanket refusal, or interpreting could
        // never end: observed live, a colleague said "they hung up, thanks for
        // translating" and had it translated into Spanish for someone who had
        // already left.
        if (name === "stop_translator_mode") {
          if (translatorEntry !== "staff_request") {
            // A warm transfer has a real customer bridged in who never asked to
            // be handed back to a receptionist mid-conversation.
            emitDiag("voice_bridge_translator_stop_refused", { entry: translatorEntry });
            sendToolResponse(call.id, name, {
              ok: false,
              detail: "keep interpreting: this call was handed to you as a transfer"
            });
            continue;
          }
          // Cue FIRST, then flip state, mirroring the entry path. Clearing the
          // flags before a cue that then throws would report a handback that
          // never happened: the model would keep interpreting with the ceiling
          // already cancelled.
          try {
            session.sendRealtimeInput({
              text: translatorModeEndCue({ humanName: opts.callerIdentity?.name })
            });
          } catch (err) {
            console.error("gemini-bridge: translator end cue failed", err);
            emitDiag("voice_bridge_translator_end_cue_failed", {
              error: err instanceof Error ? err.message : String(err)
            });
            sendToolResponse(call.id, name, {
              ok: false,
              detail: "could not stop interpreting: keep relaying for now"
            });
            continue;
          }
          translatorActive = false;
          translatorEntry = null;
          if (translatorCeilingTimer) {
            clearTimeout(translatorCeilingTimer);
            translatorCeilingTimer = null;
          }
          if (sessionCapDeferredByTranslator) {
            // The call is back to being an ordinary assistant call, and both of
            // its bounds are now gone. Re-arm: whatever is left of the original
            // budget, or a short grace when interpreting outlasted it.
            sessionCapDeferredByTranslator = false;
            const remainingMs = opts.sessionMaxMs - (Date.now() - sessionStartedAtMs);
            const capMs = remainingMs > 0 ? remainingMs : TRANSLATOR_EXIT_GRACE_MS;
            timers.push(scheduleSessionCapTeardown(capMs));
            emitDiag("voice_bridge_session_cap_rearmed", { cap_ms: capMs });
          }
          emitDiag("voice_bridge_translator_mode_exited", {});
          console.log("gemini-bridge: translator mode exited", {
            callControlId: opts.callControlId
          });
          sendToolResponse(call.id, name, { ok: true, detail: "back to assistant" });
          continue;
        }
        emitDiag("voice_bridge_translator_tool_refused", { name });
        sendToolResponse(call.id, name, {
          ok: false,
          detail: "interpreting: tools are unavailable on this call"
        });
        continue;
      }
      if (name === "stop_translator_mode") {
        // Reached only when NOT interpreting (the guard above handles the live
        // case). Asking to stop something that is not running is a no-op.
        sendToolResponse(call.id, name, { ok: true, detail: "not interpreting" });
        continue;
      }

      if (name === "start_translator_mode") {
        // STAFF ONLY, checked here as well as at declaration time: a customer
        // must never be able to silence the receptionist for the rest of a call.
        const requesterIsStaff =
          opts.callerIdentity != null && opts.callerIdentity.kind !== "customer";
        if (!requesterIsStaff) {
          emitDiag("voice_bridge_translator_staff_refused", {});
          sendToolResponse(call.id, name, {
            ok: false,
            detail: "translator mode is only available to the business's own team"
          });
          continue;
        }
        // Settings → Coworker tools. The declaration is already withheld when
        // disabled; refuse here too so a stale session cannot slip through.
        if (!opts.translatorOnRequestEnabled) {
          emitDiag("voice_bridge_translator_tool_disabled", {});
          sendToolResponse(call.id, name, {
            ok: false,
            detail:
              "The owner turned this tool off under Settings → Coworker tools. Tell them plainly instead of pretending it worked."
          });
          continue;
        }
        const otherLanguage =
          typeof call.args?.otherLanguage === "string"
            ? (call.args.otherLanguage as string).slice(0, 40)
            : undefined;
        // Unlike the post-transfer path this needs no target-legs arming: the AI
        // is already audible on the staff member's own leg, and whatever they
        // merge in (carrier three-way or a conference) hears it through that
        // same leg's audio. So there is nothing to fail open to.
        try {
          session.sendRealtimeInput({
            text: translatorModeCue({
              entry: "staff_request",
              humanName: opts.callerIdentity?.name,
              otherLanguage
            })
          });
        } catch (err) {
          console.error("gemini-bridge: staff translator cue failed", err);
          emitDiag("voice_bridge_translator_cue_failed", {
            entry: "staff_request",
            error: err instanceof Error ? err.message : String(err)
          });
          sendToolResponse(call.id, name, {
            ok: false,
            detail: "could not switch to interpreting"
          });
          continue;
        }
        translatorActive = true;
        translatorEntry = "staff_request";
        // Same marker as the transfer path: whoever the colleague adds to the
        // call arrives on the same undiarized stream they are already on.
        void transcriptRecorder?.markInterpreting();
        emitDiag("voice_bridge_translator_mode_entered", {
          entry: "staff_request",
          other_language: otherLanguage ?? null
        });
        console.log("gemini-bridge: translator mode entered (staff request)", {
          callControlId: opts.callControlId
        });
        // The tool response lands BEFORE the flag is read by the wind-down
        // timers, so acknowledge after flipping it.
        sendToolResponse(call.id, name, { ok: true, detail: "interpreting" });
        scheduleTranslatorCeiling();
        continue;
      }

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
          // TRANSLATOR MODE: stay on the line as an interpreter instead of
          // leaving. Only when the call was ARMED at answer time, because the
          // Telnyx target-legs parameter has to be set before the legs bridge:
          // an unarmed call's fork can only reach the caller, so staying would
          // mean talking over the caller while the human hears nothing.
          if (result.ok && opts.transfer!.translatorMode === true && !transferDetachRequested) {
            // Armed is only half the question. Being armed says the human CAN
            // hear us; this says somebody actually needs an interpreter. On
            // 2026-08-18 (call 5634b7f0) the flag alone let the AI stay on an
            // all-English call and translate a teammate's "Hello" into "Hola".
            const interpret = resolveInterpretDecision({
              established: opts.languagePrefs?.established ?? null,
              defaultLang: opts.languagePrefs?.defaultLang ?? "en",
              callerTurns: callerSpeech.turns()
            });
            if (!interpret.engage || interpret.callerLanguage === null) {
              emitDiag("voice_bridge_translator_mode_skipped", {
                reason: interpret.reason,
                colleague_language: interpret.colleagueLanguage,
                turns_considered: interpret.turnsConsidered
              });
              console.log("gemini-bridge: interpreting not needed, detaching", {
                callControlId: opts.callControlId,
                reason: interpret.reason
              });
            } else {
              // Set BEFORE the cue so the wind-down timers (which check this) can
              // never fire between arming and the cue landing.
              translatorActive = true;
              translatorEntry = "transfer";
              try {
                session.sendRealtimeInput({
                  text: translatorModeCue({
                    callerLanguage: interpret.callerLanguage,
                    colleagueLanguage: interpret.colleagueLanguage,
                    humanName: opts.transfer!.humanName,
                    discloseToHuman: opts.transfer!.discloseToHuman !== false
                  })
                });
                // Mark the transcript so the call view can say the AI stayed
                // on the line, and stop attributing post-bridge turns to the
                // caller alone (both humans arrive on one undiarized stream).
                void transcriptRecorder?.markInterpreting();
                emitDiag("voice_bridge_translator_mode_entered", {
                  reason: reason ?? null,
                  caller_language: interpret.callerLanguage,
                  colleague_language: interpret.colleagueLanguage,
                  decided_by: interpret.reason
                });
                console.log("gemini-bridge: translator mode entered", {
                  callControlId: opts.callControlId
                });
              } catch (err) {
                // The cue is the whole feature: without it the model keeps its
                // receptionist reflexes while audible to both parties. Fall back
                // to the normal detach so we degrade to today's behavior rather
                // than leaving a receptionist in the middle of their call.
                console.error("gemini-bridge: translator cue failed, detaching", err);
                emitDiag("voice_bridge_translator_cue_failed", {
                  error: err instanceof Error ? err.message : String(err)
                });
                translatorActive = false;
                translatorEntry = null;
              }
              if (translatorActive) {
                // Hold the session open for the human conversation, then leave
                // cleanly when the interpreter ceiling is reached. Returning
                // (not falling through) is what keeps the fork attached.
                scheduleTranslatorCeiling();
                return;
              }
            }
          }
          // On a SUCCESSFUL warm transfer the caller is now bridged to a human,
          // so the AI must leave the line, otherwise it keeps injecting audio
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

      if (name === "press_digits" && opts.dtmf) {
        const requested =
          typeof call.args?.digits === "string" ? (call.args.digits as string).trim() : "";
        // Fall back to the authored digit rather than refusing: the model heard
        // the cue, which is the hard part, and an empty or malformed argument
        // should not cost the referral.
        const digits = /^[0-9A-D#*wW]{1,32}$/.test(requested)
          ? requested
          : (ivrGate?.digit ?? "1");
        void (async () => {
          const ok = await pressAcceptDigit(digits, "model");
          sendToolResponse(call.id, name, {
            ok,
            detail: ok ? `pressed ${digits}` : "press failed"
          });
        })();
        continue;
      }

      if (name === "voicemail_reached" && opts.voicemail) {
        // A recording reported after `end_call` is a message nobody can hear:
        // the hangup timer is already running, so a script handed over now
        // would be read into a dead or dying line while the claim, the
        // [Voicemail] badge and the spoken stamp all record a delivered
        // voicemail. That exact sequence produced `voicemail_left: true` for
        // a mailbox holding three minutes of silence (2026-08-26, call
        // 68ca8cdb: the model greeted the greeting, sat through the maximum
        // recording time, and only reported the recording as the leg
        // dropped). Refuse BEFORE the capability runs so nothing is claimed
        // or recorded. `batchRequestsEndCall` covers the same-turn pair: the
        // capability starts synchronously here, before the loop reaches the
        // batch's own end_call, so the flag alone would miss it.
        //
        // Deterministic mode narrows this to `endCallRequested` only: a
        // same-batch end_call arriving AFTER this handler has not scheduled
        // anything yet, and the deterministic branch below sets the pending
        // stamp synchronously, so when the loop reaches that end_call it is
        // deferred and the platform keeps the leg for the scripted speak.
        // With an end_call from an EARLIER turn the hangup timer is already
        // burning and nothing can be delivered, so the refusal stands.
        if (endCallRequested || (batchRequestsEndCall && !opts.deterministicVoicemail)) {
          sendToolResponse(call.id, name, {
            ok: false,
            detail: "the call is already ending: leave no message and say nothing"
          });
          emitDiag("voice_bridge_voicemail_after_end_call", {});
          continue;
        }
        // A gated session is ANSWERED INTO a recording by design: the partner's
        // own menu ("press one to agree to our referral fee", "connecting you
        // now") plays before the person we want is dialled in at all. Every
        // word of it matches "you reached a machine", so before the accept
        // digit lands a voicemail verdict cannot be about the seller, and
        // acting on it would stamp the call a machine and hang up on a
        // referral that had not started. Refuse until the press is in.
        // Deterministic on purpose: the rule enumerates mailbox phrasing and
        // the partner's menu is not in that list, but the whole reason this
        // exists is that a prompt line alone does not hold
        // ([[ai-invents-callback-numbers-on-voicemail]]). Counted so a spike
        // reads as a model mistiming, not as this guard being wrong.
        //
        // The test is `acceptPressCount`, NOT `acceptPressed`: the latter is
        // claimed synchronously before the Telnyx request is even sent, and
        // is only cleared once a failed press returns, so it reads true
        // throughout the window where nothing has been accepted. The count
        // rises only after Telnyx returns ok, which is the real "we are
        // through the gate" moment; the batch check states the same-turn case
        // outright rather than resting on the loop staying synchronous
        // (Bugbot, PR #1716).
        if (ivrGate && (acceptPressCount === 0 || batchRequestsAcceptPress)) {
          sendToolResponse(call.id, name, {
            ok: false,
            detail:
              "that is the referral service's own menu, not a mailbox: stay silent, press the accept digit, and wait to be connected"
          });
          emitDiag("voice_bridge_voicemail_before_accept", {});
          continue;
        }
        // DETERMINISTIC MODE: the verdict is accepted and the model's job on
        // this call is OVER. On 2026-08-29 (call 5e325829) the model was
        // handed this exact moment and betrayed it: it claimed the voicemail,
        // rewrote the script with an invented "offer came through" and a
        // fabricated callback number, and ended the leg 9 seconds after the
        // verdict, before the resolution sweep's 25s grace could act. So in
        // this mode the tool response carries NO script, the model's audio is
        // muted for the rest of the call (plus a queue flush for anything
        // already in flight), the capability stamps the verdict WITHOUT
        // claiming the speak, and the edge (greeting.ended handler, else the
        // AMD resolution sweep) speaks the authored script over Telnyx TTS,
        // verbatim by construction. The pending stamp is set SYNCHRONOUSLY so
        // a same-batch end_call reaching the loop after this is deferred.
        if (opts.deterministicVoicemail) {
          // First report starts the clock; a repeat must NOT re-credit the
          // end_call hold, or a model looping this tool could pin the leg
          // past the failsafe window.
          if (voicemailDeterministicPendingAtMs === 0) {
            voicemailDeterministicPendingAtMs = Date.now();
          }
          modelAudioMuted = true;
          try {
            if (opts.ws.readyState === WebSocket.OPEN) opts.ws.send(telnyxClearMessage());
          } catch (err) {
            console.error("gemini-bridge: telnyx clear failed (voicemail)", err);
          }
          void (async () => {
            let result: Awaited<ReturnType<VoicemailCapability["execute"]>>;
            try {
              result = await opts.voicemail!.execute();
            } catch (err) {
              console.error("gemini-bridge: voicemail_reached execute threw", err);
              result = { ok: false, detail: "voicemail record failed" };
            }
            if (!result.ok) {
              // The stamp never landed, so no resolver is coming for this
              // leg: lift the end_call hold and tell the model to end it.
              // The mute stays, model audio into a mailbox is never useful.
              voicemailDeterministicPendingAtMs = 0;
              sendToolResponse(call.id, name, {
                ok: false,
                detail: "voicemail record failed: say nothing and call end_call now"
              });
            } else {
              sendToolResponse(call.id, name, {
                ok: true,
                detail: VOICEMAIL_DETERMINISTIC_TOOL_REPLY
              });
            }
            emitDiag("voice_bridge_voicemail_deterministic", {
              ok: result.ok,
              detail: result.detail ?? null
            });
          })();
          continue;
        }
        // Answered on its own task so the model's turn completes promptly: it
        // is waiting on this response to know whether to read a message, and
        // the mailbox is recording silence while it waits.
        void (async () => {
          // Derived from the capability rather than re-declared, so a field
          // added there (alreadyBeingLeft, and whatever comes next) can never
          // silently fall out of this handler's view again.
          let result: Awaited<ReturnType<VoicemailCapability["execute"]>>;
          try {
            result = await opts.voicemail!.execute();
          } catch (err) {
            console.error("gemini-bridge: voicemail_reached execute threw", err);
            result = { ok: false, detail: "voicemail record failed" };
          }
          const script = (result.script ?? "").trim();
          // Three endings, not two. A lost claim means a message is ALREADY
          // playing into this recording from the other path, so telling the
          // model to hang up would cut it off mid-sentence; that case waits
          // and lets the side holding the claim end the call.
          const detail = script
            ? "read this message aloud word for word, then end the call"
            : result.alreadyBeingLeft
              ? "a message is already being left on this recording: say nothing, and do NOT end the call"
              : "leave no message: say nothing and end the call now";
          if (script) {
            voicemailScriptGiven = true;
            voicemailScriptGivenAtMs = Date.now();
            voicemailScriptChars = script.length;
          }
          sendToolResponse(call.id, name, {
            ok: result.ok,
            ...(script ? { script } : {}),
            ...(result.alreadyBeingLeft ? { alreadyBeingLeft: true } : {}),
            detail
          });
          emitDiag("voice_bridge_voicemail_reached", {
            ok: result.ok,
            has_script: Boolean(script),
            already_being_left: result.alreadyBeingLeft === true,
            detail: result.detail ?? null
          });
        })();
        continue;
      }

      if (name === "end_call" && opts.hangup) {
        // The platform still owes this mailbox the scripted voicemail: refuse
        // to end the leg. On 2026-08-29 the model's end_call killed the call
        // 9 seconds after its own machine verdict, so no deterministic
        // speaker ever got a turn. Bounded by VOICEMAIL_END_CALL_HOLD_MS so a
        // broken resolver can never pin a leg: past the window the refusal
        // lifts, and the mailbox's own recording limit bounds the leg anyway.
        if (
          voicemailDeterministicPendingAtMs > 0 &&
          Date.now() - voicemailDeterministicPendingAtMs < VOICEMAIL_END_CALL_HOLD_MS
        ) {
          sendToolResponse(call.id, name, {
            ok: false,
            detail: VOICEMAIL_DETERMINISTIC_END_CALL_REPLY
          });
          emitDiag("voice_bridge_end_call_deferred_for_voicemail", {
            pending_ms: Date.now() - voicemailDeterministicPendingAtMs
          });
          continue;
        }
        const reason =
          typeof call.args?.reason === "string" ? (call.args.reason as string) : undefined;
        // Acknowledge immediately so the model's turn completes cleanly, then
        // hang up after a short grace so the spoken goodbye finishes playing.
        sendToolResponse(call.id, name, { ok: true, detail: "ending call" });
        // Confirm a delivered voicemail NOW, not behind the playout grace
        // below: the script has been read, so the line is about to go quiet,
        // and a mailbox hangs up on silence. Its own hangup would otherwise
        // reach the call-end webhook first and record a message that really
        // did go out as never left.
        //
        // ...but only when the read PLAUSIBLY happened. Playout is realtime,
        // so an `end_call` seconds after the script handover means at most
        // seconds of it reached the line, whatever the model generated:
        // calls 06a44d56 (hung up 13s after answer) and e71b585d (mailbox
        // greeting still playing at hangup) both recorded left voicemails
        // that physically were not. A refused stamp resolves the call as
        // no-voicemail, which understates once and is counted in the
        // diagnostic below; the old unconditional stamp lied to the owner.
        const graceMs = opts.hangup.graceMs ?? 3000;
        if (voicemailScriptGiven && opts.voicemail?.confirmSpoken) {
          voicemailScriptGiven = false;
          // The audio window ends when the FIRST end_call's hangup timer
          // fires, so a duplicate end_call arriving later must not re-credit
          // a grace that is already burning, or has burned: on the first
          // end_call the hangup is scheduled NOW (full grace ahead), on a
          // repeat it was scheduled back then (Bugbot, PR #1672).
          const hangupAtMs = (endCallRequested ? endCallRequestedAtMs : Date.now()) + graceMs;
          const playableMs = hangupAtMs - voicemailScriptGivenAtMs;
          if (
            voicemailPlausiblyDelivered({ playableMs, scriptChars: voicemailScriptChars })
          ) {
            void opts.voicemail.confirmSpoken().catch((err) => {
              console.error("gemini-bridge: voicemail confirmSpoken threw", err);
            });
          } else {
            console.error(
              "gemini-bridge: voicemail read cut short, not confirming",
              JSON.stringify({ playableMs, graceMs, scriptChars: voicemailScriptChars })
            );
            emitDiag("voice_bridge_voicemail_cut_short", {
              playable_ms: playableMs,
              grace_ms: graceMs,
              script_chars: voicemailScriptChars
            });
          }
        }
        if (!endCallRequested) {
          endCallRequested = true;
          endCallRequestedAtMs = Date.now();
          // Deliberately a STANDALONE timer, NOT pushed to `timers`. The PSTN
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
  // immediately at answer, right over the greeting. Cap the warn lead-in to half
  // the session and the final-nudge lead-in to a quarter so the wind-down always
  // lands near the end, with the greeting given room first. (For a normal
  // ~14-minute session these mins are no-ops.)
  const effWarnBeforeMs = Math.min(warnBeforeMs, Math.floor(sessionMaxMs / 2));
  const effFinalNudgeBeforeMs = Math.min(finalNudgeBeforeMs, Math.floor(sessionMaxMs / 4));
  const warnAt = Math.max(0, sessionMaxMs - effWarnBeforeMs);
  const nudgeAt = Math.max(0, sessionMaxMs - effFinalNudgeBeforeMs);

  // Wind-down coordinator cues. When the binding limit is the AI BUDGET (not the
  // normal time cap) we can't offer "the assistant can keep helping" or "someone
  // will help you right after", the AI genuinely can't continue, so we frame
  // it as the owner being unavailable and steer the caller to text instead.
  const warnText = budgetCapped
    ? `[Coordinator, speak aloud] You need to start wrapping up this call now. Warmly let the caller know you have to go shortly and that the owner isn't available right now, and invite them to send ${name} a text message so someone can follow up.`
    : `[Coordinator, speak aloud] The AI session will end in about ${Math.max(1, Math.round(effWarnBeforeMs / 60000))} minute(s). Give the caller a warm heads-up that you're wrapping up, and that ${name} can help them directly afterward if needed.`;
  const nudgeText = budgetCapped
    ? `[Coordinator, speak aloud] Finish your thought and give a very brief, warm goodbye now. Let them know the owner isn't available right now and that they can text ${name} and someone will get back to them.`
    : `[Coordinator, speak aloud] Finish your thought and deliver a very brief, warm goodbye now. Let them know someone at ${name} can follow up if they still need help.`;
  const finalText = budgetCapped
    ? `[Coordinator, speak aloud] Wrap up immediately. Say one short, friendly goodbye, the owner isn't available right now, so invite them to text ${name}, and thank them for calling.`
    : `[Coordinator, speak aloud] Session time limit reached. Say one short, friendly goodbye and thank them for calling ${name}.`;

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

  // IVR gate backstop. The model pressing on cue is the good path; this covers
  // the recording being worded unusually, or the model simply not calling the
  // tool. Not pressing at all forfeits the referral, so a blind press is
  // strictly better than waiting.
  if (ivrGate) {
    // Default 20s, not 12: HomeLight's announcement routinely outlasts 12s
    // and a blind press mid-announcement lands before the menu listens
    // (Amy forfeited a referral to exactly this; the fallback-20 one-shot
    // moved her live flow and this default follows it).
    const fallbackMs = Math.min(Math.max(ivrGate.fallbackMs ?? 20000, 1000), 60000);
    timers.push(
      setTimeout(() => {
        if (acceptPressed || ended) return;
        void pressAcceptDigit(ivrGate.digit, "fallback");
      }, fallbackMs)
    );
  }

  // Mid-call brief: an AI-first call answers within seconds of the partner's
  // alert, so the details its own flow extracts land while the AI is already
  // talking. Poll the session's note and, when it changes, hand it over as a
  // NON-spoken cue: the model weaves it in and acknowledges it arrived, which is
  // the whole point: the customer must not be asked to repeat what we now have.
  // Suppressed during translator mode (the AI is interpreting two humans, not
  // running an intake) and after the session ends.
  if (intake?.pollBrief) {
    const pollBrief = intake.pollBrief;
    let briefedNote = (intake.contextNote ?? "").trim();
    let briefPollInFlight = false;
    const briefPoll = setInterval(() => {
      if (ended || translatorActive || briefPollInFlight) return;
      briefPollInFlight = true;
      void pollBrief()
        .then((note) => {
          const next = (note ?? "").trim();
          if (!next || next === briefedNote || ended || translatorActive) return;
          // voice_set_call_brief APPENDS, so the field holds everything the model
          // has ever been told. Send only what is new: announcing the pre-call
          // alert text as having "just arrived" would have the AI tell the
          // customer their details came through when nothing actually changed.
          const delta = next.startsWith(briefedNote)
            ? next.slice(briefedNote.length).trim()
            : next;
          briefedNote = next;
          if (!delta) return;
          session.sendRealtimeInput({
            text:
              `[Coordinator, do NOT read this aloud] The office just received the client's details: ${delta} ` +
              "Use them from now on and never ask for anything they cover. If the customer already gave you one of these, or you had to ask because we did not have them, briefly acknowledge that their information has now come through so they never repeat themselves. Then carry on naturally from wherever the conversation is."
          });
          console.log("gemini-bridge: mid-call brief delivered", {
            callControlId: opts.callControlId,
            chars: delta.length
          });
          emitDiag("voice_bridge_midcall_brief", { chars: delta.length });
        })
        .catch((err) => {
          console.warn("gemini-bridge: mid-call brief poll failed (non-fatal)", err);
        })
        .finally(() => {
          briefPollInFlight = false;
        });
    }, 15000);
    timers.push(briefPoll as unknown as NodeJS.Timeout);
  }

  // Every wind-down cue is suppressed once translator mode takes over: they are
  // written for an AI-led call ("you need to start wrapping up", "say goodbye"),
  // and firing one mid-interpretation would have the interpreter announce a
  // session limit to two people having their own conversation. The interpreted
  // stretch is bounded by scheduleTranslatorCeiling() instead. The diagnostics
  // heartbeat deliberately keeps running, so an interpreted call stays as
  // observable as any other.
  timers.push(
    setTimeout(() => {
      if (ended || translatorActive) return;
      // Realtime text (not sendClientContent) so this coordinator cue stays in
      // the same auto-VAD turn regime as the caller's audio; a manual turn here
      // would make the caller's next reply close the session with 1007.
      session.sendRealtimeInput({ text: warnText });
    }, warnAt)
  );

  timers.push(
    setTimeout(() => {
      if (ended || translatorActive) return;
      session.sendRealtimeInput({ text: nudgeText });
    }, nudgeAt)
  );

  /**
   * The session cap's wind-down and teardown. A function declaration so the
   * translator exit (defined earlier in the file, called later in time) can
   * re-arm it after the one-shot timer below was consumed mid-interpretation.
   */
  function scheduleSessionCapTeardown(delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (ended || translatorActive) return;
      void (async () => {
        try {
          session.sendRealtimeInput({ text: finalText });
          await new Promise((r) => setTimeout(r, 1200));
        } catch {
          /* ignore */
        }
        await teardown();
      })();
    }, delayMs);
  }

  timers.push(
    setTimeout(() => {
      if (ended) return;
      if (translatorActive) {
        // Consumed: remember so the exit can re-arm rather than leaving the
        // call uncapped once the interpreter ceiling is also gone.
        sessionCapDeferredByTranslator = true;
        return;
      }
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
    // whitespace between key and value (`"event": "media"`), every audio
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
      // frame actually decoded as RTP, never strip a frame the decoder
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
      // raw L16, both are decoded correctly by `decodeTelnyxMediaPayload`).
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
      // That's exactly what manifested as "ring then silence" on calls,
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
