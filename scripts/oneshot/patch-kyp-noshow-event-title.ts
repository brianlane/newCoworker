#!/usr/bin/env tsx
/**
 * One-shot: repair the no-show recovery flow's $200 branch, which a Calendly
 * rename silently disconnected.
 *
 * KYP's two strategy-call event types encode the price tier in their NAME:
 *
 *   my-free-scale-plan        -> "KYP Ads | Free Strategy Call"            $100/wk
 *   kyp-ads-free-strategy-2   -> "KYP Ads | Free Strategy Call | Client"   $200/wk
 *
 * The no-show flow branches on the event title, and its $200 arm still tests
 * for `"free strategy call | 2"`. That string matched the OLD name of the
 * second event type. After the rename to "| Client" the condition can never
 * be true, so every $200 no-show falls through to the $100 arm and is texted
 * `my-free-scale-plan`, the cheaper link. KYP's own wrong-link flow says in
 * as many words: "never mention the $100 rate to a new lead."
 *
 * Latent rather than realized, which is the only reason this is a patch and
 * not an incident: both runs to date (Jul 20, Aug 1 2026) were genuine $100
 * events, so the dead arm has not yet cost a rate. Found while investigating
 * the Reem timezone failure on 2026-08-05.
 *
 * The arm ORDER already does the right thing: `arm_200` is evaluated before
 * `arm_100`, and arm_100's broader `"free strategy call"` still catches the
 * $100 type, so only the one condition value needs to change.
 *
 * Worth knowing for next time: this mapping is keyed on a display name James
 * can edit in Calendly at any moment, with nothing on our side that notices.
 * The durable fix is matching on the event type SLUG, which the payload does
 * not currently carry. Recorded in docs/tenants/kyp-ads.md instead of being
 * silently worked around here.
 *
 * Idempotent, validates before writing, prints the previous definition for
 * rollback, dry-run by default, ledger-recorded. Never adds or removes a
 * step, so parked runs are unaffected.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kyp-noshow-event-title.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-kyp-noshow-event-title.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { parseAiFlowDefinition } from "../../src/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

export const KYP_NOSHOW_FLOW_NAME =
  "No-show recovery text — mark no-shows in Calendly within 2h; awaiting approval";

/** The condition value that no live event type matches any more. */
export const STALE_PREMIUM_TITLE = "free strategy call | 2";
/** The live title of the $200 event type (slug kyp-ads-free-strategy-2). */
export const CURRENT_PREMIUM_TITLE = "free strategy call | client";

type ConditionJson = { var?: string; contains?: string; caseInsensitive?: boolean };
type BranchJson = { id?: string; label?: string; condition?: ConditionJson };
type StepJson = { id?: string; type?: string; branches?: BranchJson[] };
type DefinitionJson = { steps?: StepJson[] };

export type TransformResult = {
  definition: DefinitionJson;
  changed: boolean;
  notes: string[];
};

/** Pure, so the swap is unit-testable without touching the network. */
export function retargetPremiumArm(input: unknown): TransformResult {
  const definition = structuredClone(input) as DefinitionJson;
  const notes: string[] = [];
  let changed = false;

  const branchSteps = (definition.steps ?? []).filter(
    (s) => s.type === "branch" && Array.isArray(s.branches)
  );
  if (branchSteps.length === 0) {
    return { definition, changed: false, notes: ["wrong flow shape: no branch step"] };
  }

  for (const step of branchSteps) {
    for (const arm of step.branches ?? []) {
      const value = arm.condition?.contains;
      if (typeof value !== "string") continue;
      if (value.toLowerCase() !== STALE_PREMIUM_TITLE) continue;
      arm.condition!.contains = CURRENT_PREMIUM_TITLE;
      changed = true;
      notes.push(
        `${step.id}/${arm.id}: condition "${value}" -> "${CURRENT_PREMIUM_TITLE}" ` +
          "(the $200 event type was renamed to | Client)"
      );
    }
  }

  if (!changed) {
    notes.push(
      `already patched (no arm tests for "${STALE_PREMIUM_TITLE}"). If the $200 arm still ` +
        "never fires, check the live Calendly event-type names again."
    );
  }
  return { definition, changed, notes };
}

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business") args.businessId = argv[++i] ?? null;
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
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const businessId =
    args.businessId ?? process.env.AIFLOW_KYP_BUSINESS_ID ?? process.env.KYP_BUSINESS_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
    console.error("Pass --business <uuid> (or set AIFLOW_KYP_BUSINESS_ID / KYP_BUSINESS_ID)");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .eq("name", KYP_NOSHOW_FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No "${KYP_NOSHOW_FLOW_NAME}" flow for ${businessId}`);
    process.exit(1);
  }

  console.log(`=== ${row.name} (${row.id}, enabled=${row.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

  const result = retargetPremiumArm(row.definition);
  for (const note of result.notes) console.log(`  - ${note}`);
  if (!result.changed) {
    console.log("Nothing to do.");
    return;
  }

  try {
    parseAiFlowDefinition(result.definition);
  } catch (e) {
    console.error(`  ! Patched definition is invalid: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!args.apply) {
    console.log("  [dry-run] Not writing. Re-run with --apply.");
    return;
  }

  const { error: writeErr } = await db
    .from("ai_flows")
    .update({ definition: result.definition })
    .eq("id", row.id);
  if (writeErr) {
    console.error(`  ! Write failed: ${writeErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId,
    details: { flow: row.id, from: STALE_PREMIUM_TITLE, to: CURRENT_PREMIUM_TITLE }
  });
  console.log("  Written.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
