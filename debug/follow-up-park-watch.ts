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
  //
  //    Every one of these three is looked up by an EXACT identifier, because
  //    the first draft used heuristics for all three and Bugbot found all
  //    three broken in the direction that reports success: a first-name ilike
  //    that could credit a different contact, a cadence filter on a `context`
  //    column the query never selected (so always zero), and a `created_at >=
  //    updated_at` floor that excludes the very writes it is looking for,
  //    because later persists bump updated_at after the apply. A verification
  //    that cannot fail is worse than no verification (PR #1710).

  //    The contact by its KEY, not by its name. The applied run knows the
  //    lead's number by definition: the apply only happens once
  //    upsert_customer has filed them.
  const leadPhone = typeof v.lead_phone === "string" ? v.lead_phone.trim() : "";
  if (!leadPhone || leadPhone.toLowerCase() === "none") {
    console.log("     lead_phone missing on an APPLIED run  <-- cannot verify, investigate by hand");
    continue;
  }
  const { data: contactRows, error: contactErr } = await db
    .from("contacts")
    .select("id, display_name, customer_e164, tags")
    .eq("business_id", r.business_id)
    .or(`customer_e164.eq.${leadPhone},alias_e164s.cs.{${leadPhone}}`)
    .limit(2);
  if (contactErr) {
    console.log(`     contact lookup FAILED: ${contactErr.message}  <-- cannot verify`);
    continue;
  }
  const contact = (contactRows ?? [])[0] as
    | { id: string; display_name?: string | null; tags?: string[] | null }
    | undefined;
  if (!contact) {
    console.log(`     no contact on file for ${leadPhone}  <-- PROMISE BROKEN (nothing was filed)`);
    continue;
  }
  const tagged = (contact.tags ?? []).some((t) => t.trim().toLowerCase() === FOLLOW_UP_TAG);
  console.log(
    `     contact ${contact.id} (${contact.display_name ?? "?"}) tagged "Needs Follow Up": ` +
      (tagged ? "YES" : "NO  <-- PROMISE BROKEN")
  );

  //    The cadence run by its DEDUPE KEY. applyPendingFollowUp builds it as
  //    `ce:fu-pending:<runId>:<contactId>` and enqueueContactEventRuns stores
  //    it verbatim on the new run, so this is an exact identity rather than a
  //    time-and-phone guess.
  const dedupeKey = `ce:fu-pending:${r.id}:${contact.id}`;
  const { data: cadence, error: cadenceErr } = await db
    .from("ai_flow_runs")
    .select("id, status, created_at")
    .eq("business_id", r.business_id)
    .eq("dedupe_key", dedupeKey)
    .limit(5);
  if (cadenceErr) {
    console.log(`     cadence lookup FAILED: ${cadenceErr.message}`);
  } else if ((cadence ?? []).length > 0) {
    const started = cadence ?? [];
    console.log(
      "     cadence run started by this apply: YES " +
        `(${started.map((c: { id: string; status: string }) => `${c.id.slice(0, 8)}/${c.status}`).join(", ")})`
    );
  } else {
    // A missing dedupe key is NOT proof the cadence failed.
    // applyPendingFollowUp enqueues that event only when the tag is NEWLY
    // added; a re-referred lead whose contact already carried "Needs Follow
    // Up" still gets the applied marker and the confirmation, and is already
    // enrolled from the earlier tagging. Calling that a miss would raise a
    // false alarm on a working case, so ask the real question instead: is
    // anything following this lead up?
    //
    // Restricted to flows that actually TRIGGER on this tag. Matching any run
    // whose trigger.from is the lead's number was wrong in the direction that
    // reports success: that key is also the sender on SMS runs and the contact
    // key on contact_created events, and the parked path's own
    // upsert_customer files the contact in the same step that applies the tag,
    // so a sibling contact_created run would have hidden a real cadence miss
    // every time (Bugbot, PR #1710).
    //    Mirrors enqueueContactEventRuns' own matching rather than inventing a
    //    second rule: it unions `definition.trigger` with every entry in
    //    `definition.triggers[]`, and only considers flows that are ENABLED
    //    and not soft-deleted. Filtering on `definition->trigger` alone missed
    //    a cadence whose Needs Follow Up trigger sits in the array instead,
    //    and 5 production flows use that shape today, one of them with a
    //    tag_changed trigger (Bugbot, PR #1710). Ignoring enabled/deleted_at
    //    would be the other direction of the same error: a disabled flow
    //    covers nobody, and counting it would report a lead as followed up
    //    when nothing is running.
    const { data: fuFlows, error: flowErr } = await db
      .from("ai_flows")
      .select("id, definition")
      .eq("business_id", r.business_id)
      .eq("enabled", true)
      .is("deleted_at", null)
      .limit(500);
    type TriggerLike = { channel?: string; tag?: string } | null | undefined;
    const watchesFollowUpTag = (def: {
      trigger?: TriggerLike;
      triggers?: TriggerLike[];
    } | null): boolean =>
      [def?.trigger, ...(def?.triggers ?? [])].some(
        (t) =>
          (t?.channel ?? "") === "tag_changed" &&
          (t?.tag ?? "").trim().toLowerCase() === FOLLOW_UP_TAG
      );
    const flowIds = ((fuFlows ?? []) as Array<{ id: string; definition: null }>)
      .filter((f) => watchesFollowUpTag(f.definition))
      .map((f) => f.id);
    if (flowErr) {
      console.log(`     cadence flow lookup FAILED: ${flowErr.message}`);
    } else if (flowIds.length === 0) {
      console.log(
        '     cadence: this tenant has NO flow triggered by "Needs Follow Up", so the ' +
          "tag starts nothing  <-- the request cannot be honored here"
      );
    } else {
      const { data: anyCadence, error: anyErr } = await db
        .from("ai_flow_runs")
        .select("id, status, created_at")
        .eq("business_id", r.business_id)
        .in("flow_id", flowIds)
        .eq("context->trigger->>from", leadPhone)
        .limit(10);
      if (anyErr) {
        console.log(`     cadence lookup FAILED: ${anyErr.message}`);
      } else if ((anyCadence ?? []).length > 0) {
        console.log(
          `     cadence run started by this apply: no, but ${(anyCadence ?? []).length} ` +
            "follow-up run(s) already cover this lead (tagged before the apply). OK."
        );
      } else {
        console.log("     cadence: NONE  <-- tag landed but no follow-up flow picked it up");
      }
    }
  }

  //    The confirmation text sent by THIS run. sms_outbound_log carries
  //    run_id (logOutboundSms stamps it), so the ack is identified exactly.
  //    Keying on to_e164 plus a time floor could credit a different apply's
  //    ack to this one, and an unordered limit over that wider window could
  //    drop the real row entirely (Bugbot, PR #1710).
  const { data: acks, error: ackErr } = await db
    .from("sms_outbound_log")
    .select("created_at, body")
    .eq("business_id", r.business_id)
    .eq("run_id", r.id)
    .eq("to_e164", v[PARKED_BY])
    .order("created_at", { ascending: false })
    .limit(50);
  if (ackErr) {
    console.log(`     confirmation lookup FAILED: ${ackErr.message}`);
    continue;
  }
  const confirmation = (acks ?? []).find((a: { body?: string }) =>
    /marked for follow-up|NOT calling them yet|did not mark/i.test(a.body ?? "")
  );
  console.log(
    "     asker got a text back: " +
      (confirmation
        ? `YES ("${(confirmation as { body: string }).body.slice(0, 60)}...")`
        : "NO  <-- silent, which the fixes were supposed to make impossible")
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
