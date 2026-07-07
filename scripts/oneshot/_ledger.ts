/**
 * Shared ledger for one-shot scripts: every successful --apply records a row
 * in public.applied_oneshots (migration 20260802000100), so "has this script
 * run, where, and when?" is a query instead of a by-hand re-audit of the data.
 *
 * Append-only: a re-run inserts another row — the application history is
 * itself useful, and one-shots are idempotent so duplicates are harmless.
 *
 * Recording failures are logged but never fail the script: the ledger is an
 * audit aid, and a missing row must not make an already-applied change look
 * like it needs re-running-with-rollback.
 */
import { basename } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function recordOneshotApplied(
  db: SupabaseClient,
  args: {
    /** Usually `process.argv[1]` — normalized to the script basename. */
    scriptPath: string;
    /** Business the apply targeted; null for global scripts. */
    businessId: string | null;
    /** Free-form summary of what changed (e.g. patched flow ids/names). */
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await db.from("applied_oneshots").insert({
    script: basename(args.scriptPath),
    business_id: args.businessId,
    details: args.details ?? null
  });
  if (error) {
    console.error(`applied_oneshots ledger insert failed (non-fatal): ${error.message}`);
  }
}
