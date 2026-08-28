/**
 * Did the parked-follow-up mechanism actually work in production?
 *
 * PR #1702 shipped a mechanism that, at deploy time, had never run: zero
 * parked and zero applied across 500 recent runs. When a teammate texts
 * "F, <name>" about a lead whose contact details a referral site is still
 * withholding, the SMS webhook parks the request on the live AiFlow run and
 * the worker applies it once upsert_customer files the contact.
 *
 * WHY THIS PRINTS EVIDENCE RATHER THAN VERDICTS
 *
 * The first four versions of this script adjudicated: PROMISE BROKEN, OK,
 * cadence missing. Eleven review findings later, every single one was the
 * VERDICT being wrong, never the data gathering. Each verdict had to model
 * production semantics exactly, and each was a fresh way to be confidently
 * wrong in whichever direction hid the truth:
 *
 *   - a cadence filter on a column the query never selected (always zero)
 *   - a created_at floor that excluded the very writes it looked for
 *   - a first-name ilike that could credit a different contact
 *   - "any run for this phone" counting a sibling contact_created run
 *   - a trigger lookup blind to definition.triggers[] (5 live flows use it)
 *   - a staff refusal, which is production working AS DESIGNED, reported as
 *     a broken promise
 *   - finished and canceled cadence runs counted as active coverage
 *
 * So it stopped adjudicating. It prints what it found, in the order a person
 * would want to read it, and lets them judge. The ack bodies alone say which
 * of the three outcomes happened, in the words the teammate actually received.
 * The one verdict left is check 4, which is a literal string match on an error
 * column and cannot mean anything else.
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

/** When #1702's edge functions went live. Before this the mechanism did not exist. */
const DEPLOYED_AT = "2026-08-28T18:20:29Z";
const since = arg("since") ?? DEPLOYED_AT;
const onlyBusiness = arg("business");

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

// TARGETED queries, not a scan-and-filter.
//
// Both of these are EXISTENCE claims ("this never fired", "no regressions"),
// and a bounded recency-ordered scan cannot support one: a parked or dead run
// stops being touched once it settles, so ordinary live traffic pushes it out
// of the window and the script confidently reports nothing happened. A cap
// note does not repair the claim, it just footnotes it (Bugbot, PR #1710).
//
// Filtering server-side on the marker itself makes the result set inherently
// tiny (a handful of runs ever) and independent of how busy the fleet is. The
// limits below exist to bound a pathological case, and say so if they bite.
const LIMIT = 500;
let parkedQuery = db
  .from("ai_flow_runs")
  .select("id, business_id, status, context, created_at, updated_at")
  .not(`context->vars->>${PARKED_BY}`, "is", null)
  .gte("updated_at", since)
  .order("updated_at", { ascending: false })
  .limit(LIMIT);
if (onlyBusiness) parkedQuery = parkedQuery.eq("business_id", onlyBusiness);

let selfSendQuery = db
  .from("ai_flow_runs")
  .select("id, business_id, updated_at, last_error")
  .ilike("last_error", "%own number, refusing to text ourselves%")
  .gte("updated_at", since)
  .order("updated_at", { ascending: false })
  .limit(LIMIT);
if (onlyBusiness) selfSendQuery = selfSendQuery.eq("business_id", onlyBusiness);

const [parkedRes, selfSendRes] = await Promise.all([parkedQuery, selfSendQuery]);
if (parkedRes.error) {
  console.error(`parked-run query FAILED: ${parkedRes.error.message}`);
  process.exit(1);
}
if (selfSendRes.error) {
  console.error(`self-send query FAILED: ${selfSendRes.error.message}`);
  process.exit(1);
}
type Run = {
  id: string;
  business_id: string;
  status: string;
  // deno-lint-ignore no-explicit-any
  context: any;
  created_at: string;
  updated_at: string;
};
const parked = (parkedRes.data ?? []) as Run[];
const selfSend = (selfSendRes.data ?? []) as Array<{
  id: string;
  business_id: string;
  updated_at: string;
  last_error: string | null;
}>;
for (const [label, n] of [["parked", parked.length], ["self-send", selfSend.length]] as const) {
  if (n === LIMIT) console.log(`NOTE: the ${label} query hit its ${LIMIT}-row limit; this is a PARTIAL view.`);
}
console.log(
  `Looked for parked follow-ups and self-send deaths since ${since}` +
    `${onlyBusiness ? ` for ${onlyBusiness}` : ""}.`
);

console.log(`\n1. Runs carrying a parked follow-up request: ${parked.length}`);

if (parked.length === 0) {
  console.log(
    "\n   Still unproven. The mechanism has not fired, which is NOT the same as\n" +
      "   working. Re-run after a referral where a teammate texts F while the\n" +
      "   lead's contact details are still withheld."
  );
}

for (const r of parked) {
  const v = r.context.vars;
  const applied = v[APPLIED] === true;
  console.log(`\n   ── run ${r.id}  (${r.business_id.slice(0, 8)}, status ${r.status})`);
  console.log(`      lead:      ${v[PARKED_NAME] || "(unnamed)"}`);
  console.log(`      asked by:  ${v[PARKED_BY]}`);
  console.log(`      lead_phone var: ${v.lead_phone ?? "(none)"}`);
  console.log(`      applied:   ${applied ? "yes" : "NOT YET (still parked)"}`);
  if (!applied) continue;

  // What the teammate was actually TOLD. This is the strongest evidence there
  // is, because the three outcome texts are distinguishable in plain words:
  // "marked for follow-up" (applied), "NOT calling them yet" (could not, will
  // retry), "did not mark" (refused: the filed contact is one of our own
  // numbers, which is production working as designed, not a failure).
  // Scoped by run_id so another apply's ack can never be read as this one's.
  const { data: acks, error: ackErr } = await db
    .from("sms_outbound_log")
    .select("created_at, body")
    .eq("business_id", r.business_id)
    .eq("run_id", r.id)
    .eq("to_e164", v[PARKED_BY])
    .order("created_at", { ascending: false })
    .limit(20);
  if (ackErr) {
    console.log(`      acks: LOOKUP FAILED (${ackErr.message})`);
  } else if ((acks ?? []).length === 0) {
    console.log("      acks to the asker from this run: NONE");
  } else {
    console.log(`      acks to the asker from this run (${(acks ?? []).length}):`);
    for (const a of acks ?? []) {
      console.log(`        ${a.created_at}  ${String(a.body).replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }

  // The tag_changed event this apply enqueued, if it enqueued one. The CONTACT
  // ID is embedded in the dedupe key (ce:fu-pending:<runId>:<contactId>), so
  // the filed contact is identified exactly, with no phone normalization to
  // get wrong. Absence is not failure: the enqueue only happens when the tag
  // was NEWLY added, and a staff refusal skips it on purpose.
  const { data: events, error: evErr } = await db
    .from("ai_flow_runs")
    .select("id, status, dedupe_key, created_at")
    .eq("business_id", r.business_id)
    .like("dedupe_key", `ce:fu-pending:${r.id}:%`)
    .limit(10);
  if (evErr) {
    console.log(`      cadence: LOOKUP FAILED (${evErr.message})`);
    continue;
  }
  if ((events ?? []).length === 0) {
    console.log(
      "      cadence run from this apply: none enqueued " +
        "(tag was already present, or it was a staff refusal, or the enqueue failed)"
    );
    continue;
  }
  for (const ev of events ?? []) {
    const contactId = String(ev.dedupe_key).split(":").pop() ?? "";
    console.log(`      cadence run ${ev.id.slice(0, 8)} status=${ev.status}  for contact ${contactId}`);
    const { data: c } = await db
      .from("contacts")
      .select("display_name, customer_e164, tags")
      .eq("id", contactId)
      .maybeSingle();
    console.log(
      c
        ? `        contact: ${(c as { display_name?: string }).display_name ?? "?"} ` +
            `${(c as { customer_e164?: string }).customer_e164 ?? ""}  ` +
            `tags=${JSON.stringify((c as { tags?: string[] }).tags ?? [])}`
        : "        contact row not found"
    );
  }
}

// The one verdict kept: a literal match on an error column, which cannot mean
// anything else. This guard killed Amy's run whenever she claimed her own
// lead, and a recurrence means the teammate exemption is not applying.
console.log(`\n2. Runs killed by the self-send guard since ${since}: ${selfSend.length}`);
if (selfSend.length > 0) {
  console.log("   REGRESSION: the teammate exemption is not applying.");
  for (const r of selfSend) {
    console.log(`     run ${r.id}  business ${r.business_id.slice(0, 8)}  ${r.last_error?.slice(0, 120)}`);
  }
} else {
  console.log("   None. The post-claim hand-off is not dying on an owner-claimed lead.");
}
