#!/usr/bin/env tsx
/**
 * One-shot: correct `lead_type` on PARKED "Needs Follow Up (AI cadence)" runs
 * that were filed as sellers because the flow could not know better.
 *
 * The companion to `amy-cadence-lead-type-from-note.ts`. That one fixes the
 * FUTURE: the tag now carries the type and the cadence reads it. It cannot fix
 * runs already in flight, whose variable bag was written when the tag said
 * nothing. Those runs sit in `wait_for_reply` for three days at a time, so a
 * wrong `lead_type` there is not historical, it decides where the lead goes
 * when they answer:
 *
 *   - `r*_route_buyer` vs `r*_route_seller` / `r*_route_both`, so a buyer who
 *     says "yes, call me" is offered to the seller trio rather than the buyer
 *     rotation, and Jason Lane (roster tag `buyer` only) never sees them.
 *   - `notify_lead_owner`'s `teamTagTemplate: "{{vars.lead_type}}"`, which
 *     picks the team an unowned-lead alert reaches.
 *
 * EVIDENCE ONLY. This never guesses a type. For each parked run it looks at
 * every OTHER run in the same business that mentions the same `lead_phone` and
 * established a `lead_type` of its own (ReferralExchange Lead, Realtor.com
 * Lead, New Lead Intake all extract one). It rewrites the parked run only when
 * those agree on exactly ONE value from buyer/seller/both AND that value
 * differs from what the run currently holds. No evidence, or evidence that
 * disagrees with itself, means the run is left alone and reported: a lead
 * routed to the wrong half of the roster is the failure being fixed, and
 * guessing would just relocate it.
 *
 * Clever leads are deliberately untouched by that rule rather than by a
 * special case. "Clever Lead - Accept" extracts no `lead_type` at all, so it
 * offers no evidence and every Clever run is skipped. That is the right
 * answer for them: Clever Offers is a seller program, its referral text says
 * "Seller" on its own line, and every field in that flow reads "the seller's
 * ...". Their "seller" is correct, not a default that happened to land.
 *
 * Scoped to `awaiting_reply` runs. A `queued` or `running` run is mid-flight
 * in the worker and may not have reached its extraction yet; a `done` or
 * `failed` run has nothing left to route.
 *
 * The write is a compare-and-swap on `revision` (migration
 * 20260802000000), the same optimistic-concurrency gate the inbound webhook's
 * claim paths use. A worker resuming the run between this script's read and
 * its write bumps that counter, and the update then matches zero rows and is
 * reported as a skip rather than silently overwriting whatever the worker just
 * decided. PostgREST reports a zero-row update as success, so the row count is
 * checked explicitly.
 *
 * Idempotent (a corrected run no longer differs from its evidence, so a re-run
 * reports nothing to do). Dry-run by default. Records to applied_oneshots on
 * --apply. Enqueues nothing, sends nothing, and never touches a definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-heal-parked-cadence-lead-type.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-heal-parked-cadence-lead-type.ts --business <uuid> --apply
 */
import { CADENCE_FLOW_NAME } from "./amy-cadence-lead-type-from-note";

/** The only answers a lead type may take; anything else is not evidence. */
export const LEAD_TYPES = ["buyer", "seller", "both"] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

/** A type another run established for this lead, and which flow said so. */
export type TypeEvidence = { flowName: string; leadType: string };

export type HealDecision =
  /** Evidence agrees on one value and the run disagrees with it. */
  | { outcome: "correct"; from: string; to: LeadType; sources: string[] }
  /** Evidence agrees and the run already matches. */
  | { outcome: "already_right"; leadType: string }
  /** Nothing established a type for this lead (e.g. every Clever flow). */
  | { outcome: "no_evidence" }
  /** Two flows established DIFFERENT types; refuse rather than pick. */
  | { outcome: "conflicting"; found: string[] };

/**
 * What to do with one parked run, given what every other run knows about the
 * same lead. Pure, so the rule is testable without a database and cannot
 * drift from what the script actually writes.
 */
export function decideHeal(current: unknown, evidence: readonly TypeEvidence[]): HealDecision {
  const usable = evidence.filter((e): e is TypeEvidence & { leadType: LeadType } =>
    (LEAD_TYPES as readonly string[]).includes(e.leadType)
  );
  const distinct = [...new Set(usable.map((e) => e.leadType))];
  if (distinct.length === 0) return { outcome: "no_evidence" };
  if (distinct.length > 1) return { outcome: "conflicting", found: distinct.sort() };
  const truth = distinct[0];
  const now = typeof current === "string" ? current : "";
  if (now === truth) return { outcome: "already_right", leadType: truth };
  return {
    outcome: "correct",
    from: now || "(unset)",
    to: truth,
    sources: [...new Set(usable.map((e) => e.flowName))].sort()
  };
}

/**
 * Does this run's variable bag concern `phone`?
 *
 * A whole-context substring scan rather than an equality test on one named
 * var, because the flows spell the lead's number differently (`lead_phone`,
 * `route_lead_phone`, `group_lead_phone`) and a lead can be filed by one flow
 * and re-read by another. The cost of being too eager is reading a type from a
 * run that merely mentioned the number, which `decideHeal` then has to see
 * agree with every other source before it changes anything.
 */
export function runMentionsPhone(context: unknown, phone: string): boolean {
  if (!phone) return false;
  return JSON.stringify(context ?? {}).includes(phone);
}

/* c8 ignore start -- the IO shell; the pure decision above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-heal-parked-cadence-lead-type.ts --business <uuid> [--apply]"
    );
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: flowRows, error: fErr } = await db
    .from("ai_flows")
    .select("id,name")
    .eq("business_id", BUSINESS_ID);
  if (fErr) {
    console.error(`flow read failed: ${fErr.message}`);
    process.exit(1);
  }
  const nameOf = new Map((flowRows ?? []).map((f) => [f.id as string, f.name as string]));
  const cadenceId = [...nameOf.entries()].find(([, n]) => n === CADENCE_FLOW_NAME)?.[0];
  if (!cadenceId) {
    console.error(`"${CADENCE_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  const { data: parked, error: pErr } = await db
    .from("ai_flow_runs")
    .select("id, status, revision, created_at, context")
    .eq("flow_id", cadenceId)
    .eq("status", "awaiting_reply")
    .order("created_at")
    .limit(1000);
  if (pErr) {
    console.error(`parked run read failed: ${pErr.message}`);
    process.exit(1);
  }

  // Every other run of this business that could have established a type.
  const { data: others, error: oErr } = await db
    .from("ai_flow_runs")
    .select("id, flow_id, created_at, context")
    .eq("business_id", BUSINESS_ID)
    .neq("flow_id", cadenceId)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (oErr) {
    console.error(`evidence read failed: ${oErr.message}`);
    process.exit(1);
  }

  type Target = { id: string; revision: number; name: string; to: LeadType; from: string; ctx: Record<string, unknown> };
  const targets: Target[] = [];
  let alreadyRight = 0;
  let noEvidence = 0;
  const conflicts: string[] = [];

  console.log(`Business ${BUSINESS_ID}: ${(parked ?? []).length} parked cadence run(s).\n`);
  for (const run of parked ?? []) {
    const ctx = (run.context ?? {}) as Record<string, unknown>;
    const vars = (ctx.vars ?? {}) as Record<string, unknown>;
    const phone = typeof vars.lead_phone === "string" ? vars.lead_phone : "";
    const label = `${String(vars.lead_name ?? "(no name)")} (${phone || "no phone"})`;
    const evidence: TypeEvidence[] = [];
    for (const o of others ?? []) {
      if (!runMentionsPhone(o.context, phone)) continue;
      const ov = ((o.context as Record<string, unknown>)?.vars ?? {}) as Record<string, unknown>;
      for (const k of ["lead_type", "route_lead_type"]) {
        const val = ov[k];
        if (typeof val === "string" && (LEAD_TYPES as readonly string[]).includes(val)) {
          evidence.push({ flowName: nameOf.get(o.flow_id as string) ?? String(o.flow_id), leadType: val });
        }
      }
    }
    const decision = decideHeal(vars.lead_type, evidence);
    if (decision.outcome === "correct") {
      console.log(`  CORRECT  ${label}: ${decision.from} -> ${decision.to}  (per ${decision.sources.join(", ")})`);
      targets.push({
        id: run.id as string,
        revision: run.revision as number,
        name: label,
        to: decision.to,
        from: decision.from,
        ctx
      });
    } else if (decision.outcome === "already_right") {
      alreadyRight++;
    } else if (decision.outcome === "no_evidence") {
      noEvidence++;
    } else {
      conflicts.push(`${label}: sources disagree (${decision.found.join(" vs ")})`);
    }
  }

  console.log(
    `\n  ${targets.length} to correct, ${alreadyRight} already right, ${noEvidence} with no evidence (Clever and the like), ${conflicts.length} conflicting.`
  );
  for (const c of conflicts) console.log(`  LEFT ALONE  ${c}`);

  if (targets.length === 0) {
    console.log("\nNothing to do.");
    process.exit(0);
  }
  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const healed: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const nextVars = { ...((t.ctx.vars ?? {}) as Record<string, unknown>), lead_type: t.to };
    const { data: updated, error } = await db
      .from("ai_flow_runs")
      .update({ context: { ...t.ctx, vars: nextVars } })
      .eq("id", t.id)
      // Optimistic concurrency: a worker that resumed this run since the read
      // has bumped revision, and this update then matches nothing.
      .eq("revision", t.revision)
      .eq("status", "awaiting_reply")
      .select("id");
    if (error) {
      console.error(`update ${t.name} failed: ${error.message}`);
      skipped.push(t.name);
      continue;
    }
    if ((updated ?? []).length !== 1) {
      console.error(`${t.name}: the run moved since it was read (revision changed), NOT written.`);
      skipped.push(t.name);
      continue;
    }
    healed.push(t.id);
    console.log(`Corrected ${t.name}: lead_type ${t.from} -> ${t.to}`);
  }
  if (healed.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "amy-heal-parked-cadence-lead-type.ts",
      businessId: BUSINESS_ID,
      details: { run_ids: healed }
    });
  }
  if (skipped.length > 0) {
    console.error(`\n${skipped.length} run(s) not written: ${skipped.join(", ")}. Re-run to retry.`);
    process.exit(1);
  }
  console.log("\nDone. These runs now route by the type their filing flow established.");
}

/* c8 ignore stop */
