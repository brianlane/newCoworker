/**
 * repair-clobbered-ai-transcripts.ts: restore the AI transcript rows that the
 * forwarded-call record overwrote.
 *
 * Background (found investigating Amy Laidlaw's call 5634b7f0, 2026-08-18).
 * `recordForwardedCall` was written for calls the routing layer sends straight
 * to a human, which never engage the voice bridge, so it hardcoded
 * `direction: 'inbound'`, `model: 'forwarded'` and a terminal `summarized_at`.
 * The warm-transfer path calls it for calls the AI DID handle, and its answered
 * upsert replaces the whole row. Every warm-transferred AI call therefore lost:
 *
 *   - its direction, so an OUTBOUND AI call read as INCOMING in the dashboard,
 *   - its model id, replaced by the sentinel,
 *   - its place in the summary queue: `summarized_at` was stamped, so the sweep
 *     skipped a call with real transcript turns and the owner never got a
 *     summary or a sentiment for it.
 *
 * The code no longer does this (the answered path patches the forwarded facts
 * onto an existing AI row instead of replacing it). This repairs the rows that
 * were already flattened.
 *
 * EVIDENCE, NOT GUESSWORK. Each field is restored only from an independent
 * record of the same call, and left alone when that record is gone:
 *
 *   direction ← voice_reservations.direction (written when the call was
 *               reserved, untouched by any of this)
 *   model     ← the `voice_bridge_gemini_session_start` telemetry event for the
 *               call. Telemetry ages out, so an older call may have none: the
 *               sentinel then stays, and the row is reported as partial.
 *   summarized_at → NULL, so the existing summary sweep picks the call up on
 *               its next run. Only when `summary IS NULL`, so a call that
 *               somehow did get summarized is never re-summarized (that costs
 *               model spend and rewrites what the owner already read).
 *
 * A row is touched only while it still looks like the artifact: `call_kind` is
 * 'forwarded' AND it has at least one transcript turn. A forwarded row with no
 * turns is a genuine straight-to-human call and is correct as it stands.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv, and the
 * script is idempotent and dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   # audit the whole fleet:
 *   npx tsx scripts/oneshot/repair-clobbered-ai-transcripts.ts
 *   # scope to one tenant:
 *   npx tsx scripts/oneshot/repair-clobbered-ai-transcripts.ts --business <uuid>
 *   # land it:
 *   npx tsx scripts/oneshot/repair-clobbered-ai-transcripts.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

type TranscriptRow = {
  id: string;
  business_id: string;
  call_control_id: string;
  direction: string;
  model: string;
  summary: string | null;
  summarized_at: string | null;
  created_at: string;
};

let query = db
  .from("voice_call_transcripts")
  .select("id, business_id, call_control_id, direction, model, summary, summarized_at, created_at")
  .eq("call_kind", "forwarded")
  // Bound explicitly: an un-limited PostgREST select silently truncates at
  // 1000 rows, which would read as "no more to repair".
  .limit(1000)
  .order("created_at", { ascending: true });
if (BUSINESS_ID) query = query.eq("business_id", BUSINESS_ID);

const { data: forwarded, error } = await query;
if (error) {
  console.error(`read voice_call_transcripts: ${error.message}`);
  process.exit(1);
}

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: ${(forwarded ?? []).length} forwarded transcript row(s)` +
    `${BUSINESS_ID ? ` for business ${BUSINESS_ID}` : " (whole fleet)"}\n`
);

let repaired = 0;
let partial = 0;
const touched: Record<string, unknown>[] = [];

for (const row of (forwarded ?? []) as TranscriptRow[]) {
  const { count } = await db
    .from("voice_call_transcript_turns")
    .select("id", { count: "exact", head: true })
    .eq("transcript_id", row.id);
  // No turns means no AI conversation: an ordinary forwarded call, already
  // correct.
  if (!count) continue;

  const patch: Record<string, unknown> = {};

  const { data: reservation } = await db
    .from("voice_reservations")
    .select("direction")
    .eq("call_control_id", row.call_control_id)
    .maybeSingle();
  const trueDirection = (reservation as { direction?: string } | null)?.direction;
  if (trueDirection && trueDirection !== row.direction) patch.direction = trueDirection;

  if (row.model === "forwarded") {
    const { data: telemetry } = await db
      .from("telemetry_events")
      .select("payload")
      .eq("event_type", "voice_bridge_gemini_session_start")
      .filter("payload->>call_control_id", "eq", row.call_control_id)
      .limit(1)
      .maybeSingle();
    const model = (telemetry as { payload?: { model?: string } } | null)?.payload?.model;
    if (model) patch.model = model;
  }

  // Put the call back in the summary sweep's queue. Guarded on summary being
  // null so an already-summarized call is never re-summarized.
  if (row.summary === null && row.summarized_at !== null) patch.summarized_at = null;

  if (Object.keys(patch).length === 0) continue;

  const stillMissingModel = row.model === "forwarded" && patch.model === undefined;
  if (stillMissingModel) partial++;

  console.log(
    `  ${row.id}  (${row.created_at.slice(0, 10)}, ${count} turns)  ${JSON.stringify(patch)}` +
      `${stillMissingModel ? "  [model unrecoverable: no telemetry left]" : ""}`
  );
  touched.push({ id: row.id, business_id: row.business_id, patch });

  if (APPLY) {
    const { data: updated, error: updateErr } = await db
      .from("voice_call_transcripts")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("id");
    if (updateErr) {
      console.error(`    update failed: ${updateErr.message}`);
      continue;
    }
    // A PostgREST update matching zero rows returns no error, so confirm the
    // write actually landed rather than trusting the absence of one.
    if ((updated ?? []).length === 0) {
      console.error(`    update matched no rows (row moved or deleted?)`);
      continue;
    }
    repaired++;
  }
}

console.log(
  `\n${APPLY ? `Repaired ${repaired} row(s)` : `Would repair ${touched.length} row(s)`}` +
    `${partial > 0 ? `, ${partial} with an unrecoverable model` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to land it.");
} else if (repaired > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "repair-clobbered-ai-transcripts.ts",
    businessId: BUSINESS_ID,
    details: { repaired, partial, rows: touched }
  });
}
