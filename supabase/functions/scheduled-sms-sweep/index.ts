/**
 * Scheduled-SMS dispatch cron (every minute, see
 * 20260726000001_schedule_scheduled_sms_sweep.sql).
 *
 * Thin wrapper: cron auth + env plumbing; all dispatch logic lives in
 * _shared/scheduled_sms.ts (unit-tested under the vitest coverage gate).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { processDueScheduledSms } from "../_shared/scheduled_sms.ts";

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
    const result = await processDueScheduledSms(supabase, {
      telnyxApiKey: Deno.env.get("TELNYX_API_KEY") ?? "",
      defaultMessagingProfileId: Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "",
      defaultFromE164: Deno.env.get("TELNYX_SMS_FROM_E164") ?? "",
      notifyUrl: `${supabaseUrl}/functions/v1/notifications`,
      notifyBearer: Deno.env.get("INTERNAL_CRON_SECRET") ?? ""
    });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("scheduled-sms-sweep", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
