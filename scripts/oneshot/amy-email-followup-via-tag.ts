#!/usr/bin/env tsx
/**
 * One-shot: ONE email follow-up, in the cadence, reached by a tag.
 *
 * Brian, 2026-08-19: "Remove the unneeded one to avoid confusion and drift.
 * Email cadence should start if have a case like Valerie. It is only used as
 * a fallback if there is no phone number."
 *
 * THE DUPLICATION THIS REMOVES. The three-round email sequence existed in two
 * places: inline at the end of each lead-source flow (this script's target),
 * and inside "Needs Follow Up (AI cadence)" (PR #1479). Same copy, same
 * timing, same mailbox. That duplication is why tagging an email-only lead was
 * never switched on: a tagged lead would have walked both and received six
 * emails instead of three.
 *
 * WHAT REPLACES IT. The same two gates, ending in one `update_contact` that
 * tags the lead "Needs Follow Up". The cadence takes it from there, which is
 * how every other automated follow-up on this tenant already works.
 *
 *   no phone?  ->  has an email?  ->  tag "Needs Follow Up"
 *
 * The tag can land at all because a contact now exists for an email-only lead:
 * `update_contact` accepts an emailVar (PR #1473) and an email send files the
 * lead as a contact (PR #1486). Neither was true when the inline rounds were
 * written, which is why they were inline.
 *
 * COVERAGE IS UNCHANGED, and that is the point of tagging here rather than
 * reusing the flows' existing tag steps. Those are gated: the unclaimed
 * ladders fire only while `claimed_agent` is "none", and the call-outcome tags
 * only after a call that never happens for a phoneless lead. Jack Briggs
 * (claimed by Gabrielle, mid-cadence when this was written) would have been
 * tagged by none of them. This block is gated on the lead's REACHABILITY and
 * nothing else, so every email-only lead is handed over exactly as the inline
 * rounds handled them.
 *
 * INDEX SAFETY. `ai_flow_runs.current_step` indexes the FLATTENED definition,
 * so removing 20 steps from the tail strands any run parked at or after the
 * block. This script REFUSES to apply while such a run exists (--force
 * overrides, after you have migrated it by hand: give the lead a contact and
 * the tag, which puts them in the cadence where the rounds now live). Runs
 * before the block are unaffected: the block is last in every target flow, so
 * nothing before it renumbers.
 *
 * The check runs over EVERY target before anything is written, in a separate
 * pass. Checking and writing in one loop would update the first flows, hit a
 * stranded run on the fourth, and exit with half the fleet on the new shape,
 * half on the old, and no ledger row recording it.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-email-followup-via-tag.ts            # dry run
 *   npx tsx scripts/oneshot/amy-email-followup-via-tag.ts --apply
 *   npx tsx scripts/oneshot/amy-email-followup-via-tag.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error or a stranded run.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../../debug/_shared";
import { recordOneshotApplied } from "./_ledger";
import { flattenSteps } from "../../supabase/functions/_shared/ai_flows/branching";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";
import {
  AMY_BUSINESS_ID,
  EFU,
  EFU_TAG,
  FOLLOW_UP_TAG,
  buildEmailFollowUpBlock,
  buildEmailOnlyTagBlock,
  type Definition
} from "./_amy-email-followup-block";

/** The flows that carried the inline rounds. HomeLight has its own ladder. */
export const TARGET_FLOWS = [
  "ReferralExchange Lead",
  "Realtor.com Lead",
  "New Lead Intake",
  "Clever Lead - Accept"
] as const;

export function alreadyPatched(def: Definition): boolean {
  return def.steps.some((s) => s.id === `${EFU_TAG}_root`);
}

/**
 * The flat index the inline block starts at, or null when it is absent. Any
 * run parked at or after this index loses its instruction when the block goes.
 */
export function inlineBlockStartIndex(def: Definition): number | null {
  const flat = flattenSteps((def.steps ?? []) as unknown as FlowStep[]);
  const idx = flat.findIndex((e) => e.step.id === `${EFU}_root`);
  return idx === -1 ? null : idx;
}

/** Swap the inline rounds for the tag. Returns false when already swapped. */
export function applyTagHandover(def: Definition, notes: string[]): boolean {
  if (alreadyPatched(def)) return false;
  const before = def.steps.length;
  def.steps = def.steps.filter((s) => s.id !== `${EFU}_root`);
  if (def.steps.length < before) notes.push(`removed the inline ${EFU}_root rounds`);
  def.steps.push(buildEmailOnlyTagBlock());
  notes.push(`appended ${EFU_TAG}_root (tags "${FOLLOW_UP_TAG}" for an email-only lead)`);
  return true;
}

/** Put the inline rounds back and drop the tag block. */
export function revertTagHandover(def: Definition, notes: string[]): boolean {
  if (!alreadyPatched(def)) return false;
  def.steps = def.steps.filter((s) => s.id !== `${EFU_TAG}_root`);
  notes.push(`removed ${EFU_TAG}_root`);
  if (!def.steps.some((s) => s.id === `${EFU}_root`)) {
    def.steps.push(buildEmailFollowUpBlock());
    notes.push(`restored the inline ${EFU}_root rounds`);
  }
  return true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const revert = process.argv.includes("--revert");
  const force = process.argv.includes("--force");
  loadEnv();
  const db: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string
  );

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", AMY_BUSINESS_ID)
    .is("deleted_at", null);
  if (error) throw new Error(`read flows: ${error.message}`);

  // TWO PASSES, deliberately. The index-safety check has to cover EVERY target
  // before anything is written: a single pass that wrote as it went would
  // update the first flows, hit a stranded run on the fourth, and exit leaving
  // half the fleet on the new shape, half on the old, and no ledger row saying
  // so. Nothing is written until every flow has been cleared.
  type Planned = {
    id: string;
    name: string;
    def: Definition;
    previous: unknown;
    notes: string[];
  };
  const planned: Planned[] = [];
  const stranded: string[] = [];

  for (const name of TARGET_FLOWS) {
    const row = (data ?? []).find((f) => f.name === name);
    if (!row) {
      console.log(`SKIP  ${name}: not found`);
      continue;
    }
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const notes: string[] = [];

    const start = revert ? null : inlineBlockStartIndex(def);
    if (start !== null) {
      const { data: runs, error: runErr } = await db
        .from("ai_flow_runs")
        .select("id,status,current_step")
        .eq("flow_id", row.id)
        .not("status", "in", "(done,failed,canceled)")
        .gte("current_step", start);
      if (runErr) throw new Error(`read runs for ${name}: ${runErr.message}`);
      for (const r of (runs ?? []) as Array<{ id: string; status: string; current_step: number }>) {
        stranded.push(
          `${name}: run ${r.id} is parked at step ${r.current_step}, inside the block ` +
            `starting at ${start} (${r.status}). Migrate it (contact + "${FOLLOW_UP_TAG}" tag) first.`
        );
      }
    }

    const changed = revert ? revertTagHandover(def, notes) : applyTagHandover(def, notes);
    if (!changed) {
      console.log(`SKIP  ${name}: already in the desired state`);
      continue;
    }
    planned.push({ id: row.id, name, def, previous: row.definition, notes });
  }

  for (const line of stranded) console.log(`  !! ${line}`);
  if (stranded.length > 0 && !force) {
    console.error(
      `\nREFUSED: ${stranded.length} run(s) are parked inside the block this removes. ` +
        `Nothing was written. Migrate them, or re-run with --force to strand them deliberately.`
    );
    process.exit(1);
  }

  const touched: Array<Record<string, unknown>> = [];
  for (const p of planned) {
    console.log(`${apply ? "APPLY" : "DRY  "} ${p.name}: ${p.notes.join("; ")}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({
        definition: p.def,
        edit_source: "oneshot",
        edit_actor: "amy-email-followup-via-tag.ts"
      })
      .eq("business_id", AMY_BUSINESS_ID)
      .eq("id", p.id)
      .select("id")
      .single();
    if (upErr) throw new Error(`update ${p.name}: ${upErr.message}`);
    touched.push({ flow_id: p.id, name: p.name, notes: p.notes, previous_definition: p.previous });
  }

  if (apply && touched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId: AMY_BUSINESS_ID,
      details: { revert, flows: touched }
    });
  }
  console.log(
    apply ? `\nDone: ${touched.length} flow(s) updated.` : "\nDry run. Re-run with --apply."
  );
}

if (process.argv[1]?.endsWith("amy-email-followup-via-tag.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
