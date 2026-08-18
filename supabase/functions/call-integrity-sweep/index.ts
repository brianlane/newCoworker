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
  formatCallIntegrityAlert,
  postCallIntegrityWebhook,
  type CallIntegrityAlertItem,
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

  // Names for the alert body. A webhook line reading "621a5b0d..." tells the
  // reader nothing; the tenant's name is the whole point of pushing it.
  // Best-effort: a failed lookup falls back to the id rather than losing the
  // finding.
  const businessName = new Map<string, string>();
  {
    const { data } = await supabase.from("businesses").select("id, name");
    for (const b of data ?? []) {
      if (typeof b.name === "string" && b.name) businessName.set(b.id as string, b.name);
    }
  }

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
      // Exclude only the non-terminal state, rather than allow-listing
      // "completed". A call still in progress can be mid-IVR with a couple of
      // greetings behind it, which scores as talked_to_recording right up
      // until a human joins and it completes normally; the dedupe below would
      // then freeze that wrong verdict forever. One in flight at sweep time
      // is picked up by tomorrow's run, which the 26h lookback covers.
      //
      // "errored" is terminal and keeps its turns (voice-transcript.ts
      // finalizes that way when the Live session throws), and a call that
      // misbehaved and then died is exactly the one worth reporting, so it
      // must stay in scope.
      .neq("status", "in_progress")
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
  const alerts: CallIntegrityAlertItem[] = [];
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
      alerts.push({
        ...finding,
        transcriptId: call.id,
        business: businessName.get(call.business_id) ?? call.business_id,
        caller: call.caller_e164,
        startedAt: call.started_at
      });
      await systemLog(supabase, {
        businessId: call.business_id,
        source: "voice",
        // `error`, not `warn`, and deliberately so. The fleet dashboard
        // reads level = 'error' ONLY (src/lib/db/system-logs.ts), so a warn
        // shows on one client's page and nowhere anyone looks daily. The
        // warn convention is for a poll that fails once a minute and clears
        // itself on the next run; this is the opposite, a daily deduped
        // sweep firing on a call that already went wrong and cannot be
        // retried. That is this file's own bar for error: "a claim that a
        // human should look". Two findings in 120 days, so the volume
        // argument for warn does not apply either.
        level: "error",
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
    findings: alerts.length
  });

  // Push, so a finding reaches someone instead of waiting to be found. Only
  // when there is something to say and a webhook is configured; the sweep is
  // fully functional without one.
  const webhookUrl = Deno.env.get("ALERT_WEBHOOK_URL") ?? "";
  let webhook: { ok: boolean; status: number } | null = null;
  if (alerts.length > 0 && webhookUrl) {
    const result = await postCallIntegrityWebhook(
      (url, init) => fetch(url, init),
      webhookUrl,
      alerts
    );
    webhook = { ok: result.ok, status: result.status };
    if (!result.ok) {
      // The system_logs rows are already written, so a webhook outage is not
      // a failed run. Record it and answer 200.
      await telemetryRecord(supabase, "call_integrity_sweep_webhook_failed", {
        status: result.status,
        error: result.error ?? null
      });
    }
  }

  // Webhook error text stays out of the HTTP response: it can carry upstream
  // provider messages, and CodeQL flags that as information exposure. The
  // detail is in the telemetry event above.
  return new Response(
    JSON.stringify({
      ok: true,
      scanned,
      findings: alerts.length,
      webhook,
      summary: formatCallIntegrityAlert(alerts)
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
