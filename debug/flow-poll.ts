/**
 * Poll a business's AiFlow activity: the 3 latest runs, the executed steps of
 * the newest one, and a merged inbound/outbound SMS timeline for one phone
 * number. The quick "what did the engine just do" companion to the
 * flow-test-* harness.
 *
 * Defaults to the New Coworker (HQ, internal) tenant and the harness tester's
 * number. Read-only, Supabase only (no SSH).
 *
 * Usage: tsx debug/flow-poll.ts [businessId] [--phone +1XXXXXXXXXX]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const TESTER_E164 = "+16026866672";

// Positional businessId = the first token that is neither a flag nor a
// flag's value (so `flow-poll.ts --phone +1…` keeps the HQ default).
const argv = process.argv.slice(2);
let businessId = HQ_BUSINESS_ID;
let LEAD = TESTER_E164;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--phone") {
    if (argv[i + 1]) LEAD = argv[++i];
  } else if (a.startsWith("--phone=")) {
    LEAD = a.slice(8);
  } else if (!a.startsWith("--")) {
    businessId = a;
  }
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: runs } = await db
  .from("ai_flow_runs")
  .select("id,status,created_at,updated_at")
  .eq("business_id", businessId)
  .order("created_at", { ascending: false })
  .limit(3);
for (const r of runs ?? []) {
  console.log(`run ${r.id.slice(0, 8)} ${r.status} updated ${r.updated_at}`);
}

const latest = runs?.[0];
if (latest) {
  const { data: steps } = await db
    .from("ai_flow_run_steps")
    .select("step_index,step_type,status,result,error,updated_at")
    .eq("run_id", latest.id)
    .order("step_index", { ascending: true });
  for (const s of steps ?? []) {
    if (s.status === "skipped") continue;
    console.log(
      `  #${s.step_index} ${s.step_type} ${s.status} ${(JSON.stringify(s.result) ?? "").slice(0, 200)} ${s.error ?? ""}`
    );
  }
}

const { data: outMsgs } = await db
  .from("sms_outbound_log")
  .select("to_e164,body,created_at")
  .eq("business_id", businessId)
  .eq("to_e164", LEAD)
  .order("created_at", { ascending: false })
  .limit(6);
const { data: inMsgs } = await db
  .from("sms_inbound_jobs")
  .select("payload,created_at")
  .eq("business_id", businessId)
  .order("created_at", { ascending: false })
  .limit(6);
const events: Array<{ at: string; line: string }> = [];
for (const m of outMsgs ?? []) {
  events.push({ at: m.created_at, line: `OUT: ${(m.body ?? "").slice(0, 220)}` });
}
for (const j of inMsgs ?? []) {
  const p = j.payload as Record<string, unknown> | null;
  const data = (p?.data ?? p) as Record<string, unknown> | undefined;
  const payload = (data?.payload ?? data) as Record<string, unknown> | undefined;
  const from = (payload?.from as Record<string, unknown> | undefined)?.phone_number ?? "";
  const text = (payload?.text as string | undefined) ?? JSON.stringify(p).slice(0, 120);
  // Only rows provably from the watched number — an unparseable sender must
  // not leak another contact's messages into this number's timeline.
  if (from !== LEAD) continue;
  events.push({ at: j.created_at, line: `IN : ${String(text).slice(0, 220)}` });
}
events.sort((a, b) => (a.at < b.at ? -1 : 1));
console.log("--- SMS timeline (oldest first)");
for (const e of events) console.log(`  [${e.at}] ${e.line}`);
