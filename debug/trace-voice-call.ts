/**
 * Trace ONE outbound AI call across every table it touches, as a timeline.
 *
 * Built for live-testing the seller auto-call work. When one of those calls
 * misbehaves the evidence is scattered across six places, and the interesting
 * failures are precisely the ones where two of them DISAGREE:
 *
 *   voice_outbound_dial_log    did we dial, once, and was it released?
 *   voice_handoff_sessions     the AI session: persona, AMD verdict, reach
 *                              attempts, transfer stamp, the parked-run link
 *   voice_reservations         was budget reserved and settled, or leaked?
 *   voice_call_transcripts     what was actually SAID, plus the AMD columns
 *   ai_flow_runs               the outcome the flow recorded and acted on
 *   ai_flow_run_steps          which step failed, and what it saw
 *
 * A call that "worked" but left the run parked, or resolved `answered` while
 * the transcript shows a voicemail greeting, is invisible in any one of those
 * and obvious side by side. That disagreement is what this prints.
 *
 * Read-only. Safe to run against production at any time.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   tsx debug/trace-voice-call.ts --call v3:abc...        # by call_control_id
 *   tsx debug/trace-voice-call.ts --peer +16025551234     # newest call with that party
 *   tsx debug/trace-voice-call.ts --run <ai_flow_run uuid>
 *   tsx debug/trace-voice-call.ts --peer +1... --transcript  # include what was said
 *
 * With no selector it shows the newest outbound AI call for the business.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const AMY = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) {
    return process.argv[i + 1]!;
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
}
const has = (n: string): boolean => process.argv.includes(`--${n}`);

const businessId = arg("business-id") ?? AMY;
const wantTranscript = has("transcript");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = Record<string, unknown>;
const ts = (v: unknown): string => (typeof v === "string" ? v.slice(11, 23) : "??:??:??");
const day = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : "?");

/** Resolve which call to trace from whichever selector was given. */
async function resolveCallControlId(): Promise<string | null> {
  const direct = arg("call");
  if (direct) return direct;

  const runId = arg("run");
  if (runId) {
    const { data, error } = await db
      .from("ai_flow_runs")
      .select("context")
      .eq("id", runId)
      .maybeSingle();
    if (error) {
      console.error(`ai_flow_runs lookup FAILED: ${error.message}`);
      console.error("This is a query error, not an empty result. Nothing was ruled out.");
      return null;
    }
    const cci = (data as Row | null)?.context as Row | undefined;
    const waiting = (cci?.waiting_call ?? {}) as Row;
    if (typeof waiting.call_control_id === "string") return waiting.call_control_id;
    console.error(`Run ${runId} has no parked call to trace.`);
    return null;
  }

  // NOTE: the column is `from_e164`, the OTHER party on the leg. There is no
  // `to_e164` here. On an inbound call that is the caller; on an outbound one
  // it is the person we dialled, which is what `--peer` matches.
  const peer = arg("peer") ?? arg("to");
  let q = db
    .from("voice_handoff_sessions")
    .select("call_control_id, created_at, from_e164, context")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (peer) {
    q = q.eq("from_e164", peer);
  } else {
    // The header promises "the newest OUTBOUND AI call" for the no-selector
    // form, so keep that promise: without this filter the newest row is
    // usually an inbound receptionist session, which silently traces the
    // wrong call. --peer intentionally matches either direction.
    q = q.eq("context->>outbound", "true");
  }
  const { data, error } = await q;
  // A failed query must never read as "nothing found". That is the single
  // worst failure mode for a debugging tool: it sends the person looking in
  // the wrong place while insisting there is nothing to see.
  if (error) {
    console.error(`voice_handoff_sessions lookup FAILED: ${error.message}`);
    console.error("This is a query error, not an empty result. Nothing was ruled out.");
    return null;
  }
  const row = ((data ?? []) as Row[])[0];
  if (!row) {
    console.error(
      peer
        ? `No voice session found with from_e164 ${peer} on ${businessId}.`
        : `No OUTBOUND voice sessions on ${businessId}. (Inbound ones may exist; pass --peer or --call to trace one.)`
    );
    return null;
  }
  return String(row.call_control_id);
}

const callControlId = await resolveCallControlId();
if (!callControlId) process.exit(1);

console.log(`\n=== call ${callControlId} ===`);
console.log(`business ${businessId}\n`);

// --- the AI session: the richest single record ---------------------------
const { data: sessData, error: sessErr } = await db
  .from("voice_handoff_sessions")
  .select("*")
  .eq("call_control_id", callControlId)
  .maybeSingle();
if (sessErr) console.error(`  (session lookup failed: ${sessErr.message})`);
const sess = sessData as Row | null;
if (!sess) {
  console.log("voice_handoff_sessions : (no row)");
  console.log(
    "  No session means the AI never attached. Either origination refused before\n" +
      "  the dial, or the leg was hung up before call.answered."
  );
} else {
  const ctx = (sess.context ?? {}) as Row;
  const ai = (ctx.ai_takeover ?? {}) as Row;
  const reach = (ctx.reach ?? {}) as Row;
  console.log(`session      : status=${sess.status}  ${day(sess.created_at)} ${ts(sess.created_at)}`);
  console.log(`  other party: ${sess.from_e164 ?? "(unknown)"}`);
  console.log(`  direction  : ${ctx.outbound === true ? "outbound" : "inbound"}`);
  console.log(`  persona    : ${String(ai.persona ?? "(none)").slice(0, 90)}`);
  console.log(`  machine    : ${ctx.machine_detected === true ? "YES (voicemail)" : "no"}`);
  console.log(`  transfer   : ${ctx.transfer_initiated === true ? "initiated" : "no"}`);
  if (Object.keys(reach).length > 0) {
    console.log(`  reach      : attempt=${reach.attempt} status=${reach.status} b_leg=${reach.b_leg}`);
  }
  const link = (ctx.flow_run ?? {}) as Row;
  if (link.run_id) console.log(`  parked run : ${link.run_id} (save_as=${link.save_as})`);
}

// --- the dial ledger: exactly-once, and whether it was released ----------
// This call's own ledger row first (the ledger stamps call_control_id once
// originate returns one), then recent business rows for context, so tracing
// one call can never hide that call's row behind five unrelated dials.
const { data: ownDialData, error: ownDialErr } = await db
  .from("voice_outbound_dial_log")
  .select("dedupe_key,status,reason,to_e164,created_at")
  .eq("call_control_id", callControlId)
  .maybeSingle();
if (ownDialErr) console.error(`dial ledger (this call) LOOKUP FAILED: ${ownDialErr.message}`);
const ownDial = ownDialData as Row | null;
const { data: dialData, error: dialErr } = await db
  .from("voice_outbound_dial_log")
  .select("dedupe_key,status,reason,to_e164,created_at,call_control_id")
  .eq("business_id", businessId)
  .order("created_at", { ascending: false })
  .limit(5);
if (dialErr) console.error(`dial ledger LOOKUP FAILED: ${dialErr.message}`);
const dials = (dialData ?? []) as Row[];
console.log(`\ndial ledger  : ${ownDialErr ? "LOOKUP FAILED" : ownDial ? `this call: ${ownDial.status}  to=${ownDial.to_e164 ?? "-"}  ${ownDial.reason ?? ""}` : "(no row for THIS call)"}`);
console.log(`  recent for business: ${dialErr ? "LOOKUP FAILED" : `${dials.length} row(s)`}`);
for (const d of dials) {
  const marker = d.call_control_id === callControlId ? "  <-- this call" : "";
  console.log(`  ${day(d.created_at)} ${ts(d.created_at)}  ${d.status}  to=${d.to_e164 ?? "-"}  ${d.reason ?? ""}${marker}`);
}
if (dials.length === 0 && !dialErr && !ownDial && !ownDialErr) {
  console.log(
    "  Empty is EXPECTED for a call placed straight through originate\n" +
      "  (debug/place-test-outbound-call.ts). Only the worker's place_ai_call\n" +
      "  step writes this ledger."
  );
}

// --- budget: reserved and settled, or leaked? ----------------------------
const { data: resvData, error: resvErr } = await db
  .from("voice_reservations")
  .select("state,answer_issued_at,created_at,reserved_total_seconds,ws_connected_at")
  .eq("call_control_id", callControlId)
  .maybeSingle();
if (resvErr) console.error(`reservation LOOKUP FAILED: ${resvErr.message}`);
const resv = resvData as Row | null;
console.log(
  `\nbudget       : ${resvErr ? "LOOKUP FAILED" : resv ? String(resv.state) : "(no reservation)"}`
);
if (resv) {
  console.log(`  answered   : ${resv.answer_issued_at ? "yes " + ts(resv.answer_issued_at) : "NO"}`);
  console.log(`  media       : ${resv.ws_connected_at ? "attached " + ts(resv.ws_connected_at) : "never attached"}`);
  console.log(`  reserved   : ${resv.reserved_total_seconds ?? "-"}s`);
}

// --- what the call view will show ---------------------------------------
const { data: trData, error: trErr } = await db
  .from("voice_call_transcripts")
  .select("id,status,direction,answering_machine_result,voicemail_left,voicemail_verbatim_score,summary")
  .eq("call_control_id", callControlId)
  .maybeSingle();
if (trErr) {
  console.error(`transcript LOOKUP FAILED: ${trErr.message}`);
  console.error(
    "  If this names answering_machine_result, the AMD columns have not been\n" +
      "  deployed yet. That migration applies on the push-to-main run."
  );
}
const tr = trData as Row | null;
console.log(
  `\ntranscript   : ${trErr ? "LOOKUP FAILED" : tr ? `${tr.status} (${tr.direction})` : "(no row)"}`
);
if (tr) {
  console.log(`  AMD        : ${tr.answering_machine_result ?? "(not requested)"}`);
  console.log(`  voicemail  : left=${tr.voicemail_left === true}  script=${tr.voicemail_verbatim_score ?? "-"}`);
  if (wantTranscript) {
    const { data: turns } = await db
      .from("voice_call_transcript_turns")
      .select("role,content,turn_index")
      .eq("transcript_id", tr.id)
      .order("turn_index", { ascending: true });
    console.log("\n  --- what was actually said ---");
    for (const t of ((turns ?? []) as Row[])) {
      console.log(`  ${String(t.role).padEnd(9)} ${String(t.content).slice(0, 160)}`);
    }
  } else {
    console.log("  (pass --transcript to print what was said)");
  }
}

// --- the flow's own view of the same call --------------------------------
const linkRunId = (((sess?.context ?? {}) as Row).flow_run as Row | undefined)?.run_id;
if (typeof linkRunId === "string") {
  const { data: runData } = await db
    .from("ai_flow_runs")
    .select("id,status,current_step,context,last_error,updated_at")
    .eq("id", linkRunId)
    .maybeSingle();
  const run = runData as Row | null;
  if (run) {
    const vars = ((run.context ?? {}) as Row).vars as Row | undefined;
    console.log(`\nflow run     : ${run.status}  step=${run.current_step}  ${ts(run.updated_at)}`);
    if (run.last_error) console.log(`  error      : ${String(run.last_error).slice(0, 160)}`);
    for (const k of Object.keys(vars ?? {})) {
      if (/^call_outcome/.test(k)) console.log(`  ${k.padEnd(22)} = ${JSON.stringify((vars ?? {})[k])}`);
    }
  }
}

// --- the disagreements worth naming out loud -----------------------------
console.log("\n=== consistency ===");
const machine = ((sess?.context ?? {}) as Row).machine_detected === true;
const answered = Boolean(resv?.answer_issued_at);
const amd = tr?.answering_machine_result;
if (machine && !trErr && tr && amd !== "machine") {
  console.log("  MISMATCH: session says a machine answered, the transcript row does not.");
  console.log("            The call view will show this as an ordinary call.");
}
if (machine && answered) {
  console.log("  note: a voicemail ANSWERS the leg, so answer_issued_at being set is");
  console.log("        expected here and is exactly why AMD is needed to tell them apart.");
}
if (sess && !resv && !resvErr) {
  console.log("  MISMATCH: an AI session exists with no budget reservation. Minutes may");
  console.log("            be unmetered; check voice_reserve.");
}
if (resv && sess?.status === "done" && resv.state !== "settled") {
  console.log(`  MISMATCH: the call is done but its reservation is "${resv.state}".`);
  console.log("            A leaked reservation holds a concurrency slot.");
}
if (sessErr || resvErr || trErr || dialErr || ownDialErr) {
  console.log("  NOTE: at least one lookup FAILED above, so this section is incomplete.");
  console.log("        A failed query is not an absence of evidence.");
}
console.log("");
