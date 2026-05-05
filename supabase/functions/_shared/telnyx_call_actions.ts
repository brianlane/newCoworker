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
  fetchImpl: typeof fetch = fetch
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
      language: "en-US"
    })
  });
}

export async function answerThenSpeak(
  apiKey: string,
  callControlId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const ans = await telnyxAnswerPlain(apiKey, callControlId, fetchImpl);
  if (!ans.ok) {
    console.error("answer plain failed", callControlId, ans.status, await ans.text());
    return;
  }
  const sp = await telnyxSpeak(apiKey, callControlId, text, "female", fetchImpl);
  if (!sp.ok) {
    console.error("speak failed", callControlId, sp.status, await sp.text());
  }
}

/**
 * Transfer (bridge) an already-answered inbound call to `toE164`.
 * Used by Safe Mode to hand the caller to the owner's forwarding number after
 * a short spoken confirmation. We do not set `from` explicitly — Telnyx will
 * present the original DID as the caller ID by default.
 */
export async function telnyxTransferCall(
  apiKey: string,
  callControlId: string,
  toE164: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ to: toE164 })
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
