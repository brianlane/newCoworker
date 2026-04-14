export type TelnyxAnswerStreamOptions = {
  streamUrl: string;
  clientState?: string;
};

/**
 * POST /v2/calls/{call_control_id}/actions/answer with bidirectional media stream.
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
