/**
 * Call-integrity sweep.
 *
 * Scheduled daily by `schedule_call_integrity_sweep.sql`. Reads yesterday's
 * voice transcripts and reports calls where the AI voiced BOTH sides of the
 * conversation, or held a conversation with a recording.
 *
 * WHY A CRON AND NOT A TEST. Both failures are the model disobeying its
 * prompt (the rules added in PR #1377), and prompt adherence cannot be
 * unit-tested: a test can prove a rule is present in the instruction, never
 * that it was followed. The detection rules live in
 * `_shared/call_integrity.ts` with their full reasoning; this file is the IO
 * around them.
 *
 * It cannot prevent a recurrence. It names one within a day, which is the
 * gap that mattered: the 2026-06-27 instance went unnoticed for seven weeks
 * and was only ever found by reading transcripts by hand.
 *
 * Findings land as per-tenant `system_logs` rows so a bad call shows on that
 * client's admin page, plus one fleet telemetry event per run.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  detectCallIntegrity,
  type CallIntegrityFinding,
  type IntegrityTurn
} from "../_shared/call_integrity.ts";

/**
 * Lookback. Slightly over a day so a call landing near the boundary of a
 * delayed run is still seen; the dedupe below makes the overlap free.
 */
const LOOKBACK_HOURS = 26;

/** PostgREST caps a response at 1000 rows and says nothing about it. */
const PAGE = 1000;

const EVENT = "voice_call_integrity_failure";

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await assertCronAuth(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return new Response("Server misconfigured", { status: 500 });
  const supabase = createClient(supabaseUrl, serviceKey);

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  // Paged, and ordered by (started_at, id). A bare `.limit()` on an ascending
  // window would silently drop the NEWEST calls, and range paging without a
  // unique tiebreaker can skip a row where timestamps tie: either one makes
  // this sweep go quiet exactly when there is most to find.
  const calls: Array<{
    id: string;
    business_id: string;
    caller_e164: string | null;
    started_at: string | null;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("voice_call_transcripts")
      .select("id, business_id, caller_e164, started_at")
      // Finished calls only. A call still in progress can be mid-IVR with a
      // couple of greetings behind it, which scores as talked_to_recording
      // right up until a human joins and it completes perfectly normally.
      // The dedupe below would then freeze that wrong verdict forever, since
      // the call is never looked at again. A call in flight at sweep time is
      // simply picked up by tomorrow's run, which the 26h lookback covers.
      .eq("status", "completed")
      .gte("started_at", since)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("call-integrity-sweep: transcripts select", error);
      await telemetryRecord(supabase, "call_integrity_sweep_error", {
        stage: "select_transcripts",
        error: error.message
      });
      return new Response("select failed", { status: 500 });
    }
    const rows = data ?? [];
    calls.push(...(rows as typeof calls));
    if (rows.length < PAGE) break;
  }

  // Already-reported calls, so a re-run over the overlapping window does not
  // log the same failure twice. An alert that repeats itself gets muted.
  const reported = new Set<string>();
  {
    const { data } = await supabase
      .from("system_logs")
      .select("payload")
      .eq("event", EVENT)
      .gte("created_at", since)
      .limit(PAGE);
    for (const row of data ?? []) {
      const id = (row.payload as { transcript_id?: string } | null)?.transcript_id;
      if (id) reported.add(id);
    }
  }

  let scanned = 0;
  let found = 0;
  for (const call of calls) {
    if (reported.has(call.id)) continue;
    scanned++;

    const turns: IntegrityTurn[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("voice_call_transcript_turns")
        .select("role, content")
        .eq("transcript_id", call.id)
        .order("turn_index", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("call-integrity-sweep: turns select", error);
        break;
      }
      const rows = (data ?? []) as IntegrityTurn[];
      turns.push(...rows);
      if (rows.length < PAGE) break;
    }
    if (turns.length === 0) continue;

    const findings: CallIntegrityFinding[] = detectCallIntegrity(turns);
    for (const finding of findings) {
      found++;
      await systemLog(supabase, {
        businessId: call.business_id,
        source: "voice",
        level: "warn",
        event: EVENT,
        message:
          finding.kind === "role_leak"
            ? `The AI spoke the caller's side of a call (${call.caller_e164 ?? "unknown caller"}). ${finding.detail}`
            : `The AI held a conversation with a recording (${call.caller_e164 ?? "unknown caller"}). ${finding.detail}`,
        payload: {
          transcript_id: call.id,
          kind: finding.kind,
          caller_e164: call.caller_e164,
          started_at: call.started_at,
          detail: finding.detail
        }
      });
    }
  }

  await telemetryRecord(supabase, "call_integrity_sweep", {
    lookback_hours: LOOKBACK_HOURS,
    calls_in_window: calls.length,
    scanned,
    findings: found
  });

  return new Response(JSON.stringify({ ok: true, scanned, findings: found }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
