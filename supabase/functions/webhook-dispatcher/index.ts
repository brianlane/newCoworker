/**
 * Webhook (REST hook) delivery cron — every minute, see
 * 20260729000001_schedule_webhook_dispatcher.sql.
 *
 * Thin wrapper: cron auth + env plumbing; the cursor-polling delivery
 * engine lives in _shared/webhook_dispatch.ts (unit-tested under the
 * vitest coverage gate). Powers Zapier triggers and any other consumer
 * subscribed through POST /api/public/v1/hooks.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { runWebhookDispatchTick, type SupabaseLike } from "../_shared/webhook_dispatch.ts";

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

  try {
    const summary = await runWebhookDispatchTick(
      supabase as unknown as SupabaseLike,
      fetch,
      (msg, extra) => console.warn(msg, extra ?? {})
    );
    return new Response(JSON.stringify({ ok: true, ...summary }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    // Details stay in the function logs; the response body is generic so a
    // (hypothetical) unauthorized caller can't harvest internals.
    console.error("webhook-dispatcher", err);
    return new Response(JSON.stringify({ ok: false, error: "dispatch_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
