/**
 * Place ONE outbound AI call through the real origination path, and report
 * what the platform recorded about it.
 *
 * Why this exists: `place_ai_call` has never dialed anyone in production.
 * `voice_outbound_dial_log` is empty fleet-wide, so the entire outbound path
 * (originate, budget reserve, session write, bridge attach, answering-machine
 * detection, run resume) has only ever run in tests. Before a lead flow starts
 * dialing real sellers automatically, somebody has to watch one call happen.
 *
 * The existing `demo-testcall.ts` cannot do that: it originates an INBOUND
 * call TO a voice line so the AI answers it. That exercises the receptionist
 * path, not the outbound one, and none of the machinery above is involved.
 *
 * This script goes through `telnyx-voice-originate` with a `call` payload,
 * the exact same entry point the ai-flow-worker's place_ai_call step uses, so
 * what it proves is what will actually happen to a lead.
 *
 * ⚠️ Places a REAL call to whatever number you give it and spends real voice
 * minutes on the tenant's budget. Dry-run is the default; `--apply` dials.
 * Point it at your own phone.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   tsx debug/place-test-outbound-call.ts --to +16025551234                # dry run
 *   tsx debug/place-test-outbound-call.ts --to +16025551234 --apply
 *   tsx debug/place-test-outbound-call.ts --to +1... --apply --voicemail
 *
 * Flags:
 *   --to <e164>        who to call (required)
 *   --apply            actually dial; without it nothing is placed
 *   --business-id <id> tenant whose flow/budget/box is used (default: HQ)
 *   --flow-id <id>     an ENABLED flow on that business to attribute the call
 *                      to. Originate requires one; any enabled flow works
 *   --voicemail        script the AI to speak briefly and hang up, so the call
 *                      can be sent to voicemail on purpose to exercise
 *                      answering-machine detection
 *   --watch <seconds>  poll the recorded outcome for this long (default 120)
 *
 * What to check afterwards, in order of what is most likely to be wrong:
 *   1. the phone actually rang, and the AI spoke first;
 *   2. `voice_outbound_dial_log` gained exactly ONE row for this call;
 *   3. the session's outcome matches what really happened (in particular, a
 *      call you sent to voicemail must NOT come back "answered");
 *   4. voice minutes were reserved and settled rather than leaked.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) {
    return process.argv[i + 1]!;
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const to = arg("to");
const apply = has("apply");
const voicemailMode = has("voicemail");
const businessId = arg("business-id") ?? HQ_BUSINESS_ID;
const watchSeconds = Number(arg("watch") ?? "120");

if (!to || !/^\+[1-9]\d{6,15}$/.test(to)) {
  console.error("Pass --to +1XXXXXXXXXX (E.164).");
  process.exit(2);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const cronSecret = process.env.INTERNAL_CRON_SECRET ?? "";
if (!supabaseUrl || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}
if (!cronSecret) {
  // The originate function authenticates with this shared secret, NOT the
  // service-role key, so a missing value fails with a bare 401 that reads
  // like a permissions problem.
  console.error("INTERNAL_CRON_SECRET required in .env (originate authenticates with it)");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// Originate insists on a real, enabled flow on this business: it is what the
// call is attributed to for budget and telemetry. Any enabled flow serves.
let flowId = arg("flow-id");
if (!flowId) {
  const { data } = await db
    .from("ai_flows")
    .select("id,name")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .limit(1);
  const row = (data ?? [])[0] as { id: string; name: string } | undefined;
  if (!row) {
    console.error(
      `No enabled flow on ${businessId}. Pass --flow-id, or enable one: the ` +
        "originate function refuses a call it cannot attribute."
    );
    process.exit(2);
  }
  flowId = row.id;
  console.log(`Flow      : ${row.name} (${row.id})`);
}

const persona = voicemailMode
  ? "This is a test call from the New Coworker platform. Nothing is required of you. Goodbye."
  : "Hi, this is a test call from the New Coworker platform. Nothing is required of you, " +
    "this is only checking that outbound calling works. How are you today?";

const payload = {
  businessId,
  flowId,
  call: {
    toE164: to,
    persona,
    contextNote: "This is an internal platform test call. There is no real customer.",
    notifyE164: to,
    captureFields: [] as string[]
  }
};

console.log(`Business  : ${businessId}`);
console.log(`Calling   : ${to}`);
console.log(`Mode      : ${voicemailMode ? "voicemail (speak briefly, expect a machine)" : "conversation"}`);
console.log(`Persona   : ${persona}`);

if (!apply) {
  console.log("\n[dry-run] Nothing dialed. Re-run with --apply to place the call.");
  console.log("Remember: --apply rings a real phone and spends real voice minutes.");
  process.exit(0);
}

const before = await db
  .from("voice_outbound_dial_log")
  .select("id", { count: "exact", head: true })
  .eq("business_id", businessId);

console.log("\nDialing through telnyx-voice-originate ...");
const res = await fetch(`${supabaseUrl}/functions/v1/telnyx-voice-originate`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${cronSecret}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});
const bodyText = await res.text();
console.log(`originate -> HTTP ${res.status} ${bodyText.slice(0, 400)}`);

let callControlId = "";
try {
  callControlId = (JSON.parse(bodyText) as { callControlId?: string }).callControlId ?? "";
} catch {
  // Non-JSON body already printed above.
}
if (!callControlId) {
  console.error(
    "\nNo call_control_id came back, so nothing was dialed. The response above " +
      "carries the reason; `dialed:false` means the callee was never rung and " +
      "the attempt is safe to retry."
  );
  process.exit(1);
}

console.log(`\ncall_control_id: ${callControlId}`);
console.log(`Watching the recorded outcome for ${watchSeconds}s ...\n`);

const deadline = Date.now() + watchSeconds * 1000;
let lastPrinted = "";
while (Date.now() < deadline) {
  const { data: sess } = await db
    .from("voice_handoff_sessions")
    .select("status, context")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const row = sess as { status?: string; context?: Record<string, unknown> } | null;
  const ctx = row?.context ?? {};
  const line = [
    `status=${row?.status ?? "(no session row)"}`,
    `machine_detected=${ctx.machine_detected === true}`,
    `transfer_initiated=${ctx.transfer_initiated === true}`
  ].join("  ");
  if (line !== lastPrinted) {
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);
    lastPrinted = line;
  }
  if (row?.status === "done") break;
  await new Promise((r) => setTimeout(r, 3000));
}

const after = await db
  .from("voice_outbound_dial_log")
  .select("id,status,reason,to_e164,created_at", { count: "exact" })
  .eq("business_id", businessId)
  .order("created_at", { ascending: false })
  .limit(3);

console.log("\n=== dial ledger (newest 3 for this business) ===");
for (const r of (after.data ?? []) as Array<Record<string, unknown>>) {
  console.log(`  ${String(r.created_at).slice(0, 19)}  ${r.status}  to=${r.to_e164 ?? "-"}  ${r.reason ?? ""}`);
}
console.log(
  `\nLedger rows for this business: ${before.count ?? 0} before -> ${after.count ?? 0} after.`
);
console.log(
  "Exactly one new row is correct. Two would mean the exactly-once dial guard " +
    "failed, which is the failure that rings a lead twice."
);
if (voicemailMode) {
  console.log(
    "\nVoicemail check: if you sent this to voicemail, machine_detected above " +
      "must be true. False means answering-machine detection is not actually on " +
      "for this connection, and a voicemail will be reported as an answered call."
  );
}
