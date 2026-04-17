/**
 * §8 Failover:
 * - `mode: "speak"` (default): idempotent `answer` + `speak` maintenance script (voice_claim_failover_maintenance_speak).
 * - `mode: "transfer"`: Call Control `transfer` to another Connection (backup path).
 *
 * POST JSON { "call_control_id": "…", "mode"?: "speak" | "transfer", "connection_id"?: "…" }
 * with cron auth (Authorization: Bearer INTERNAL_CRON_SECRET).
 *
 * Env: TELNYX_API_KEY; SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for speak idempotency;
 *      VOICE_FAILOVER_MAINTENANCE_MESSAGE (optional); TELNYX_FAILOVER_CONNECTION_ID for transfer default.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { answerThenSpeak } from "../_shared/telnyx_call_actions.ts";

const DEFAULT_MAINTENANCE_SPEAK =
  "We're sorry, our AI line is temporarily unavailable. Please try again later or send a text message. Goodbye.";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await assertCronAuth(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  const defaultConnection = Deno.env.get("TELNYX_FAILOVER_CONNECTION_ID") ?? "";

  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "TELNYX_API_KEY missing" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  let body: { call_control_id?: string; connection_id?: string; mode?: string };
  try {
    body = (await req.json()) as { call_control_id?: string; connection_id?: string; mode?: string };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const callId = (body.call_control_id ?? "").trim();
  const mode = (body.mode ?? "speak").trim().toLowerCase();

  if (!callId) {
    return new Response(JSON.stringify({ ok: false, error: "call_control_id required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (mode === "transfer") {
    const connectionId = (body.connection_id ?? defaultConnection).trim();
    if (!connectionId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "connection_id or TELNYX_FAILOVER_CONNECTION_ID required for transfer mode"
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Transfer idempotency (§8): retries of this endpoint (cron, manual ops, Telnyx
    // upstream retry on timeout) must not transfer the same leg twice — a double
    // transfer causes the caller to be bounced/dropped. We reuse voice_failover_
    // maintenance_at as the "failover action taken" watermark for this leg; the
    // speak path uses the same column, so speak+transfer also can't both fire.
    const supabaseUrlT = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKeyT = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (supabaseUrlT && serviceKeyT) {
      const supabaseT = createClient(supabaseUrlT, serviceKeyT);
      const { data: claimRawT, error: claimErrT } = await supabaseT.rpc(
        "voice_claim_failover_transfer",
        { p_call_control_id: callId }
      );
      if (claimErrT) {
        console.error("voice_claim_failover_transfer", claimErrT);
        return new Response(JSON.stringify({ ok: false, error: "claim_failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      const claimT = claimRawT as { ok?: boolean; transfer?: boolean; reason?: string } | null;
      if (claimT?.transfer === false) {
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: claimT?.reason ?? "already_claimed" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    } else {
      console.warn(
        "telnyx-voice-failover: transfer mode without SUPABASE env — skipping idempotency claim (allowing single-shot transfer)"
      );
    }

    const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/transfer`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ connection_id: connectionId })
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("Telnyx transfer failed", res.status, text.slice(0, 800));
      return new Response(JSON.stringify({ ok: false, status: res.status, detail: text.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true, call_control_id: callId, mode: "transfer" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for speak mode" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: claimRaw, error: claimErr } = await supabase.rpc("voice_claim_failover_maintenance_speak", {
    p_call_control_id: callId
  });
  if (claimErr) {
    console.error("voice_claim_failover_maintenance_speak", claimErr);
    return new Response(JSON.stringify({ ok: false, error: "claim_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const claim = claimRaw as { ok?: boolean; speak?: boolean; reason?: string } | null;
  if (claim?.speak === false && claim?.reason === "already_spoken") {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "already_spoken" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (claim?.speak === false && claim?.reason === "reservation_not_active") {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "reservation_not_active" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const msg = (Deno.env.get("VOICE_FAILOVER_MAINTENANCE_MESSAGE") ?? "").trim() || DEFAULT_MAINTENANCE_SPEAK;
  await answerThenSpeak(apiKey, callId, msg);

  return new Response(JSON.stringify({ ok: true, call_control_id: callId, mode: "speak" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
