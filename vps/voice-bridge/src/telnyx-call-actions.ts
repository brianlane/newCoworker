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
  /** Optional AMD / record flags; left empty for now, we don't want recording by default. */
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
 * Dial a brand-new outbound leg (POST /v2/calls). The reach_teammate ladder
 * uses this for each teammate's B leg while the caller stays on the A leg
 * with the assistant. `timeoutSecs` bounds how long the phone rings before
 * Telnyx gives up on its own; `clientState` (plain text here, base64 on the
 * wire) is what routes the leg's webhooks to handleReachLeg. Lockstep with
 * _shared/telnyx_call_actions.ts telnyxDialCall.
 */
export async function telnyxDialCall(
  apiKey: string,
  opts: {
    connectionId: string;
    to: string;
    from: string;
    timeoutSecs?: number;
    /**
     * Answering-machine detection on the dialed leg. A teammate whose phone
     * is off reaches carrier voicemail within a couple of seconds, which
     * ANSWERS the leg; without a verdict the reach ladder cannot tell that
     * answer from a person and bridges the caller into the greeting. Wire
     * value passes through verbatim ("premium" is what the ladder uses).
     */
    answeringMachineDetection?: string;
    clientState?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult & { callControlId?: string }> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!opts.connectionId) return { ok: false, status: 0, body: "missing connectionId" };
  if (!opts.to || !opts.from) return { ok: false, status: 0, body: "missing to/from" };
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
    body.client_state = Buffer.from(opts.clientState, "utf8").toString("base64");
  }
  try {
    const res = await fetchImpl("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await res.text().catch(() => "");
    let callControlId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { data?: { call_control_id?: string } };
      if (typeof parsed.data?.call_control_id === "string") {
        callControlId = parsed.data.call_control_id;
      }
    } catch {
      // Non-JSON error body; the status carries the story.
    }
    return { ok: res.ok, status: res.status, body: text.slice(0, 500), callControlId };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bridge two ALREADY-ESTABLISHED legs (POST .../actions/bridge). Joins the
 * teammate's answered B leg to the caller's A leg. `park_after_unbridge` is
 * the STRING "self" (the wire value names which leg to park); a boolean is
 * silently ignored, and the failure is invisible until a teammate drops and
 * the caller is hung up on. Lockstep with _shared/telnyx_call_actions.ts
 * telnyxBridgeCall.
 */
export async function telnyxBridgeCall(
  apiKey: string,
  callControlId: string,
  opts: { otherCallControlId: string; parkAfterUnbridge?: boolean; commandId?: string },
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };
  if (!opts.otherCallControlId) return { ok: false, status: 0, body: "missing other leg" };
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/bridge`;
  const body: Record<string, unknown> = { call_control_id: opts.otherCallControlId };
  if (opts.parkAfterUnbridge === true) body.park_after_unbridge = "self";
  if (opts.commandId) body.command_id = opts.commandId;
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
 * Digits Telnyx accepts on send_dtmf: the keypad, plus `w` (0.5s pause) and
 * `W` (1s pause). Anything else is rejected before the request so a model-chosen
 * argument can never reach the API as a malformed sequence.
 */
const DTMF_DIGITS_RE = /^[0-9A-D#*wW]{1,32}$/;

/**
 * Press keypad digits on a live call leg. Used by the bridge's `press_digits`
 * tool so the assistant can clear a partner IVR ("press 1 to accept") when it
 * HEARS the prompt, instead of the answer webhook guessing how long the
 * announcement runs.
 */
export async function telnyxSendDtmf(
  apiKey: string,
  callControlId: string,
  digits: string,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };
  if (!DTMF_DIGITS_RE.test(digits)) return { ok: false, status: 0, body: "invalid digits" };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ digits })
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

/**
 * Speak text on a live call leg via Telnyx TTS (`/actions/speak`). Lockstep
 * body with `_shared/telnyx_call_actions.ts` telnyxSpeak: payload, voice,
 * language. Used by the bridge-side deterministic voicemail speaker when
 * the uplink beep detector fires.
 */
export async function telnyxSpeak(
  apiKey: string,
  callControlId: string,
  text: string,
  voice = "female",
  fetchImpl: typeof fetch = fetch,
  language = "en-US"
): Promise<TelnyxActionResult> {
  if (!apiKey) return { ok: false, status: 0, body: "missing TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, body: "missing call_control_id" };
  if (!text) return { ok: false, status: 0, body: "missing text" };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`;
  try {
    const res = await fetchImpl(url, {
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
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
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
 * Minimal outbound SMS helper for the bridge's operational alerts
 * (missed-call fallback, intake lead summary, transfer pre-alert). The
 * transport itself does not meter; every caller counts a successful send
 * through meterBridgeOperationalSms, the same operational ledger the
 * notifications function uses.
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

/** The slice of a Supabase client the meter needs (injectable in tests). */
export type BridgeMeterClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Count one bridge-sent operational SMS against the tenant's pool, the
 * same `meter_sms_operational_send` ledger the notifications function
 * uses. The bridge's three sends (missed-call fallback, intake lead
 * summary, transfer pre-alert) used to claim "tracked on the Edge/web
 * side" while nothing counted them; this closes that. Never throws and
 * never refuses: the send has already happened, this is bookkeeping.
 */
export async function meterBridgeOperationalSms(
  supabase: BridgeMeterClient,
  businessId: string,
  /**
   * Billable carrier parts for the send, from smsTextUnits on the FINAL
   * body. #1189 denominated the ledger in parts; a flat 1 undercounted a
   * long intake summary by ~20x.
   */
  textUnits: number
): Promise<void> {
  try {
    const { error } = await supabase.rpc("meter_sms_operational_send", {
      p_business_id: businessId,
      p_text_units: textUnits
    });
    if (error) {
      console.warn(`voice-bridge: sms meter rpc failed (${businessId}): ${error.message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`voice-bridge: sms meter threw (${businessId}): ${message}`);
  }
}
