/**
 * Call-integrity sweep.
 *
 * Scheduled daily by `schedule_call_integrity_sweep.sql`. Reads yesterday's
 * voice transcripts and reports calls where the AI voiced BOTH sides of the
 * conversation, held a conversation with a recording, gave out a phone
 * number the business does not own, quoted a money figure nothing on the
 * call supplied, or never got past a referral partner's accept menu.
 *
 * WHY A CRON AND NOT A TEST. Each failure is the model disobeying its
 * prompt (the rules added in PRs #1377 and #1612), and prompt adherence
 * cannot be unit-tested: a test can prove a rule is present in the
 * instruction, never that it was followed. The invented-number rule earned
 * its place here the hard way: #1612 was verified deployed and the model
 * still fabricated a callback number on 2 of the next 8 voicemails, and the
 * only thing that caught it was a human reading transcripts. The detection
 * rules live in `_shared/call_integrity.ts` with their full reasoning; this
 * file is the IO around them.
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
  callIntegrityAlertSubject,
  callerAmounts,
  collectAllowedNumbers,
  detectCallIntegrity,
  formatCallIntegrityAlert,
  spokenNumberForm,
  type CallIntegrityAlertItem,
  type CallIntegrityFinding,
  type IntegrityTurn
} from "../_shared/call_integrity.ts";
import {
  resolveAdminAlertConfig,
  sendAdminAlertEmail
} from "../_shared/admin_alert_email.ts";

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
    forwarded_to_e164: string | null;
    started_at: string | null;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("voice_call_transcripts")
      .select("id, business_id, caller_e164, forwarded_to_e164, started_at")
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

  // The numbers each implicated business may legitimately speak, for the
  // invented-number rule. Sources mirror `debug/voicemail-number-audit.ts`
  // exactly (the pure collector is shared, see collectAllowedNumbers), and
  // they are fetched only for businesses with an unreported call in the
  // window, which on a normal day is a handful.
  //
  // FAIL-OPEN by design: any failed source query disables the rule for this
  // whole run instead of detecting against a partial set. A shrunken
  // allowlist reports correct calls as fabrications, and a detector that
  // cries wolf gets muted, which is worse than one that misses a day.
  const implicated = [...new Set(calls.filter((c) => !reported.has(c.id)).map((c) => c.business_id))];
  let allowlistOk = implicated.length > 0;
  const allowedByBusiness = new Map<string, Set<string>>();
  if (allowlistOk) {
    type Row = Record<string, unknown>;
    const phoneKeyedRows = new Map<string, Row[]>();
    const bareValues = new Map<string, unknown[]>();
    const flowDefs = new Map<string, unknown[]>();
    for (const id of implicated) {
      phoneKeyedRows.set(id, []);
      bareValues.set(id, []);
      flowDefs.set(id, []);
    }
    const fail = async (stage: string, message: string) => {
      allowlistOk = false;
      console.error(`call-integrity-sweep: allowlist ${stage} select`, message);
      await telemetryRecord(supabase, "call_integrity_sweep_error", {
        stage: `allowlist_${stage}`,
        error: message
      });
    };
    {
      const { data, error } = await supabase.from("businesses").select("*").in("id", implicated);
      if (error) await fail("businesses", error.message);
      for (const row of (data ?? []) as Row[]) phoneKeyedRows.get(row.id as string)?.push(row);
    }
    {
      const { data, error } = await supabase
        .from("business_telnyx_settings")
        .select("*")
        .in("business_id", implicated);
      if (error) await fail("telnyx_settings", error.message);
      for (const row of (data ?? []) as Row[]) phoneKeyedRows.get(row.business_id as string)?.push(row);
    }
    {
      const { data, error } = await supabase
        .from("ai_flow_team_members")
        .select("*")
        .in("business_id", implicated);
      if (error) await fail("team_members", error.message);
      for (const row of (data ?? []) as Row[]) phoneKeyedRows.get(row.business_id as string)?.push(row);
    }
    {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("business_id, phone_number")
        .in("business_id", implicated);
      if (error) await fail("notification_preferences", error.message);
      for (const row of (data ?? []) as Row[]) {
        bareValues.get(row.business_id as string)?.push(row.phone_number);
      }
    }
    {
      const { data, error } = await supabase
        .from("telnyx_voice_routes")
        .select("business_id, to_e164")
        .in("business_id", implicated);
      if (error) await fail("voice_routes", error.message);
      for (const row of (data ?? []) as Row[]) bareValues.get(row.business_id as string)?.push(row.to_e164);
    }
    // Paged like the transcripts: flow definitions are the one source that can
    // plausibly cross the PostgREST cap, and a silently truncated select here
    // would shrink the allowlist, which is the false-positive failure above.
    for (let from = 0; allowlistOk; from += PAGE) {
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, business_id, definition")
        .in("business_id", implicated)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        await fail("flows", error.message);
        break;
      }
      const rows = (data ?? []) as Row[];
      for (const row of rows) flowDefs.get(row.business_id as string)?.push(row.definition);
      if (rows.length < PAGE) break;
    }
    if (allowlistOk) {
      for (const id of implicated) {
        allowedByBusiness.set(
          id,
          collectAllowedNumbers({
            phoneKeyedRows: phoneKeyedRows.get(id),
            values: bareValues.get(id),
            flowDefinitions: flowDefs.get(id)
          })
        );
      }
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

    // Reading a party their OWN number back is explicitly allowed (PR #1612),
    // so this call's numbers join the set per call rather than business-wide.
    const base = allowlistOk ? allowedByBusiness.get(call.business_id) : undefined;
    let allowedNumbers: Set<string> | undefined;
    if (base) {
      allowedNumbers = new Set(base);
      for (const v of [call.caller_e164, call.forwarded_to_e164]) {
        const n = spokenNumberForm(v);
        if (n) allowedNumbers.add(n);
      }
    }

    // Amounts need no fleet lookup: the legitimate ones are whatever the other
    // party said on this very call, which is already loaded. Unlike the number
    // allowlist there is nothing to fail-open on, so the rule runs on every
    // call regardless of `allowlistOk`.
    const findings: CallIntegrityFinding[] = detectCallIntegrity(turns, {
      ...(allowedNumbers ? { allowedNumbers } : {}),
      allowedAmounts: callerAmounts(turns)
    });
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
            : finding.kind === "invented_contact_number"
              ? `The AI gave out a phone number this business does not own (${call.caller_e164 ?? "unknown caller"}). ${finding.detail}`
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

  // Email, so a finding reaches someone instead of waiting to be found. The
  // fleet error feed already has it; this is the push half.
  //
  // Deliberately email and not a webhook: ALERT_WEBHOOK_URL has never been
  // set in this project, so the webhook this originally copied from
  // voice-bridge-health-alerts would have been silently inert, which is the
  // whole failure mode being fixed. The Resend vars ARE configured.
  //
  // No throttle needed here, unlike the bridge health sweep: this runs daily
  // and already skips calls it has reported, so it cannot repeat itself.
  let alertResult: string | null = null;
  if (alerts.length > 0) {
    const config = resolveAdminAlertConfig((name) => Deno.env.get(name));
    if (!config) {
      alertResult = "unconfigured";
      // Loud, because a detector that finds something and tells nobody is
      // the exact bug this sweep exists to catch in the AI.
      console.error("call-integrity-sweep: findings but no alert email configured");
      await telemetryRecord(supabase, "call_integrity_sweep_alert_unconfigured", {
        findings: alerts.length
      });
    } else {
      alertResult = await sendAdminAlertEmail(
        (url, init) => fetch(url, init),
        config,
        { subject: callIntegrityAlertSubject(alerts), text: formatCallIntegrityAlert(alerts) }
      );
      if (alertResult !== "sent") {
        // The system_logs rows are already written, so a mail outage is not a
        // failed run. Record it and answer 200.
        await telemetryRecord(supabase, "call_integrity_sweep_alert_failed", {
          findings: alerts.length
        });
      }
    }
  }

  // Provider error text stays out of the HTTP response: it can carry upstream
  // messages, and CodeQL flags that as information exposure. The detail is in
  // the telemetry events above.
  return new Response(
    JSON.stringify({
      ok: true,
      scanned,
      findings: alerts.length,
      alert: alertResult,
      summary: formatCallIntegrityAlert(alerts)
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
