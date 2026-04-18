/**
 * Telnyx Call Control has a SINGLE webhook URL per Application. The voice
 * pipeline handles `call.initiated` in `telnyx-voice-inbound` and
 * `call.hangup`/`call.ended` in `telnyx-voice-call-end`, so we need a thin
 * routing layer in front of them.
 *
 * This module is the pure routing helper used by the `telnyx-voice-dispatch`
 * Edge function. It is deliberately transport-agnostic so it can be unit
 * tested under Node / Vitest from `tests/telnyx-voice-dispatch.test.ts`.
 *
 * Design notes:
 * - We do NOT verify the Telnyx signature here. The target function (inbound
 *   or call-end) already verifies it, and preserving the raw body + headers
 *   across one internal hop keeps that verification working unchanged.
 * - We do NOT rate-limit here. The target function's per-route rate bucket
 *   still protects it.
 * - We return 200 with `{ ok: true, skipped: eventType }` for unknown event
 *   types so Telnyx does not retry deliveries we intentionally ignore
 *   (matches the inbound/call-end functions' own no-op response shape).
 */

export const TELNYX_VOICE_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "call.initiated": "telnyx-voice-inbound",
  "call.hangup": "telnyx-voice-call-end",
  "call.ended": "telnyx-voice-call-end"
});

export type TelnyxVoiceRouteTarget = (typeof TELNYX_VOICE_ROUTES)[keyof typeof TELNYX_VOICE_ROUTES];

export type DispatchDecision =
  | { kind: "route"; target: string; eventType: string }
  | { kind: "skip"; eventType: string }
  | { kind: "bad_json" };

export function decideTelnyxVoiceRoute(rawBody: string): DispatchDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "bad_json" };
  }

  const eventType =
    typeof (parsed as { data?: { event_type?: unknown } } | null)?.data?.event_type === "string"
      ? ((parsed as { data: { event_type: string } }).data.event_type as string)
      : "";

  const target = TELNYX_VOICE_ROUTES[eventType];
  if (target) return { kind: "route", target, eventType };
  return { kind: "skip", eventType };
}

/**
 * Build the Headers the dispatcher forwards to the target Edge function.
 *
 * Telnyx's signature is HMAC over `{timestamp}|{rawBody}` (Ed25519), so we
 * preserve the exact headers Telnyx set. We strip hop-by-hop / request-line
 * headers that belong to the dispatcher's inbound request, not the outbound
 * fetch, and optionally inject an `Authorization` bearer so Edge functions
 * deployed with JWT verification still accept the forwarded call.
 */
export function buildForwardHeaders(
  incoming: Headers,
  opts: { bearerToken?: string } = {}
): Headers {
  const out = new Headers();
  const DROP = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
    "authorization"
  ]);
  incoming.forEach((value, key) => {
    if (!DROP.has(key.toLowerCase())) out.set(key, value);
  });
  if (opts.bearerToken) {
    out.set("Authorization", `Bearer ${opts.bearerToken}`);
  }
  return out;
}

/** Build the full target URL on the same Supabase project. */
export function buildTargetUrl(supabaseUrl: string, target: string): string {
  const trimmed = supabaseUrl.replace(/\/+$/, "");
  return `${trimmed}/functions/v1/${target}`;
}
