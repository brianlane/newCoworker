/**
 * AMD resolution sweep: act on machine verdicts Telnyx never resolves.
 *
 * Scheduled every 15 seconds by `schedule_voice_amd_resolution_sweep.sql`
 * (the pg_cron job's SQL gates the HTTP call on an EXISTS over candidate
 * sessions, so almost every tick costs one indexed lookup and no request).
 *
 * WHY THIS EXISTS. Flow-placed outbound calls dial with premium AMD, and a
 * `machine` verdict is deliberately PROVISIONAL: the verdict handler stamps
 * it and defers the action (speak the configured voicemail, or hang up a
 * scriptless leg) to the resolution event, a greeting-ended beep or an
 * Apple call-screening detection. On 2026-08-25 Telnyx stopped delivering
 * greeting events platform-wide (memory
 * project_telnyx_premium_amd_event_collapse), which left every confirmed
 * machine verdict standing forever: the deterministic voicemail path could
 * never fire, the Gemini bridge kept improvising into recordings, and the
 * scripted message rode the model's best-effort `voicemail_reached` tool.
 *
 * This sweep is the bounded timeout the provisional design never had: a
 * machine stamp still unresolved after its grace window is acted on exactly
 * as a greeting resolution would have, through the same claim, so the sweep
 * and the greeting/model paths can never double-speak. All the judgement
 * lives in `_shared/voice_amd_resolution.ts` (pure, unit-tested); this file
 * is the IO around it.
 *
 * ROLLOUT GATE. The sweep forces irreversible call actions (stops the media
 * stream, speaks, hangs up), so it ships dark: `admin_platform_settings`
 * key `voice_amd_resolution` must name a business before its calls are
 * touched, and the change is graded against real calls per
 * feedback_score_prompt_changes_against_outcomes before widening.
 *
 * Auth: Authorization: Bearer <INTERNAL_CRON_SECRET> (assertCronAuth).
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_API_KEY,
 * INTERNAL_CRON_SECRET.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import { telnyxHangupCall, telnyxStreamingStop } from "../_shared/telnyx_call_actions.ts";
import {
  AMD_RESOLUTION_MAX_AGE_MS,
  decideAmdResolution,
  readAmdResolutionConfig
} from "../_shared/voice_amd_resolution.ts";
import { speakVoicemailDeterministic } from "../_shared/voice_voicemail_speak.ts";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !apiKey) {
    console.error("amd-resolution-sweep: missing env");
    return new Response("Server misconfigured", { status: 500 });
  }
  if (!(await assertCronAuth(req))) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const config = await readAmdResolutionConfig(supabase);
  if (!config.enabled) return json(200, { ok: true, enabled: false, acted: 0 });
  if (!config.allBusinesses && config.businessIds.size === 0) {
    // Enabled but nobody enrolled: nothing to query (and an empty `in.()`
    // filter is a PostgREST parse error, not an empty match).
    return json(200, { ok: true, enabled: true, candidates: 0, acted: 0 });
  }

  // Candidates: enrolled businesses' live outbound AI legs whose machine
  // stamp is still UNRESOLVED, oldest first. The page can only starve if
  // non-actionable rows can occupy it (Bugbot, PR #1674, twice over), so
  // every exclusion is a query filter, each a SINGLE unambiguous PostgREST
  // param (no chained `or` groups):
  //
  //   - resolved-state keys use `isdistinct` (IS DISTINCT FROM), which is
  //     TRUE for both an absent key (NULL) and any value other than 'true',
  //     exactly the absent-or-not-true semantics `neq` cannot express.
  //     Verified against the production PostgREST before shipping.
  //   - a speak already in flight is excluded by the started_at key being
  //     absent (`is.null` on the ->> extraction).
  //   - enrollment is filtered with `.in` unless all_businesses, so other
  //     tenants' legs never compete for the page.
  //
  // Oldest-first then serves the longest-waiting actionable call even if
  // the page somehow fills. The pure decision re-checks everything (its
  // skip reasons are the unit-tested authority on ACTING); these filters
  // exist only so pagination cannot hide an overdue call. The 30-minute
  // window matches AMD_RESOLUTION_MAX_AGE_MS and the pg_cron EXISTS guard:
  // anything older is a stale session, not a live call.
  const sinceIso = new Date(Date.now() - AMD_RESOLUTION_MAX_AGE_MS).toISOString();
  let query = supabase
    .from("voice_handoff_sessions")
    .select("call_control_id, business_id, context")
    .eq("status", "ai_intake")
    .gte("created_at", sinceIso)
    .eq("context->>machine_detected", "true")
    .filter("context->>voicemail_claimed", "isdistinct", "true")
    .filter("context->>amd_resolution_hung_up", "isdistinct", "true")
    .is("context->>voicemail_speak_started_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (!config.allBusinesses) {
    query = query.in("business_id", [...config.businessIds]);
  }
  const { data: rows, error: qErr } = await query;
  if (qErr) {
    console.error("amd-resolution-sweep: candidate query failed", qErr);
    return json(500, { ok: false, error: "query_failed" });
  }

  let acted = 0;
  const skipped: Record<string, number> = {};
  for (const row of (rows ?? []) as Array<{
    call_control_id: string;
    business_id: string;
    context: Record<string, unknown> | null;
  }>) {
    const decision = decideAmdResolution({
      businessId: row.business_id,
      context: row.context ?? {},
      config,
      nowMs: Date.now()
    });
    if (decision.action === "skip") {
      skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      continue;
    }

    acted++;
    if (decision.action === "speak") {
      const outcome = await speakVoicemailDeterministic(
        {
          rpc: (fn, args) => supabase.rpc(fn, args),
          apiKey,
          fetchImpl: fetch,
          nowIso: () => new Date().toISOString()
        },
        row.call_control_id,
        decision.script
      );
      await telemetryRecord(supabase, "voice_amd_resolution_forced", {
        business_id: row.business_id,
        call_control_id: row.call_control_id,
        mode: "speak",
        outcome
      });
      await systemLog(supabase, {
        businessId: row.business_id,
        source: "voice",
        level: "info",
        event: "voice_amd_resolution_forced",
        message:
          outcome === "speaking"
            ? "Machine verdict unresolved past grace; speaking the configured voicemail"
            : `Machine verdict unresolved past grace; voicemail attempt ended ${outcome}`,
        payload: { call_control_id: row.call_control_id, mode: "speak", outcome }
      });
    } else {
      // Scriptless machine leg: end it, exactly as the pre-voicemail AMD
      // path always did. The marker lands FIRST so a lost call.hangup
      // webhook cannot leave the session re-eligible: the next tick's
      // decision skips it as already_resolved. Stream stop before hangup so
      // the bridge is not left narrating into a leg that is about to drop.
      const { error: markErr } = await supabase.rpc("voice_session_context_merge", {
        p_call_control_id: row.call_control_id,
        p_patch: { amd_resolution_hung_up: true }
      });
      if (markErr) console.error("amd-resolution-sweep: hangup marker failed", markErr);
      await telnyxStreamingStop(apiKey, row.call_control_id);
      await telnyxHangupCall(apiKey, row.call_control_id);
      await telemetryRecord(supabase, "voice_amd_resolution_forced", {
        business_id: row.business_id,
        call_control_id: row.call_control_id,
        mode: "hangup",
        outcome: "hangup_issued"
      });
      await systemLog(supabase, {
        businessId: row.business_id,
        source: "voice",
        level: "info",
        event: "voice_amd_resolution_forced",
        message: "Machine verdict unresolved past grace; no script configured, hanging up",
        payload: { call_control_id: row.call_control_id, mode: "hangup" }
      });
    }
  }

  return json(200, { ok: true, enabled: true, candidates: (rows ?? []).length, acted, skipped });
});
