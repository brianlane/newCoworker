/**
 * Telnyx Call Control API helpers (Programmable Voice).
 * Shared by Edge functions; Vitest imports this module directly (see `tests/telnyx-lib.test.ts`).
 *
 * §5.1 idempotency: Telnyx Programmable Voice /answer does not document a request idempotency key
 * comparable to Messaging. Correctness relies on DB state (`answer_issued_at`, reservation lifecycle)
 * + webhook `telnyx_webhook_try_begin` single-flight per `event_id`.
 */

/**
 * Which legs of a bridged call hear the audio we inject on the media stream
 * (Telnyx `stream_bidirectional_target_legs`).
 *
 * Telnyx defaults to `opposite`, which is why a normal call works the way it
 * does: the AI's audio reaches the PSTN party and nobody else, and after the AI
 * warm-transfers, the bridge REMOVES its fork so the caller and the human get a
 * private conversation.
 *
 * `both` is what translator mode needs: once the transfer bridges the caller to
 * a human, the AI must be audible to BOTH of them to interpret between them.
 * Paired with the `both_tracks` fork we already request, which is what lets the
 * AI hear both sides.
 *
 * Only ever sent when translator mode is armed for the call. Omitted otherwise,
 * so the request body for every other call stays byte-identical to what shipped
 * before this existed.
 */
export type TelnyxStreamTargetLegs = "both" | "self" | "opposite";

export type TelnyxAnswerStreamOptions = {
  streamUrl: string;
  clientState?: string;
  /** Omit for Telnyx's `opposite` default. `both` arms translator mode. */
  targetLegs?: TelnyxStreamTargetLegs;
};

export async function telnyxAnswerPlain(
  apiKey: string,
  callControlId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
}

/**
 * POST /v2/calls/{call_control_id}/actions/answer with bidirectional media stream.
 *
 * Codec/rate notes (verified against Telnyx OpenAPI for /actions/answer and
 * /actions/streaming_start, May 2026):
 *
 *   - `stream_codec`: codec for the INBOUND fork (caller → bridge). Default
 *     `"default"` means the call's native PSTN codec, almost always
 *     PCMU 8 kHz µ-law. We force `"L16"` so the bridge gets uncompressed
 *     16-bit PCM and can hand it straight to Gemini Live (which expects
 *     `audio/pcm`).
 *   - `stream_bidirectional_mode: "rtp"`: outbound (bridge → caller) is
 *     RTP-wrapped. The bridge has a per-call RTP framer in
 *     `vps/voice-bridge/src/rtp-frame.ts` that strips/synthesizes the
 *     12-byte header so the round trip stays binary-identical to what
 *     Telnyx negotiates.
 *   - `stream_bidirectional_codec: "L16"`: outbound payload is L16 PCM.
 *   - `stream_bidirectional_sampling_rate: 16000`: outbound runs at 16 kHz
 *     to match `TELNYX_PCM_RATE` in the bridge. Without this field Telnyx
 *     defaults the OUTBOUND rate to 8 kHz, and the bridge's L16 16 kHz
 *     frames played back at 8 kHz sound like sped-up chipmunk noise (or,
 *     more often, Telnyx silently discards them because they miss the
 *     expected packet cadence). The legacy `stream_sampling_rate` field
 *     used here previously is NOT in the Telnyx schema and was ignored,
 *     left in place undetected, it was the root cause of the May 2026
 *     "one ring then silence" outage.
 */
export async function telnyxAnswerWithStream(
  apiKey: string,
  callControlId: string,
  opts: TelnyxAnswerStreamOptions,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`;
  const body: Record<string, unknown> = {
    stream_url: opts.streamUrl,
    stream_track: "both_tracks",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 16000
  };
  // Only present when translator mode is armed; see TelnyxStreamTargetLegs.
  if (opts.targetLegs) {
    body.stream_bidirectional_target_legs = opts.targetLegs;
  }
  if (opts.clientState) {
    body.client_state = opts.clientState;
  }

  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

/**
 * Telnyx's code for "you issued a command against a call that is already
 * gone" (HTTP 422, title "Call has already ended").
 */
export const TELNYX_CALL_ALREADY_ENDED_CODE = "90018";

/**
 * True when an answer (or any call command) was refused because the caller
 * had already hung up.
 *
 * This is a RACE, not a fault. Telnyx delivers `call.initiated` while the
 * phone is still ringing, and a caller who changes their mind mid-ring ends
 * the call before our answer lands. Amy Laidlaw's line saw it on 2026-08-30:
 * the reservation row was written at 08:23:50.432Z and Telnyx refused the
 * answer 335ms later, so nobody was ever on the line to be let down.
 *
 * Worth its own branch because the generic answer-failure path treats every
 * refusal as an outage: it logs at `level: "error"`, which puts an abandoned
 * ring on the admin System Errors card beside expired API keys and dead SIP
 * credentials, and it answers the webhook 500, which invites Telnyx to retry
 * delivery for a call that cannot exist any more.
 *
 * Keyed on the CODE, not the status: 422 alone also covers real rejections
 * (bad stream URL, malformed body) that must keep failing loudly. A 5xx is
 * never treated as benign, whatever body it carries, since an upstream
 * failure telling us the call ended is not evidence that it did.
 */
export function isCallAlreadyEndedResponse(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // An unparseable body is not proof of anything; fail toward the loud path.
    return false;
  }
  const errors = (parsed as { errors?: unknown })?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) => String((e as { code?: unknown })?.code ?? "") === TELNYX_CALL_ALREADY_ENDED_CODE
  );
}

export async function telnyxSpeak(
  apiKey: string,
  callControlId: string,
  text: string,
  voice = "female",
  fetchImpl: typeof fetch = fetch,
  language = "en-US"
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      payload: text,
      voice,
      language
    })
  });
}

/**
 * Detach the Gemini media fork from a leg (`streaming_stop`) without ending
 * the call.
 *
 * The AMD path needs this: the bridge is attached on call.answered, before
 * anyone knows a machine picked up. Hanging up used to silence it implicitly.
 * A leg kept alive to leave a voicemail has to silence it explicitly, or the
 * recording captures the assistant talking over the message.
 */
export async function telnyxStreamingStop(
  apiKey: string,
  callControlId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
}

export async function answerThenSpeak(
  apiKey: string,
  callControlId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  language = "en-US"
): Promise<void> {
  const ans = await telnyxAnswerPlain(apiKey, callControlId, fetchImpl);
  if (!ans.ok) {
    console.error("answer plain failed", callControlId, ans.status, await ans.text());
    return;
  }
  const sp = await telnyxSpeak(apiKey, callControlId, text, "female", fetchImpl, language);
  if (!sp.ok) {
    console.error("speak failed", callControlId, sp.status, await sp.text());
  }
}

export type TelnyxTransferOptions = {
  /**
   * Ring timeout (seconds) for the transfer target. When the target does not
   * answer within this window Telnyx hangs up the new (B) leg with a no-answer
   * cause and leaves the original (A) leg under our control, that is what lets
   * the handoff chain fall through to the next step. Omit for an open-ended ring.
   */
  timeoutSecs?: number;
  /**
   * Answering-machine detection on the TRANSFER'S new (B) leg. Same modes as
   * TelnyxDialOptions. Why here: a step target whose phone is off goes to
   * carrier voicemail in a couple of seconds, well inside any ring window, and
   * a transfer auto-bridges on answer, so without AMD the caller is connected
   * to a teammate's voicemail greeting and the chain never advances past it.
   */
  answeringMachineDetection?: TelnyxDialOptions["answeringMachineDetection"];
  /**
   * Opaque state echoed back on this transfer's resulting call-control webhooks
   * (e.g. call.bridged / call.hangup for the B leg). The handoff state machine
   * uses it to correlate a no-answer hangup back to the chain step that issued
   * the transfer. Telnyx requires this be base64; callers pass plain text and we
   * encode it here.
   */
  clientState?: string;
};

function encodeClientState(raw: string): string {
  // Deno/edge runtime has btoa; mirror what the SMS worker does for client_state.
  return btoa(unescape(encodeURIComponent(raw)));
}

/**
 * Transfer (bridge) an already-answered inbound call to `toE164`.
 * Used by Safe Mode to hand the caller to the owner's forwarding number after
 * a short spoken confirmation, and by the warm-handoff chain to ring each step
 * with a `timeoutSecs` ring window + `clientState` so a no-answer can advance
 * the chain. We do not set `from` explicitly, Telnyx presents the original DID
 * as the caller ID by default.
 */
export async function telnyxTransferCall(
  apiKey: string,
  callControlId: string,
  toE164: string,
  opts: TelnyxTransferOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`;
  const body: Record<string, unknown> = { to: toE164 };
  if (typeof opts.timeoutSecs === "number" && opts.timeoutSecs > 0) {
    body.timeout_secs = Math.floor(opts.timeoutSecs);
  }
  if (opts.answeringMachineDetection) {
    body.answering_machine_detection = opts.answeringMachineDetection;
  }
  if (opts.clientState) {
    body.client_state = encodeClientState(opts.clientState);
  }
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

/**
 * Start a bidirectional media stream on an ALREADY-answered call. The inbound
 * (A) leg of a handoff chain is answered up front (so HomeLight's IVR keeps
 * looping while we ring humans); when every human misses we attach the Gemini
 * bridge to that same leg via streaming_start rather than re-answering. The
 * stream params mirror telnyxAnswerWithStream so the bridge sees the same
 * L16 @ 16 kHz contract.
 */
export async function telnyxStreamingStart(
  apiKey: string,
  callControlId: string,
  opts: { streamUrl: string; clientState?: string; targetLegs?: TelnyxStreamTargetLegs },
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`;
  const body: Record<string, unknown> = {
    stream_url: opts.streamUrl,
    stream_track: "both_tracks",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 16000
  };
  // Only present when translator mode is armed; see TelnyxStreamTargetLegs.
  if (opts.targetLegs) {
    body.stream_bidirectional_target_legs = opts.targetLegs;
  }
  if (opts.clientState) {
    body.client_state = encodeClientState(opts.clientState);
  }
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

/**
 * Send DTMF tones on a call. Used by the handoff chain's AI takeover to press
 * "1" on the HomeLight leg so HomeLight connects the live client to us.
 */
export async function telnyxSendDtmf(
  apiKey: string,
  callControlId: string,
  digits: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ digits })
  });
}

/**
 * Hang up an already-answered call. Used as the Safe Mode recovery step when
 * `/actions/transfer` fails, without this the caller is stranded on a silent
 * bridged leg until Telnyx's inactivity timeout fires (~30-60s of silence).
 */
export async function telnyxHangupCall(
  apiKey: string,
  callControlId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
}

export type TelnyxDialOptions = {
  /**
   * Call Control Application (connection) id that owns the originating DID and
   * the single voice webhook URL. The originated call's events (call.initiated,
   * call.answered, call.hangup) come back to that same webhook, so the dispatch
   * + call-end machine can drive the leg exactly like an inbound call.
   */
  connectionId: string;
  /** Callee in E.164. */
  to: string;
  /** Caller ID presented to the callee, a DID on the connection, in E.164. */
  from: string;
  /**
   * Ring timeout (seconds) before Telnyx abandons an unanswered callee and
   * fires call.hangup with a no-answer cause. Omit for the Telnyx default.
   */
  timeoutSecs?: number;
  /**
   * Answering-machine detection mode. Omit to leave it off, which is the
   * historical behavior for every caller that does not ask.
   *
   * Why it matters: without AMD a voicemail PICKING UP looks identical to a
   * person picking up. Telnyx answers the leg either way, so the outcome we
   * derive from `answer_issued_at` reads "answered", and a follow-up ladder
   * written to retry until someone is reached stops on a lead who never heard
   * a word.
   *
   * "premium" is the mode that also reports when the outgoing greeting has
   * finished, which is the only safe moment to start speaking into a
   * voicemail. "detect" answers human-or-machine and nothing more.
   * "premium_ios_call_screening_detection" is premium PLUS Apple call
   * screening awareness: same verdicts, and additionally
   * `call.machine.premium.call_screening.detected` when an iPhone's screening
   * answered (a live person deciding whether to pick up, never a machine).
   */
  answeringMachineDetection?:
    | "detect"
    | "detect_beep"
    | "detect_words"
    | "greeting_end"
    | "premium"
    | "premium_ios_call_screening_detection";
  /**
   * Opaque state echoed back on THIS call's webhooks (call.answered / hangup).
   * The origination flow packs the outbound session id here so the webhook can
   * correlate the answered leg back to its reserved budget + plan. base64 per
   * Telnyx; callers pass plain text and we encode it here (like transfer).
   */
  clientState?: string;
  /**
   * Telnyx command idempotency key. Re-dialing with the same command_id is a
   * no-op on Telnyx's side, so an at-least-once origination trigger can retry
   * safely without placing duplicate calls.
   */
  commandId?: string;
};

/**
 * Originate an OUTBOUND call (POST /v2/calls). Returns the raw Telnyx response;
 * the caller reads `data.call_control_id` from the JSON to drive the leg. We do
 * NOT answer/stream here, the originated leg is answered + bridged by the
 * call-control state machine when Telnyx delivers call.answered, exactly like an
 * inbound A-leg. Budget MUST already be reserved before calling this (see
 * reserveVoiceBudget); on a no-budget result the caller must not dial.
 */
export async function telnyxDialCall(
  apiKey: string,
  opts: TelnyxDialOptions,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const body: Record<string, unknown> = {
    connection_id: opts.connectionId,
    to: opts.to,
    from: opts.from
  };
  if (typeof opts.timeoutSecs === "number" && opts.timeoutSecs > 0) {
    body.timeout_secs = Math.floor(opts.timeoutSecs);
  }
  if (opts.answeringMachineDetection) {
    body.answering_machine_detection = opts.answeringMachineDetection;
  }
  if (opts.clientState) {
    body.client_state = encodeClientState(opts.clientState);
  }
  if (opts.commandId) {
    body.command_id = opts.commandId;
  }
  return fetchImpl("https://api.telnyx.com/v2/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

/**
 * Bridge two ALREADY-ESTABLISHED legs together.
 *
 * Distinct from `telnyxTransferCall`, which takes a leg AWAY from whatever it
 * was doing and dials a number on it. Bridging joins a leg that is already in
 * a conversation to a second leg that was dialed separately, which is what
 * lets an assistant keep talking to a caller while a teammate's phone rings
 * and only hand over once that teammate genuinely answers.
 *
 * `callControlId` is the leg the command is issued ON; `otherCallControlId`
 * is the leg it is joined TO.
 *
 * `parkAfterUnbridge` decides what happens to this leg when the bridge later
 * ends. Parking it holds the leg instead of hanging it up, which is what a
 * caller's leg wants: if the teammate drops, the caller is still connected and
 * something can come back to them rather than leaving them with dead air.
 *
 * Telnyx expects the STRING "self" here, not a boolean: the wire value names
 * which leg to park. A boolean is silently ignored, and the failure is
 * invisible until a teammate actually drops and the caller is hung up on.
 *
 * `commandId` is Telnyx's own idempotency key. It ignores a repeat of the same
 * command_id on the same leg, so a retried bridge cannot double-join.
 */
export async function telnyxBridgeCall(
  apiKey: string,
  callControlId: string,
  opts: {
    otherCallControlId: string;
    parkAfterUnbridge?: boolean;
    clientState?: string;
    commandId?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/bridge`;
  const body: Record<string, unknown> = { call_control_id: opts.otherCallControlId };
  if (opts.parkAfterUnbridge === true) body.park_after_unbridge = "self";
  if (opts.clientState) body.client_state = encodeClientState(opts.clientState);
  if (opts.commandId) body.command_id = opts.commandId;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

/** Reject without answering so carrier/PBX can apply busy treatment (e.g. voicemail). */
export async function rejectIncomingCall(
  apiKey: string,
  callControlId: string,
  cause: "USER_BUSY" | "CALL_REJECTED" = "USER_BUSY",
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cause })
  });
  if (!res.ok) {
    console.error("reject failed", callControlId, res.status, await res.text());
  }
}
