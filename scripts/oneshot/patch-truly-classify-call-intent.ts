/**
 * patch-truly-classify-call-intent.ts — one-shot: tighten the wants_a_call
 * category so "I need help with home coverage" stops routing as a call
 * request (live-test miss, 2026-07-15, NCW Flow Test tenant).
 *
 * The description "asks to talk to someone, book, schedule, or be called
 * now" let gemini-2.5-flash-lite read "I need help with X" as asking to
 * talk to a person, so the lead skipped the renewal question and went
 * straight to the hot-lead call path. Live probe (8 messages, old vs new
 * on the exact worker prompt + model): old misses that message; the
 * tightened wording below classifies all 8 correctly, including "Call me",
 * "Can someone call me right now", and "Can we set up a time to talk
 * tomorrow?".
 *
 * Applies to EVERY classify step in the flow that carries the loose
 * wants_a_call description (classify_reply, classify_renewal,
 * classify_late, classify_reply3, …); gave_info is widened to explicitly
 * own "what coverage they need".
 *
 * Targets the NCW Flow Test tenant's copy by default; --truly patches
 * Truly Insurance's live flows (requires explicit owner permission per
 * account policy). Dry-run by default; validated through
 * parseAiFlowDefinition; idempotent.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-truly-classify-call-intent.ts                  # dry-run (test tenant)
 *   npx tsx scripts/oneshot/patch-truly-classify-call-intent.ts --apply          # apply to TEST tenant
 *   npx tsx scripts/oneshot/patch-truly-classify-call-intent.ts --apply --truly  # ⚠️ apply to Truly
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const TRULY = process.argv.includes("--truly");

const TEST_BUSINESS_ID = "f1047e50-0000-4000-8000-000000000001";
const TRULY_BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410";
const BUSINESS_ID = TRULY ? TRULY_BUSINESS_ID : TEST_BUSINESS_ID;
const FLOW_NAMES = TRULY
  ? ["Lead intake & follow-up (Privyr) (copy)", "Lead intake & follow-up (Privyr)"]
  : ["Lead intake & follow-up (Privyr) (TEST COPY of Truly)"];

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };
type AnyStep = Record<string, unknown>;
type Category = { value: string; description?: string };

const WANTS_A_CALL_NEW =
  "explicitly asks for a call or conversation (e.g. 'call me', 'can someone call', " +
  "'let's talk', asks to book or schedule a time). Merely stating what coverage or " +
  "help they need is NOT this category.";

/** gave_info gains explicit ownership of "what coverage they need". */
function widenGaveInfo(old: string): string {
  if (old.includes("what coverage they need")) return old;
  return old.replace(
    /^answered the question - /,
    "answered the question or shared their situation - what coverage they need, "
  );
}

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: string[] } {
  const changed: string[] = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  const walk = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.type === "classify") {
        const cats = (step.categories ?? []) as Category[];
        for (const cat of cats) {
          if (cat.value === "wants_a_call" && cat.description !== WANTS_A_CALL_NEW) {
            cat.description = WANTS_A_CALL_NEW;
            changed.push(`${step.id}: wants_a_call tightened`);
          }
          if (cat.value === "gave_info" && cat.description) {
            const widened = widenGaveInfo(cat.description);
            if (widened !== cat.description) {
              cat.description = widened;
              changed.push(`${step.id}: gave_info widened`);
            }
          }
        }
      }
      if (step.type === "branch") {
        for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) walk(arm.steps);
        if (Array.isArray(step.else)) walk(step.else as AnyStep[]);
      }
    }
  };
  walk(steps);

  return { next: { ...def, steps: steps as unknown as FlowStep[] }, changed };
}

const { data: rows, error } = await db
  .from("ai_flows")
  .select("id,name,enabled,definition")
  .eq("business_id", BUSINESS_ID)
  .in("name", FLOW_NAMES);
if (error) throw new Error(error.message);

const targets: Array<{ row: Row; next: AiFlowDefinition; changed: string[] }> = [];
for (const row of (rows ?? []) as Row[]) {
  const { next, changed } = patch(row.definition);
  try {
    targets.push({ row, next: parseAiFlowDefinition(next), changed });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`"${row.name}" failed validation:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`"${row.name}" failed validation:`, err);
    }
    process.exit(2);
  }
}

for (const { row, changed } of targets) {
  console.log(
    `\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}, tenant=${TRULY ? "TRULY" : "test"}) ===`
  );
  if (changed.length === 0) {
    console.log("  already patched — no changes");
    continue;
  }
  for (const c of changed) console.log(`  - ${c}`);
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

const patchedIds: string[] = [];
for (const { row, next, changed } of targets) {
  if (changed.length === 0) continue;
  const { error: upErr } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (upErr) {
    console.error(`update "${row.name}" failed: ${upErr.message}`);
    process.exit(1);
  }
  patchedIds.push(row.id);
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}
if (TRULY && patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-truly-classify-call-intent.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds }
  });
}
console.log("\nDone.");
