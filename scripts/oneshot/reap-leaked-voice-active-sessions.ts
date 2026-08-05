#!/usr/bin/env tsx
/**
 * One-shot: delete the voice_active_sessions rows that leaked before the
 * reaper existed.
 *
 * Why: `voice_active_sessions` is meant to be ephemeral (one row per open
 * media stream), but until migration 20260822071559 nothing ever deleted a row
 * whose call finished NORMALLY. The bridge stamps `ended_at` on WebSocket
 * close and walks away, and the only DELETE in the schema lived inside
 * `voice_sweep_zombie_active_sessions`, gated on `ended_at is null`, which
 * only ever covered the crashed-bridge path. So every completed call left a
 * permanent row.
 *
 * On 2026-08-04 production held 62 such rows, the oldest from 2026-05-05:
 * 55 for Amy Laidlaw Real Estate (621a5b0d), 4 for 8f3a5c21, 3 for 690f85c0.
 * All 62 had `ended_at` set and a FINALIZED settlement, so none of them were
 * live calls and none were still needed for billing.
 *
 * The migration's `voice_reap_ended_active_sessions()` will clear these on its
 * own within one 5-minute maintenance tick. This script exists so the cleanup
 * is deliberate, auditable, and recorded in `applied_oneshots` rather than
 * happening silently: it shows exactly which rows went, proves each one was
 * ended and settled first, and gives us a record of the backlog's size for the
 * next time someone asks why this table was ever big.
 *
 * Safety: refuses to delete any row that is not ended, and any row whose
 * settlement is missing or unfinalized. Those are reported and left in place.
 * Dry-run by default. Idempotent: a second run finds nothing and exits 0.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/reap-leaked-voice-active-sessions.ts          # dry run
 *   npx tsx scripts/oneshot/reap-leaked-voice-active-sessions.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const APPLY = process.argv.includes("--apply");

/**
 * Only rows that ended at least this long ago are eligible, matching the
 * server-side reaper's grace period. A call that ended two minutes ago may
 * still have a settlement in flight that needs this row's `media_started_at`
 * to derive the billing start.
 */
const MIN_AGE_MS = 60 * 60 * 1000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Source .env first.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

type SessionRow = {
  call_control_id: string;
  business_id: string;
  media_started_at: string | null;
  last_seen_at: string | null;
  ended_at: string | null;
};

const { data: sessions, error: sessErr } = await db
  .from("voice_active_sessions")
  .select("call_control_id, business_id, media_started_at, last_seen_at, ended_at")
  .order("media_started_at", { ascending: true });
if (sessErr) throw new Error(`read voice_active_sessions: ${sessErr.message}`);

const rows = (sessions ?? []) as SessionRow[];
console.log(`voice_active_sessions: ${rows.length} row(s) total`);
if (rows.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Settlement state for every row we might delete, so we never remove a session
// a pending settlement still reads media_started_at from.
const { data: settlements, error: setlErr } = await db
  .from("voice_settlements")
  .select("call_control_id, finalized_at")
  .in(
    "call_control_id",
    rows.map((r) => r.call_control_id)
  );
if (setlErr) throw new Error(`read voice_settlements: ${setlErr.message}`);
const finalizedAt = new Map<string, string | null>(
  (settlements ?? []).map((s) => [s.call_control_id as string, s.finalized_at as string | null])
);

const now = Date.now();
const eligible: SessionRow[] = [];
const held: Array<{ row: SessionRow; why: string }> = [];

for (const row of rows) {
  if (!row.ended_at) {
    held.push({ row, why: "not ended (possible live call, or a zombie for the sweep)" });
    continue;
  }
  if (now - new Date(row.ended_at).getTime() < MIN_AGE_MS) {
    held.push({ row, why: "ended less than an hour ago; settlement may still be in flight" });
    continue;
  }
  if (!finalizedAt.has(row.call_control_id)) {
    held.push({ row, why: "no voice_settlements row" });
    continue;
  }
  if (finalizedAt.get(row.call_control_id) === null) {
    held.push({ row, why: "settlement not finalized" });
    continue;
  }
  eligible.push(row);
}

const byBusiness = new Map<string, number>();
for (const row of eligible) {
  byBusiness.set(row.business_id, (byBusiness.get(row.business_id) ?? 0) + 1);
}

console.log(`\nEligible (ended, settled, older than an hour): ${eligible.length}`);
for (const [businessId, n] of [...byBusiness.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${businessId}  ${n}`);
}
if (eligible.length > 0) {
  console.log(
    `  oldest: ${eligible[0].media_started_at}   newest: ${eligible[eligible.length - 1].media_started_at}`
  );
}

if (held.length > 0) {
  console.log(`\nHeld back: ${held.length}`);
  for (const { row, why } of held) {
    console.log(`  ${row.call_control_id}  (${row.business_id})  ${why}`);
  }
}

if (eligible.length === 0) {
  console.log("\nNothing eligible to delete.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDRY RUN. Re-run with --apply to delete the eligible rows.");
  process.exit(0);
}

// Delete in chunks: a single .in() with hundreds of ids makes an unwieldy URL,
// and a partial failure should leave a clear "we got this far" line.
const CHUNK = 50;
let deleted = 0;
for (let i = 0; i < eligible.length; i += CHUNK) {
  const ids = eligible.slice(i, i + CHUNK).map((r) => r.call_control_id);
  const { error } = await db.from("voice_active_sessions").delete().in("call_control_id", ids);
  if (error) {
    console.error(`\nDelete failed after ${deleted} row(s): ${error.message}`);
    process.exit(1);
  }
  deleted += ids.length;
  console.log(`  deleted ${deleted}/${eligible.length}`);
}

await recordOneshotApplied(db, {
  // Fleet-wide cleanup across several tenants, so no single business_id.
  scriptPath: process.argv[1],
  businessId: null,
  details: {
    deleted,
    held: held.length,
    by_business: Object.fromEntries(byBusiness),
    oldest_media_started_at: eligible[0].media_started_at,
    newest_media_started_at: eligible[eligible.length - 1].media_started_at
  }
});

console.log(`\nDone. Deleted ${deleted} leaked row(s); ${held.length} held back.`);
