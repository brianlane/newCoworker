/**
 * §11 maintenance: stale settlements, zombie voice_active_sessions, stale reservations,
 * SMS jobs stuck in processing, expired stream_url_nonces. Invoke on a schedule with
 * Authorization: Bearer INTERNAL_CRON_SECRET.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data, error } = await supabase.rpc("voice_run_maintenance_sweeps", {
    p_settlement_min_age: "15 minutes",
    p_session_stale: "15 minutes",
    p_res_unanswered: "3 minutes",
    p_res_no_ws: "10 minutes",
    p_sms_stale: "15 minutes"
  });

  if (error) {
    console.error("voice_run_maintenance_sweeps", error);
    return new Response("Sweep failed", { status: 500 });
  }

  const summary = (data ?? {}) as Record<string, unknown>;
  await telemetryRecord(supabase, "voice_maintenance_sweep", summary);

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
