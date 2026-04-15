/**
 * §11 sweep: finalize voice_settlements stuck waiting for a second signal.
 * Invoke on a schedule (e.g. Supabase cron) with Authorization: Bearer INTERNAL_CRON_SECRET.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!assertCronAuth(req)) {
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
  const { data: n, error } = await supabase.rpc("voice_sweep_stale_settlements", {
    p_min_age: "15 minutes"
  });

  if (error) {
    console.error("voice_sweep_stale_settlements", error);
    return new Response("Sweep failed", { status: 500 });
  }

  const count = typeof n === "number" ? n : 0;
  await telemetryRecord(supabase, "voice_settlement_sweep", { finalized: count });

  return new Response(JSON.stringify({ ok: true, finalized: count }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
