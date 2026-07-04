/**
 * Call-summary dispatch cron (every 5 minutes, see
 * 20260727000001_schedule_call_summary_sweep.sql).
 *
 * Thin wrapper: cron auth + env plumbing; all scan/dispatch logic lives in
 * _shared/call_summary_sweep.ts (unit-tested under the vitest coverage gate).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { processCallSummarySweep } from "../_shared/call_summary_sweep.ts";

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
  const platformBase = Deno.env.get("PLATFORM_PUBLIC_BASE_URL") ?? "";
  const platformBearer = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }
  if (!platformBase || !platformBearer) {
    // Without these we can't dispatch — be loud rather than silently
    // succeed-and-do-nothing.
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "missing PLATFORM_PUBLIC_BASE_URL or INTERNAL_CRON_SECRET — set them on the Edge function"
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const result = await processCallSummarySweep(supabase, {
      platformBaseUrl: platformBase,
      platformBearer
    });
    if (result.dispatched > 0) {
      await telemetryRecord(supabase, "call_summary_sweep", { ...result });
    }
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    // Details stay in the function logs; the response body is generic so a
    // (hypothetical) unauthorized caller can't harvest internals.
    console.error("call-summary-sweep", err);
    return new Response(JSON.stringify({ ok: false, error: "sweep_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
