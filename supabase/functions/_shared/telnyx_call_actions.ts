/**
 * Telnyx Call Control API helpers (Programmable Voice).
 * Shared by Edge functions; Vitest imports this module directly (see `tests/telnyx-lib.test.ts`).
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

/** POST /v2/calls/{call_control_id}/actions/answer with bidirectional media stream. */
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
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_sampling_rate: 16000
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
