/**
 * THE claim-timestamp convention, dashboard side.
 *
 * A lead claim can land four ways: a teammate's "1" consumed by the SMS
 * webhook and finalized by the worker, the worker's auto-assign and
 * owner-assign hard assignments, a "1" against an unowned-lead ALERT
 * (unowned_lead_alerts row, which carries its own claimed_at column), and,
 * soon, a Claim button on the dashboard. The first three stamp WHEN the
 * claim happened at the moment they stamp WHO: the worker writes
 * `context.routing.claimed_at_ms` (epoch ms, defined in
 * supabase/functions/_shared/ai_flows/routing.ts) next to `claimed_by`, and
 * the alert path writes its row's `claimed_at`. Employee-performance
 * analytics read run rows, so the run-side stamp lives in the routing
 * context JSON precisely where those reads already happen, no schema churn.
 *
 * This module is the dashboard's writer for that convention:
 * `stampLeadClaimOnRun` finds the lead's newest routed run and stamps
 * claimed_by / claimed_name / claimed_at_ms there, so a dashboard claim
 * shows up in the same analytics as a texted "1".
 *
 * Scope, stated plainly: this is BOOKKEEPING ONLY. It does not assign
 * contact ownership, does not resume or finalize the run, and sends nobody
 * a notification; the caller (the claim API route) owns those. It also
 * never throws: losing the analytics stamp must not fail a claim that
 * already changed ownership, so every failure path degrades to
 * `{ stamped: false }` with a console.error.
 *
 * Naming trap, worth one line: `ai_flow_runs.claimed_at` (the COLUMN) is the
 * worker's queue lease and has nothing to do with lead claims. The lead
 * claim's timestamp is `context.routing.claimed_at_ms`.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isLeadE164, taskLeadPhone } from "@/lib/ai-flows/tasks";
import {
  parseRouting,
  routingOfContext,
  type OfferRouting
} from "../../../supabase/functions/_shared/ai_flows/routing";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Newest candidate runs scanned for the lead (PostgREST cap respected). */
export const CLAIM_STAMP_RUN_SCAN_LIMIT = 20;

/**
 * Pure: the routing object with the claim recorded, a shallow copy (the
 * source is never mutated, matching the webhook's parse-mutate-persist
 * pattern). Also the single place the field set "a claim" means is written
 * down for src/lib callers: who, their roster name when known, and when.
 */
export function stampRoutingClaim(
  routing: OfferRouting,
  claim: { claimedByE164: string; claimedByName?: string | null; atMs: number }
): OfferRouting {
  const next: OfferRouting = { ...routing };
  next.claimed_by = claim.claimedByE164;
  if (claim.claimedByName?.trim()) next.claimed_name = claim.claimedByName.trim();
  next.claimed_at_ms = claim.atMs;
  return next;
}

export type LeadClaimStampResult = {
  /** True when the run row now carries this claim (including "already did"). */
  stamped: boolean;
  /** The run the stamp targeted, null when no routed run matched the lead. */
  runId: string | null;
};

type CandidateRow = {
  id: string;
  context: Record<string, unknown> | null;
  revision: number;
};

/**
 * Stamp a dashboard-made claim onto the lead's routed run, so analytics see
 * it exactly like a texted "1".
 *
 * The NEWEST run whose lead is `leadE164` and whose context carries a
 * routing object decides the outcome:
 *   - unclaimed: stamp claimed_by / claimed_name / claimed_at_ms
 *     (revision-CAS write, first writer wins; a lost race is reported, not
 *     retried, because the winner already recorded a truthful claim),
 *   - already claimed by THIS teammate: report stamped without moving the
 *     clock (an existing claimed_at_ms is somebody's real claim moment); a
 *     legacy self-claim missing the stamp gets one, dated now,
 *   - already claimed by somebody else: report un-stamped, the caller's
 *     ownership gate is what refuses the claim itself.
 *
 * No routed run at all is normal (the lead may never have been routed) and
 * reports `{ stamped: false, runId: null }`.
 */
export async function stampLeadClaimOnRun(
  db: SupabaseClient | undefined,
  args: {
    businessId: string;
    leadE164: string;
    claimedByE164: string;
    claimedByName?: string | null;
    nowMs?: number;
  }
): Promise<LeadClaimStampResult> {
  const lead = args.leadE164.trim();
  const claimer = args.claimedByE164.trim();
  if (!isLeadE164(lead) || !isLeadE164(claimer)) {
    return { stamped: false, runId: null };
  }
  try {
    const client = db ?? (await createSupabaseServiceClient());
    // E.164 values are strictly `+digits` (validated above), so they are safe
    // inside the PostgREST or() filter string, same reasoning as the tasks
    // route's contact lookup. The two JSON paths are the two places
    // taskLeadPhone reads.
    const { data, error } = await client
      .from("ai_flow_runs")
      .select("id, context, revision")
      .eq("business_id", args.businessId)
      .not("context->routing", "is", null)
      .or(`context->vars->>lead_phone.eq.${lead},context->trigger->>from.eq.${lead}`)
      .order("updated_at", { ascending: false })
      .limit(CLAIM_STAMP_RUN_SCAN_LIMIT);
    if (error) {
      console.error("stampLeadClaimOnRun read", error);
      return { stamped: false, runId: null };
    }
    // The or() above matches trigger.from even when an extracted lead_phone
    // names somebody ELSE (ownership never binds to the sender), so re-derive
    // the lead the way every reader does and keep only true matches.
    const candidate = ((data ?? []) as CandidateRow[]).find(
      (row) =>
        row.context !== null &&
        taskLeadPhone(row.context) === lead &&
        routingOfContext(row.context) !== null
    );
    if (!candidate) return { stamped: false, runId: null };
    // Non-null by the find predicate above.
    const context = candidate.context as Record<string, unknown>;

    const routing = parseRouting(context.routing);
    if (routing.claimed_by && routing.claimed_by !== claimer) {
      return { stamped: false, runId: candidate.id };
    }
    if (routing.claimed_by === claimer && typeof routing.claimed_at_ms === "number") {
      return { stamped: true, runId: candidate.id };
    }

    const nextContext = {
      ...context,
      routing: stampRoutingClaim(routing, {
        claimedByE164: claimer,
        claimedByName: args.claimedByName,
        atMs: args.nowMs ?? Date.now()
      })
    };
    // Revision-CAS, the runs table's concurrency gate (trigger-bumped on
    // every update): if the webhook or worker wrote between our read and
    // this write, zero rows match and their claim stands.
    const { data: written, error: writeError } = await client
      .from("ai_flow_runs")
      .update({ context: nextContext, updated_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("business_id", args.businessId)
      .eq("revision", candidate.revision)
      .select("id");
    if (writeError) {
      console.error("stampLeadClaimOnRun write", writeError);
      return { stamped: false, runId: candidate.id };
    }
    return { stamped: (written ?? []).length > 0, runId: candidate.id };
  } catch (e) {
    console.error("stampLeadClaimOnRun threw", e);
    return { stamped: false, runId: null };
  }
}
