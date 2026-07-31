/**
 * fix-hq-placeholder-contact-names.ts: undo the "there" defect on the HQ
 * tenant (Jul 30 2026).
 *
 * What happened. A prospect called the demo line and never gave a name.
 * `capture_caller_details` correctly logged `callerName: null`, so the contact
 * row was created nameless. The "Demo caller follow-up (HQ)" flow then ran an
 * `extract_text` whose field description said "'there' when no name is
 * present", the model obliged, and the `send_sms` filing side effect stamped
 * that placeholder on as the contact's display name. The nightly summarizer
 * read it back and wrote "The customer is named there" into `summary_md`, so
 * one greeting stand-in became the AI's durable belief about a real person.
 *
 * The code fixes ship alongside this script (a placeholder guard in the flow
 * engine's `extractLeadIdentity` / `upsert_customer` planner and in
 * `ensureCapturedContact`, so no surface can file one again). This script
 * repairs what already landed:
 *
 *   1. rewrite the `s_extract` lead_name description on both HQ follow-up
 *      flows so the model stops producing the placeholder at all;
 *   2. clear any auto-set placeholder display_name on HQ contacts;
 *   3. clear the poisoned rolling summary on those contacts so it rebuilds
 *      from the real conversation instead of restating the fake name.
 *
 * Safety: every contact write is scoped to `name_source = 'auto'`, so an
 * owner-typed name is never touched, and only names that ARE placeholders are
 * cleared. Idempotent: a second run finds nothing to do. Previous values are
 * printed on apply for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/fix-hq-placeholder-contact-names.ts          # dry-run
 *   npx tsx scripts/oneshot/fix-hq-placeholder-contact-names.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAMES = ["Demo caller follow-up (HQ)", "Webchat lead follow-up (HQ)"];

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { isPlaceholderLeadName } = await import(
  "../../supabase/functions/_shared/ai_flows/engine.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

/** The corrected wording, lockstep with setup-hq-dogfood-flows.ts. */
const LEAD_NAME_DESCRIPTION =
  "The lead's first name only. Return an empty string when no name is present: " +
  "never a stand-in like 'there', which would be filed as this lead's real name " +
  "(the greeting collapses cleanly on its own when the name is empty)";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type FlowRow = {
  id: string;
  name: string;
  definition: { steps?: Array<Record<string, unknown>> } & Record<string, unknown>;
};

type ContactRow = {
  id: string;
  customer_e164: string;
  display_name: string | null;
  name_source: string | null;
  summary_md: string | null;
};

// --- 1. Flows: stop the extractor manufacturing a placeholder -------------

const { data: flowRows, error: flowErr } = await db
  .from("ai_flows")
  .select("id, name, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .in("name", FLOW_NAMES);
if (flowErr) {
  console.error("[oneshot] flow listing failed:", flowErr.message);
  process.exit(1);
}
const flows = (flowRows ?? []) as FlowRow[];
const missingFlows = FLOW_NAMES.filter((n) => !flows.some((f) => f.name === n));
if (missingFlows.length > 0) {
  console.error("[oneshot] HQ flows not found:", missingFlows.join(", "));
  process.exit(1);
}

const flowPatches: Array<{ id: string; name: string; definition: unknown; previous: string }> = [];
for (const flow of flows) {
  const steps = Array.isArray(flow.definition.steps) ? flow.definition.steps : [];
  let previous = "";
  let changed = false;

  const nextSteps = steps.map((step) => {
    if (step.type !== "extract_text" || !Array.isArray(step.fields)) return step;
    const fields = (step.fields as Array<Record<string, unknown>>).map((field) => {
      if (field.name !== "lead_name") return field;
      const current = String(field.description ?? "");
      if (current === LEAD_NAME_DESCRIPTION) return field;
      previous = current;
      changed = true;
      return { ...field, description: LEAD_NAME_DESCRIPTION };
    });
    return { ...step, fields };
  });

  if (!changed) {
    console.log(`[oneshot] noop   flow "${flow.name}": lead_name description already corrected`);
    continue;
  }

  let definition;
  try {
    definition = parseAiFlowDefinition({ ...flow.definition, steps: nextSteps });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err.issues);
    } else {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err);
    }
    process.exit(1);
  }
  console.log(`[oneshot] patch  flow "${flow.name}": lead_name description`);
  console.log(`             was: ${previous}`);
  flowPatches.push({ id: flow.id, name: flow.name, definition, previous });
}

// --- 2/3. Contacts: clear placeholder names and the summaries they poisoned

const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, customer_e164, display_name, name_source, summary_md")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("name_source", "auto")
  .not("display_name", "is", null);
if (contactErr) {
  console.error("[oneshot] contact listing failed:", contactErr.message);
  process.exit(1);
}

const poisoned = ((contactRows ?? []) as ContactRow[]).filter((c) =>
  isPlaceholderLeadName(String(c.display_name))
);

for (const c of poisoned) {
  console.log(
    `[oneshot] repair contact ${c.customer_e164}: display_name "${c.display_name}" -> null` +
      `${c.summary_md ? ", clearing rolling summary" : ""}`
  );
}
if (poisoned.length === 0) {
  console.log("[oneshot] no placeholder-named HQ contacts found");
}

if (flowPatches.length === 0 && poisoned.length === 0) {
  console.log("[oneshot] nothing to do.");
  process.exit(0);
}

if (!APPLY) {
  console.log(
    `[oneshot] dry run complete (${flowPatches.length} flow(s), ${poisoned.length} contact(s) ` +
      "would change). Re-run with --apply to write."
  );
  process.exit(0);
}

// --- Apply ----------------------------------------------------------------

for (const p of flowPatches) {
  const { error } = await db
    .from("ai_flows")
    .update({ definition: p.definition, updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .eq("business_id", HQ_BUSINESS_ID);
  if (error) {
    console.error(`[oneshot] flow update failed for "${p.name}":`, error.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  flow "${p.name}"`);
}

for (const c of poisoned) {
  console.log(`[oneshot] previous summary for ${c.customer_e164} (rollback reference):`);
  console.log(c.summary_md ?? "(none)");
  const { error } = await db
    .from("contacts")
    .update({
      display_name: null,
      // The summary asserted the placeholder as fact ("The customer is named
      // there"). Clearing it lets the summarizer rebuild from the real
      // conversation rather than carrying the fiction forward.
      summary_md: null,
      last_summarized_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", c.id)
    .eq("business_id", HQ_BUSINESS_ID)
    // Re-assert the guard at write time: an owner who renamed this contact
    // between the read above and now must win.
    .eq("name_source", "auto");
  if (error) {
    console.error(`[oneshot] contact update failed for ${c.customer_e164}:`, error.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  contact ${c.customer_e164}`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "fix-hq-placeholder-contact-names.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    flow_ids: flowPatches.map((p) => p.id),
    flow_names: flowPatches.map((p) => p.name),
    contacts_repaired: poisoned.map((c) => c.customer_e164),
    previous_names: Object.fromEntries(poisoned.map((c) => [c.customer_e164, c.display_name]))
  }
});

console.log("[oneshot] applied.");
