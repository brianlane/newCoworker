/**
 * Telnyx Call Control v2 actions invoked by the voice bridge itself (distinct
 * from the Edge function client in `supabase/functions/_shared/telnyx_call_actions.ts`).
 * We keep this file standalone so the VPS build does not pull any Edge/Deno
 * dependencies.
 */

export type TelnyxTransferOptions = {
  /** E.164 destination for the warm transfer. */
  toE164: string;
  /** Caller ID presented to the transfer target. Defaults to the DID (`fromE164`). */
  fromE164?: string;
  /** Optional AMD / record flags; left empty for now — we don't want recording by default. */
  timeLimitSecs?: number;
  /** Optional spoken line before the transfer connects; Telnyx uses this as a whisper greeting. */
  audioUrl?: string;
  /**
   * Opaque state echoed back on this transfer's resulting call-control webhooks
   * (call.bridged / call.hangup for the B leg). Used by telnyx-voice-call-end to
   * fire warm-transfer SMS notifications. Pass PLAIN text (e.g. `wt:<biz>:<caller>:<recipient>`);
   * Telnyx requires base64, so we encode it here.
   */
  clientState?: string;
};

export type TelnyxActionResult = {
  ok: boolean;
  status: number;
  body?: string;
};

export async function telnyxTransferCall(
  apiKey: string,
  callControlId: string,
  opts: TelnyxTransferOptions,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };
  if (!opts.toE164) return { ok: false, status: 0, body: "missing toE164" };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`;
  const body: Record<string, unknown> = { to: opts.toE164 };
  if (opts.fromE164) body.from = opts.fromE164;
  if (opts.timeLimitSecs && opts.timeLimitSecs > 0) body.time_limit_secs = opts.timeLimitSecs;
  if (opts.audioUrl) body.audio_url = opts.audioUrl;
  if (opts.clientState) body.client_state = Buffer.from(opts.clientState, "utf8").toString("base64");

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Hang up a live call leg. Used by the bridge's `end_call` tool so the
 * assistant can end the conversation cleanly. Telnyx closes the media stream
 * once the leg hangs up, which fires the bridge's ws `close` handler (transcript
 * finalize + reservation settlement), so this is the only network call needed.
 */
export async function telnyxHangupCall(
  apiKey: string,
  callControlId: string,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stop the bidirectional media stream on a call leg WITHOUT hanging it up.
 * Used after a successful warm transfer so the AI's media fork is removed while
 * the caller stays bridged to the human. Telnyx closes our media WebSocket when
 * the stream stops, which fires the bridge's ws `close` handler (transcript
 * finalize + reservation settlement). The PSTN leg itself stays up.
 */
export async function telnyxStreamingStop(
  apiKey: string,
  callControlId: string,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

export type TelnyxSmsOptions = {
  toE164: string;
  fromE164: string;
  messagingProfileId?: string;
  text: string;
};

/**
 * Minimal outbound SMS helper — the VPS bridge uses it for the "your AI
 * receptionist couldn't connect, call from X" fallback. It deliberately does
 * NOT touch Supabase quota counters; that's tracked on the Edge/web side. The
 * bridge cares only about getting the missed-call alert out.
 */
export async function telnyxSendPlainSms(
  apiKey: string,
  opts: TelnyxSmsOptions,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!opts.toE164 || !opts.fromE164 || !opts.text) {
    return { ok: false, status: 0, body: "missing to/from/text" };
  }
  const body: Record<string, string> = {
    to: opts.toE164,
    from: opts.fromE164,
    text: opts.text
  };
  if (opts.messagingProfileId) body.messaging_profile_id = opts.messagingProfileId;

  try {
    const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}
