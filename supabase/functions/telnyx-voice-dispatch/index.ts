/**
 * Telnyx Programmable Voice: single-URL webhook dispatcher.
 *
 * Mission Control Call Control Applications only allow ONE primary webhook
 * URL per application, but this repo has separate handlers for
 * `call.initiated` (telnyx-voice-inbound) and `call.hangup` / `call.ended`
 * (telnyx-voice-call-end). Point Telnyx at this function; it extracts
 * `data.event_type` from the body and forwards the request — headers, raw
 * body, everything — to the correct handler on the same Supabase project.
 *
 * The target handler verifies the Ed25519 signature itself; we deliberately
 * do NOT verify here, so the canonical `{timestamp}|{rawBody}` still matches
 * (one internal hop does not mutate the body).
 *
 * Optional secret:
 *   DISPATCH_FORWARD_BEARER — Bearer token injected on the forwarded
 *     request. Set to the project anon key if the target Edge functions
 *     were deployed with JWT verification ON. Leave unset if deployed with
 *     `--no-verify-jwt` (the default for Telnyx webhooks).
 *
 * HTTP semantics:
 *   - Unknown event types → 200 `{ok:true, skipped:eventType}` (Telnyx
 *     treats delivery as successful and does not retry).
 *   - Malformed JSON → 400.
 *   - Upstream error → pass the upstream status/body back so Telnyx sees
 *     the real response.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  buildForwardHeaders,
  buildTargetUrl,
  decideTelnyxVoiceRoute
} from "../_shared/telnyx_voice_dispatch.ts";

const MAX_BODY = 256 * 1024;
const FORWARD_TIMEOUT_MS = 12_000;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }

  const body = await req.text();
  if (body.length > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }

  const decision = decideTelnyxVoiceRoute(body);
  if (decision.kind === "bad_json") {
    return new Response("Bad JSON", { status: 400 });
  }
  if (decision.kind === "skip") {
    return new Response(
      JSON.stringify({ ok: true, skipped: decision.eventType || "unknown" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const bearer = Deno.env.get("DISPATCH_FORWARD_BEARER") ?? "";
  const headers = buildForwardHeaders(req.headers, bearer ? { bearerToken: bearer } : {});
  const targetUrl = buildTargetUrl(supabaseUrl, decision.target);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FORWARD_TIMEOUT_MS);
  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body,
      signal: ac.signal
    });
    const upstreamBody = await upstream.text();
    const outHeaders = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) outHeaders.set("content-type", ct);
    outHeaders.set("x-telnyx-dispatch-target", decision.target);
    outHeaders.set("x-telnyx-dispatch-event", decision.eventType);
    return new Response(upstreamBody, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    console.error("telnyx-voice-dispatch: forward failed", {
      target: decision.target,
      eventType: decision.eventType,
      error: err instanceof Error ? err.message : String(err)
    });
    return new Response(
      JSON.stringify({ ok: false, error: "forward_failed", target: decision.target }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  } finally {
    clearTimeout(timer);
  }
});
