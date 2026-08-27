/**
 * Did the AI speak a phone number it was never given?
 *
 * Amy Laidlaw, 2026-08-25: "whose phone number is this?" Her coworker had
 * told a lead to call 480-256-2580, a number belonging to nobody on the
 * account. Over the 45 days before the fix it invented THIRTEEN distinct
 * numbers, one per voicemail. The scripts were always right; the model
 * ad-libbed at the beep before fetching them, and the instruction asked for
 * "how to reach you" without supplying a number. Fixed in PR #1612.
 *
 * The fix is a PROMPT change on a realtime audio model, which no test tier in
 * this repo can drive, so this script is the verification: it reads what the
 * assistant actually said on real calls and lists every contact number that
 * is not one the business owns.
 *
 * The verification proved the prompt fix insufficient (2 of the first 8
 * machine calls after the redeploy fabricated anyway, 2026-08-26/27), so the
 * same detection now also runs DAILY in the `call-integrity-sweep` Edge cron
 * via the shared rules in `_shared/call_integrity.ts`. This script remains
 * the wider-window, per-occurrence view.
 *
 * Read-only. Usage:
 *   npx tsx debug/voicemail-number-audit.ts --business <uuid> [--since ISO]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const businessId = arg("business");
if (!businessId) {
  console.error("usage: npx tsx debug/voicemail-number-audit.ts --business <uuid> [--since ISO]");
  process.exit(1);
}
const since = arg("since") ?? new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();

const { createClient } = await import("@supabase/supabase-js");
const { collectAllowedNumbers, extractSpokenNumbers, spokenNumberForm } = await import(
  "../supabase/functions/_shared/call_integrity.ts"
);
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

/**
 * Numbers the business may legitimately speak, in spoken 3-3-4 form.
 *
 * Completeness matters more here than anywhere else in the script: a number
 * missing from this set is reported as INVENTED, and a verification tool that
 * cries wolf is worse than no tool, because it would say the fix failed when
 * it worked. Bugbot caught four separate holes across the first drafts, the
 * worst being the coworker's own DID: the AI line is exactly what Amy
 * expected to hear in that voicemail, and it lived in a table this never
 * read.
 *
 * The MATCHING rules live in `_shared/call_integrity.ts` and are shared with
 * the daily call-integrity sweep, which runs this same detection on
 * yesterday's calls; this script only does the IO. Which tables feed the set,
 * and why each one: `businesses` phone-ish columns; `notification_preferences`
 * (the owner's alert phone); `business_telnyx_settings` (the coworker's OWN
 * line and the cell it forwards to); `telnyx_voice_routes.to_e164` (the line
 * inbound calls actually arrive on, distinct from the SMS-from number in
 * general even though the two match on Amy's account); `ai_flow_team_members`
 * (numbers a routing script may legitimately read out); and everything an
 * authored flow script says.
 */
async function ownNumbers(): Promise<Set<string>> {
  const { data: biz } = await db.from("businesses").select("*").eq("id", businessId).maybeSingle();
  const { data: prefs } = await db
    .from("notification_preferences")
    .select("phone_number")
    .eq("business_id", businessId)
    .maybeSingle();
  const { data: telnyx } = await db
    .from("business_telnyx_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  const { data: routes } = await db
    .from("telnyx_voice_routes")
    .select("to_e164")
    .eq("business_id", businessId);
  const { data: roster } = await db
    .from("ai_flow_team_members")
    .select("*")
    .eq("business_id", businessId);
  const { data: flows } = await db.from("ai_flows").select("definition").eq("business_id", businessId);

  return collectAllowedNumbers({
    phoneKeyedRows: [
      biz as Record<string, unknown> | null,
      telnyx as Record<string, unknown> | null,
      ...((roster ?? []) as Record<string, unknown>[])
    ],
    values: [
      (prefs as { phone_number?: string } | null)?.phone_number,
      ...(routes ?? []).map((r) => (r as { to_e164?: string }).to_e164)
    ],
    flowDefinitions: (flows ?? []).map((f) => (f as { definition: unknown }).definition)
  });
}

const own = await ownNumbers();
console.log(`business ${businessId}`);
console.log(`window since ${since}`);
console.log(`numbers this business may legitimately speak: ${[...own].sort().join(", ") || "(none found)"}`);
console.log("(each call additionally allows the number of the party on that call)");

const { data: trs, error } = await db
  .from("voice_call_transcripts")
  .select("id, created_at, direction, answering_machine_result, caller_e164, forwarded_to_e164")
  .eq("business_id", businessId)
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(1000);
if (error) throw error;

let calls = 0;
const bad: Array<{ at: string; n: string; said: string }> = [];
for (const t of trs ?? []) {
  const row = t as {
    id: string;
    created_at: string;
    caller_e164: string | null;
    forwarded_to_e164: string | null;
  };
  // Reading the remote party's own number back to them is explicitly allowed
  // (PR #1612: the caller is one of the two permitted sources), so it is
  // allowed on THIS call only rather than added to the business-wide set.
  const allowed = new Set(own);
  for (const v of [row.caller_e164, row.forwarded_to_e164]) {
    const n = spokenNumberForm(v);
    if (n) allowed.add(n);
  }
  const { data: turns } = await db
    .from("voice_call_transcript_turns")
    .select("content")
    .eq("transcript_id", row.id)
    .eq("role", "assistant");
  if (!turns || turns.length === 0) continue;
  calls += 1;
  for (const x of turns) {
    const said = String((x as { content: string }).content ?? "");
    for (const n of extractSpokenNumbers(said)) {
      if (!allowed.has(n)) bad.push({ at: row.created_at, n, said: said.slice(0, 140) });
    }
  }
}

console.log(`\ncalls with assistant speech in window: ${calls}`);
if (bad.length === 0) {
  console.log("NO invented contact numbers spoken. Clean.");
} else {
  console.log(`INVENTED NUMBERS SPOKEN: ${bad.length} (${new Set(bad.map((b) => b.n)).size} distinct)`);
  for (const b of bad) console.log(`  ${b.at}  ${b.n}\n     "${b.said}"`);
}
