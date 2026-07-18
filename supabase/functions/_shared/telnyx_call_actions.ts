/**
 * Telnyx Call Control API helpers (Programmable Voice).
 * Shared by Edge functions; Vitest imports this module directly (see `tests/telnyx-lib.test.ts`).
 *
 * §5.1 idempotency: Telnyx Programmable Voice /answer does not document a request idempotency key
 * comparable to Messaging. Correctness relies on DB state (`answer_issued_at`, reservation lifecycle)
 * + webhook `telnyx_webhook_try_begin` single-flight per `event_id`.
 */

export type TelnyxAnswerStreamOptions = {
  streamUrl: string;
  clientState?: string;
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
 *     `"default"` means the call's native PSTN codec — almost always
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
 *     defaults the OUTBOUND rate to 8 kHz — and the bridge's L16 16 kHz
 *     frames played back at 8 kHz sound like sped-up chipmunk noise (or,
 *     more often, Telnyx silently discards them because they miss the
 *     expected packet cadence). The legacy `stream_sampling_rate` field
 *     used here previously is NOT in the Telnyx schema and was ignored —
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
   * cause and leaves the original (A) leg under our control — that is what lets
   * the handoff chain fall through to the next step. Omit for an open-ended ring.
   */
  timeoutSecs?: number;
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
 * the chain. We do not set `from` explicitly — Telnyx presents the original DID
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
  opts: { streamUrl: string; clientState?: string },
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
 * `/actions/transfer` fails — without this the caller is stranded on a silent
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
  /** Caller ID presented to the callee — a DID on the connection, in E.164. */
  from: string;
  /**
   * Ring timeout (seconds) before Telnyx abandons an unanswered callee and
   * fires call.hangup with a no-answer cause. Omit for the Telnyx default.
   */
  timeoutSecs?: number;
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
 * NOT answer/stream here — the originated leg is answered + bridged by the
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
