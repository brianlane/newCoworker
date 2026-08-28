/**
 * Did the parked-follow-up mechanism actually work in production?
 *
 * PR #1702 shipped a mechanism nobody has ever seen run. A referral network
 * withholds a lead's phone and email until the claim is confirmed on its side,
 * so a teammate texting "F, <name>" during that window is asking about a lead
 * with no contact row. The SMS webhook parks the request on the live AiFlow
 * run; the worker applies it when upsert_customer finally files the contact.
 *
 * Every defect in it (seven, across four review rounds) was caught by review,
 * NONE by production, because as of the deploy it had never fired: zero parked,
 * zero applied across 500 recent runs. Passing review is not evidence that a
 * thing works, so this script is what turns "unproven" into "proven", and it is
 * also the thing that would catch it misbehaving.
 *
 * It answers four questions:
 *
 *   1. Has a request been PARKED yet? (`__follow_up_requested_by` on a run)
 *   2. Has one been APPLIED yet? (`__follow_up_requested_applied`)
 *   3. For each applied one, did the promise actually land: is the contact
 *      tagged "Needs Follow Up", did a cadence run start, and did the asker
 *      get their confirmation text?
 *   4. Regression check on the OTHER half of #1702: has any run failed with
 *      the self-send guard error since the deploy? That guard killed Amy's
 *      run whenever she claimed her own lead, and a recurrence means the
 *      exemption is not working.
 *
 * Read-only. Usage:
 *   tsx debug/follow-up-park-watch.ts
 *   tsx debug/follow-up-park-watch.ts --since 2026-08-28T18:20:29Z
 *   tsx debug/follow-up-park-watch.ts --business <uuid>
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]!
    : null;
}

/**
 * Default window opens at the moment #1702's edge functions went live. Before
 * that instant the mechanism did not exist, so counting runs from earlier
 * would dilute "never fired" with runs that never could have.
 */
const DEPLOYED_AT = "2026-08-28T18:20:29Z";
const since = arg("since") ?? DEPLOYED_AT;
const onlyBusiness = arg("business");

const FOLLOW_UP_TAG = "needs follow up";
const PARKED_BY = "__follow_up_requested_by";
const PARKED_NAME = "__follow_up_requested_name";
const APPLIED = "__follow_up_requested_applied";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

// PostgREST caps an un-limited select at 1000 rows and does it SILENTLY, so
// the limit is explicit and reported: a truncated scan that reads as "nothing
// found" is exactly the false negative this script exists to avoid.
const SCAN = 1000;
let runQuery = db
  .from("ai_flow_runs")
  .select("id, business_id, flow_id, status, context, created_at, updated_at, last_error")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(SCAN);
if (onlyBusiness) runQuery = runQuery.eq("business_id", onlyBusiness);
const { data: runs, error } = await runQuery;
if (error) {
  console.error(`run scan FAILED: ${error.message}`);
  process.exit(1);
}
const rows = (runs ?? []) as Array<{
  id: string;
  business_id: string;
  flow_id: string;
  status: string;
  // deno-lint-ignore no-explicit-any
  context: any;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}>;

console.log(`Scanned ${rows.length} run(s) created since ${since}${onlyBusiness ? ` for ${onlyBusiness}` : ""}.`);
if (rows.length === SCAN) {
  console.log(`  NOTE: hit the ${SCAN}-row scan cap, so this is a partial view. Narrow with --since.`);
}

const parked = rows.filter((r) => r.context?.vars?.[PARKED_BY]);
const applied = rows.filter((r) => r.context?.vars?.[APPLIED] === true);

console.log(`\n1. PARKED requests: ${parked.length}`);
console.log(`2. APPLIED requests: ${applied.length}`);

if (parked.length === 0) {
  console.log(
    "\n   Still unproven. The mechanism has not fired yet, which is not the same\n" +
      "   as working. Re-run after the next referral where a teammate texts F\n" +
      "   while the lead's contact details are still withheld."
  );
}

for (const r of parked) {
  const v = r.context.vars;
  const name = v[PARKED_NAME] || "(unnamed)";
  const done = v[APPLIED] === true;
  console.log(`\n   run ${r.id}  business ${r.business_id.slice(0, 8)}  status ${r.status}`);
  console.log(`     lead: ${name}   asked by: ${v[PARKED_BY]}   applied: ${done ? "YES" : "not yet"}`);
  if (!done) {
    console.log("     (still parked; fires when upsert_customer files the contact)");
    continue;
  }
  // 3. Verify the PROMISE, not just the marker. The marker only says the code
  //    ran; these three reads say the teammate actually got what they asked
  //    for. A marker set with no tag is the failure mode worth catching.
  const { data: contacts } = await db
    .from("contacts")
    .select("id, display_name, customer_e164, tags")
    .eq("business_id", r.business_id)
    .ilike("display_name", `%${String(name).split(" ")[0]}%`)
    .limit(5);
  const hit = (contacts ?? []).find((c: { tags?: string[] | null }) =>
    (c.tags ?? []).some((t) => t.trim().toLowerCase() === FOLLOW_UP_TAG)
  );
  console.log(`     contact tagged "Needs Follow Up": ${hit ? `YES (${(hit as {id:string}).id})` : "NO  <-- PROMISE BROKEN"}`);

  if (hit) {
    const phone = (hit as { customer_e164?: string }).customer_e164 ?? "";
    const { data: cadence } = await db
      .from("ai_flow_runs")
      .select("id, status, created_at")
      .eq("business_id", r.business_id)
      .gte("created_at", r.updated_at)
      .limit(200);
    const started = (cadence ?? []).filter(
      // deno-lint-ignore no-explicit-any
      (c: any) => (c.context?.trigger?.from ?? "") === phone
    );
    console.log(`     cadence run(s) started for ${phone}: ${started.length}`);
  }
  const { data: acks } = await db
    .from("sms_outbound_log")
    .select("created_at, body")
    .eq("business_id", r.business_id)
    .eq("to_e164", v[PARKED_BY])
    .gte("created_at", r.updated_at)
    .limit(20);
  const confirmation = (acks ?? []).find((a: { body?: string }) =>
    /marked for follow-up|NOT calling them yet|did not mark/i.test(a.body ?? "")
  );
  console.log(
    `     asker got a text back: ${confirmation ? "YES" : "NO  <-- silent, which the fixes were supposed to make impossible"}`
  );
}

// 4. The other half of #1702. A recurrence means the teammate exemption on the
//    self-send guard is not doing its job, and runs are dying on the post-claim
//    hand-off again.
const selfSend = rows.filter((r) => /own number, refusing to text ourselves/i.test(r.last_error ?? ""));
console.log(`\n4. Runs killed by the self-send guard since the deploy: ${selfSend.length}`);
if (selfSend.length > 0) {
  console.log("   REGRESSION: the teammate exemption is not applying.");
  for (const r of selfSend) {
    console.log(`     run ${r.id}  business ${r.business_id.slice(0, 8)}  ${r.last_error?.slice(0, 120)}`);
  }
} else {
  console.log("   None. The post-claim hand-off is no longer dying on an owner-claimed lead.");
}
