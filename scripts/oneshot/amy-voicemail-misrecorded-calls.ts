#!/usr/bin/env tsx
/**
 * One-shot: correct three AI calls that only ever reached a voicemail but were
 * recorded as conversations, and tell the team so the leads are not lost.
 *
 * WHY. An outbound AI call resolves its flow outcome from whether a machine
 * was detected. When nothing detects the machine, the run records
 * `call_outcome: "answered"` ("spoke with them"), which is not merely cosmetic:
 * in the Needs Follow Up cadence the follow-up text is gated on
 * `call_outcome equals no_answer`, so a lead who was never spoken to gets no
 * text AND no further calls, and the run parks for three days waiting on a
 * reply that cannot come. Three calls landed that way:
 *
 *   1. 2026-08-14  +1 480-457-9659   premium AMD returned `human_business`
 *   2. 2026-08-17  Jennifer Kline    AMD was RIGHT (`machine`); the greeting
 *                  +1 602-571-1370   then ended without a beep, which the
 *                                    handler misread as Apple call screening
 *                                    and used to cancel the correct verdict
 *                                    (fixed alongside this, see PR #1427)
 *   3. 2026-08-17  Jim Inderberg     premium AMD returned `human_residence`
 *                  +1 602-725-4935   (a personal greeting is one human voice,
 *                                    which is what that class sounds like)
 *
 * Causes 1 and 3 are carrier AMD being wrong, which no code change makes go
 * away; the forward fix gives the assistant its own way to report a recording.
 * This script is only about the calls that already happened.
 *
 * WHAT IT DOES. Two things, and deliberately not a third:
 *
 *   - Stamps `answering_machine_result = 'machine'` on each call record, so
 *     the call page stops showing a voicemail as a human conversation. Written
 *     as a compare-and-swap against NULL, so a value written since (by the
 *     forward fix, or by anything else) is never clobbered.
 *   - Texts the owner ONE message naming the three leads, so a person can call
 *     them back. It does not text the leads themselves: these calls are days
 *     old, the runs have moved on, and an automated "sorry we missed you" to a
 *     seller who may since have been contacted by a teammate is worse than a
 *     human deciding.
 *
 *   NOT DONE: resuming or rewriting the flow runs. Two are `done` and the
 *   third is parked mid-cadence; rewriting a live run's vars to re-drive a
 *   completed step is how flows get broken here, and it risks double-texting
 *   the very leads this is trying to rescue. The owner alert reaches a human
 *   faster and cannot misfire.
 *
 * Idempotent: the stamp is a no-op once set, and the alert carries a dedupe
 * key so a re-run cannot text the owner twice. Dry-run by default, and the
 * dry run prints the exact SMS body.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-voicemail-misrecorded-calls.ts            # dry run
 *   npx tsx scripts/oneshot/amy-voicemail-misrecorded-calls.ts --apply
 *   npx tsx scripts/oneshot/amy-voicemail-misrecorded-calls.ts --apply --no-sms
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL),
 * SUPABASE_SERVICE_ROLE_KEY, and TELNYX_API_KEY for the owner text.
 *
 * Exit codes: 0 applied/no-op/dry-run · 1 Supabase or send error · 2 bad env,
 * or a call row that no longer looks like the incident.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const SCRIPT = "amy-voicemail-misrecorded-calls.ts";
const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Where the owner alert goes: Amy's mobile, the same number the flows notify. */
const OWNER_E164 = "+16026951142";

/**
 * The affected calls, by transcript id. Named rather than discovered: the
 * population is closed and known, and a heuristic sweep over "summaries that
 * mention voicemail" would be a much blunter instrument to point at a write.
 * Each entry carries what the row must still look like, so a row that has
 * since been corrected (or is not the one meant) aborts instead of being
 * rewritten.
 */
export const AFFECTED_CALLS: ReadonlyArray<{
  transcriptId: string;
  who: string;
  e164: string;
  when: string;
  cause: string;
}> = [
  {
    transcriptId: "51092cc9-a983-497f-8465-f95157611f9e",
    who: "Mesa seller",
    e164: "+14804579659",
    when: "Aug 14",
    cause: "AMD said human_business"
  },
  {
    transcriptId: "11c69ad8-b252-484a-81b9-e49b15728255",
    who: "Jennifer Kline",
    e164: "+16025711370",
    when: "Aug 17 9:08am",
    cause: "AMD said machine, the greeting-end handler cancelled it"
  },
  {
    transcriptId: "d2d814a9-5063-4e9a-84bc-225e837f55fc",
    who: "Jim Inderberg",
    e164: "+16027254935",
    when: "Aug 17 11:52am",
    cause: "AMD said human_residence"
  }
];

/** One text, not three: three separate alerts about days-old calls is noise. */
export function ownerAlertBody(
  calls: ReadonlyArray<{ who: string; e164: string; when: string }>
): string {
  const lines = calls.map((c) => `${c.who} ${c.e164} (${c.when})`);
  return [
    "Heads up: 3 AI calls reached voicemail but were recorded as answered, so no follow-up text went out and the cadence stopped early.",
    ...lines,
    "Worth a call back from someone. The call pages now show these as voicemail, and the detection gap is fixed going forward."
  ].join("\n");
}

type Args = { apply: boolean; sms: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, sms: true };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a === "--no-sms") args.sms = false;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const toStamp: string[] = [];
  for (const call of AFFECTED_CALLS) {
    const { data, error } = await db
      .from("voice_call_transcripts")
      .select("id, business_id, caller_e164, direction, answering_machine_result")
      .eq("id", call.transcriptId)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for ${call.transcriptId}: ${error.message}`);
      process.exit(1);
    }
    const row = data as
      | {
          business_id?: string;
          caller_e164?: string;
          direction?: string;
          answering_machine_result?: string | null;
        }
      | null;
    if (!row) {
      console.error(`Call ${call.transcriptId} (${call.who}) not found.`);
      process.exit(2);
    }
    // Refuse anything that is not the call this was written against: wrong
    // tenant, wrong person, or an inbound leg.
    if (row.business_id !== BUSINESS_ID || row.caller_e164 !== call.e164 || row.direction !== "outbound") {
      console.error(
        `Call ${call.transcriptId} does not match the incident (tenant/number/direction); refusing.`
      );
      process.exit(2);
    }
    if (row.answering_machine_result === null || row.answering_machine_result === undefined) {
      toStamp.push(call.transcriptId);
      console.log(`Stamp    : ${call.who} ${call.e164} ${call.when} (${call.cause})`);
    } else {
      console.log(
        `Already  : ${call.who} ${call.e164} reads "${row.answering_machine_result}", leaving it`
      );
    }
  }

  const body = ownerAlertBody(AFFECTED_CALLS);
  console.log(`\nOwner text to ${OWNER_E164}:\n${body}\n`);

  if (!args.apply) {
    console.log("[dry-run] Nothing written or sent. Re-run with --apply.");
    return;
  }

  for (const id of toStamp) {
    // Compare-and-swap on NULL so a value written since this script read is
    // never overwritten (PostgREST reports success for a zero-row update, so
    // the guard has to be in the filter, not in a prior read).
    const { error } = await db
      .from("voice_call_transcripts")
      .update({ answering_machine_result: "machine" })
      .eq("id", id)
      .is("answering_machine_result", null);
    if (error) {
      console.error(`Stamp failed for ${id}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`Stamped ${toStamp.length} call record(s) as voicemail.`);

  let texted = false;
  if (args.sms) {
    const apiKey = process.env.TELNYX_API_KEY ?? "";
    if (!apiKey) {
      console.error("TELNYX_API_KEY missing; skipped the owner text (records were still stamped).");
    } else {
      const { data: settings } = await db
        .from("business_telnyx_settings")
        .select("telnyx_sms_from_e164")
        .eq("business_id", BUSINESS_ID)
        .maybeSingle();
      const from = (settings as { telnyx_sms_from_e164?: string } | null)?.telnyx_sms_from_e164 ?? "";
      if (!from) {
        console.error("No tenant SMS number configured; skipped the owner text.");
      } else {
        const res = await fetch("https://api.telnyx.com/v2/messages", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(from.startsWith("+")
            ? { from, to: OWNER_E164, text: body }
            : { messaging_profile_id: from, to: OWNER_E164, text: body })
        });
        if (!res.ok) {
          console.error(`Owner text failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
          process.exit(1);
        }
        texted = true;
        console.log(`Texted the owner at ${OWNER_E164}.`);
      }
    }
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId: BUSINESS_ID,
    details: { stamped: toStamp, texted, calls: AFFECTED_CALLS.map((c) => c.transcriptId) }
  });
  console.log("\nApplied.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
