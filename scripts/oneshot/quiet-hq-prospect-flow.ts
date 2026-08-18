/**
 * quiet-hq-prospect-flow.ts, drop the per-prospect owner text from HQ's
 * "Prospect outreach follow-through" flow.
 *
 * HQ's flow was installed from the template BEFORE the template dropped its
 * notify_owner step, so the row in the database still carries it. Enabling it as
 * installed would text the owner's alert number once per prospect emailed,
 * against a cap of twelve a day, to report that a stranger received an email.
 *
 * The interesting notification (somebody REPLIED) already comes from the email
 * coworker, the counts are on the Marketing page, and the sent mail is on the
 * Emails page. So the step goes, and the flow keeps the two things it is for:
 * filing the prospect as a contact and tagging them.
 *
 * Idempotent: a flow with no notify_owner step is left untouched, and the
 * previous definition is printed on apply so the change can be reversed by
 * hand. Validates the patched definition through parseAiFlowDefinition BEFORE
 * writing, so a dry run catches a shape the editor would reject.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/quiet-hq-prospect-flow.ts          # dry-run
 *   npx tsx scripts/oneshot/quiet-hq-prospect-flow.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAME = "Prospect outreach follow-through";

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition } = await import("../../src/lib/ai-flows/schema.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: flow, error } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (error) throw new Error(`read flow: ${error.message}`);
if (!flow) throw new Error(`HQ has no flow named "${FLOW_NAME}" (run configure-hq-prospecting first)`);

const definition = flow.definition as { steps?: Array<Record<string, unknown>> };
const steps = Array.isArray(definition.steps) ? definition.steps : [];
const notifySteps = steps.filter((s) => s.type === "notify_owner");

console.log(`Flow: ${flow.name} (${flow.id}, ${flow.enabled ? "ENABLED" : "disabled"})`);
console.log(`Steps now: ${steps.map((s) => String(s.type)).join(" -> ")}`);

if (notifySteps.length === 0) {
  console.log("\nNo notify_owner step. Nothing to do.");
  process.exit(0);
}

const patched = { ...definition, steps: steps.filter((s) => s.type !== "notify_owner") };
// Validate before writing: a dry run should fail here rather than leaving a
// definition the editor refuses to load.
parseAiFlowDefinition(patched);

console.log(`Steps after: ${patched.steps.map((s) => String(s.type)).join(" -> ")}`);
console.log(`Removing ${notifySteps.length} notify_owner step(s).`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

console.log("\nPrevious definition, for rollback:");
console.log(JSON.stringify(definition));

const { error: writeError } = await db
  .from("ai_flows")
  .update({ definition: patched, updated_at: new Date().toISOString() })
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("id", flow.id);
if (writeError) throw new Error(`patch flow: ${writeError.message}`);

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: HQ_BUSINESS_ID,
  details: {
    flow_id: flow.id,
    removed_steps: notifySteps.length,
    steps_after: patched.steps.map((s) => String(s.type))
  }
});

console.log("\nApplied. The flow now files and tags each prospect without texting you.");
console.log("You still hear about a prospect who REPLIES: the coworker answers in the");
console.log("thread and alerts you when it hands one over.");
