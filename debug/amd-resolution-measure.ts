/**
 * Grade the AMD resolution sweep against real calls, per call, per arm.
 *
 * The sweep (voice-amd-resolution-sweep) forces action on machine verdicts
 * Telnyx never resolves (greeting events stopped platform-wide 2026-08-25;
 * memory project_telnyx_premium_amd_event_collapse). Per
 * feedback_score_prompt_changes_against_outcomes it ships dark and is graded
 * on real calls before widening: baseline mornings (model-only voicemails)
 * against treatment mornings (sweep enrolled via admin_platform_settings
 * key `voice_amd_resolution`).
 *
 * For every flow-placed outbound call in the window this prints, from the
 * session context and telemetry:
 *
 *   verdict   did a Telnyx detection event arrive (voice_amd_verdict), and what
 *   sweep     did the sweep act (voice_amd_resolution_forced), mode + outcome
 *   spoken    the honest voicemail_spoken stamp (speak.ended-confirmed,
 *             plausibility-promoted, or bridge confirmSpoken)
 *   speak_via edge (voicemail_speak_started_at present) vs model (bridge claim)
 *   ALARM     sweep acted on a leg whose transcript looks like a LIVE
 *             conversation: the false-positive machine case. Listen to the
 *             recording before widening the rollout; one real instance is a
 *             stop signal.
 *
 * Read-only. Usage:
 *   npx tsx debug/amd-resolution-measure.ts --business <uuid> [--since ISO]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const businessId = arg("business");
if (!businessId) {
  console.error("usage: npx tsx debug/amd-resolution-measure.ts --business <uuid> [--since ISO]");
  process.exit(1);
}
const since = arg("since") ?? "2026-08-25T00:00:00Z";

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

type SessionRow = {
  call_control_id: string;
  from_e164: string | null;
  created_at: string;
  context: Record<string, unknown> | null;
};

const { data: sessions, error: sessErr } = await db
  .from("voice_handoff_sessions")
  .select("call_control_id, from_e164, created_at, context")
  .eq("business_id", businessId)
  .gte("created_at", since)
  .order("created_at", { ascending: true })
  .limit(500);
if (sessErr) {
  console.error("sessions query failed", sessErr);
  process.exit(1);
}
// Flow-placed outbound calls only: those carry the parked run link.
const calls = ((sessions ?? []) as SessionRow[]).filter(
  (s) => (s.context as { flow_run?: unknown } | null)?.flow_run
);

const { data: telemetry, error: telErr } = await db
  .from("telemetry_events")
  .select("event_type, payload, created_at")
  .in("event_type", ["voice_amd_verdict", "voice_amd_resolution_forced"])
  .gte("created_at", since)
  .order("created_at", { ascending: true })
  .limit(2000);
if (telErr) {
  console.error("telemetry query failed", telErr);
  process.exit(1);
}
const byCall = new Map<string, { verdicts: string[]; sweep: string[] }>();
for (const row of telemetry ?? []) {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const cc = typeof p.call_control_id === "string" ? p.call_control_id : "";
  if (!cc) continue;
  if (!byCall.has(cc)) byCall.set(cc, { verdicts: [], sweep: [] });
  const entry = byCall.get(cc)!;
  if (row.event_type === "voice_amd_verdict") {
    entry.verdicts.push(String(p.verdict ?? p.result ?? "?"));
  } else {
    entry.sweep.push(`${String(p.mode ?? "?")}:${String(p.outcome ?? "?")}`);
  }
}

// A sweep action on a call whose transcript shows a live back-and-forth is
// the false-positive-machine alarm. Cheap proxy: any caller turn that does
// not look machine-generated after the sweep acted; the recording decides.
async function transcriptLooksLive(callControlId: string): Promise<boolean> {
  const { data: transcript } = await db
    .from("voice_call_transcripts")
    .select("id")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const transcriptId = (transcript as { id?: string } | null)?.id;
  if (!transcriptId) return false;
  const { data: turns } = await db
    .from("voice_call_transcript_turns")
    .select("role, content")
    .eq("transcript_id", transcriptId)
    .neq("role", "assistant")
    .limit(50);
  const spoken = ((turns ?? []) as Array<{ content: string | null }>).filter((t) =>
    (t.content ?? "").trim()
  );
  return spoken.length >= 3;
}

let machine = 0;
let verdictBacked = 0;
let swept = 0;
let spokenCount = 0;
const alarms: string[] = [];
console.log(`flow-placed calls since ${since}: ${calls.length}\n`);
for (const call of calls) {
  const ctx = (call.context ?? {}) as Record<string, unknown>;
  const tel = byCall.get(call.call_control_id) ?? { verdicts: [], sweep: [] };
  const isMachine = ctx.machine_detected === true;
  const spoken = ctx.voicemail_spoken === true;
  const speakVia =
    typeof ctx.voicemail_speak_started_at === "string"
      ? "edge"
      : ctx.voicemail_claimed === true
        ? "model"
        : "-";
  if (isMachine) machine++;
  if (isMachine && tel.verdicts.length) verdictBacked++;
  if (tel.sweep.length) swept++;
  if (isMachine && spoken) spokenCount++;
  let alarm = "";
  if (tel.sweep.length && (await transcriptLooksLive(call.call_control_id))) {
    alarm = "  << ALARM: sweep acted on a live-looking transcript";
    alarms.push(call.call_control_id);
  }
  console.log(
    `${call.created_at}  ${call.call_control_id.slice(0, 18)}… to=${call.from_e164 ?? "?"}\n` +
      `  machine=${isMachine} verdicts=[${tel.verdicts.join(",")}] sweep=[${tel.sweep.join(",")}] spoken=${spoken} via=${speakVia}${alarm}`
  );
}
console.log(
  `\nsummary: machine=${machine} verdict_backed=${verdictBacked} sweep_acted=${swept} scripted_message_delivered=${spokenCount}`
);
if (alarms.length) {
  console.log(`ALARMS (listen to recordings before widening rollout): ${alarms.join(", ")}`);
  process.exitCode = 2;
}
