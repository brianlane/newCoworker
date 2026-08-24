/**
 * patch-kin-lead-flow.ts: KIN Integrated Child Health lead follow-up.
 *
 * Replaces the never-customized white-glove template on KIN's "Lead follow-up
 * (white-glove build)" row with the definition in kin-lead-definition.ts
 * (pure builder, pinned by tests/oneshot-kin-definitions.test.ts).
 *
 * What the row looked like before this ran:
 *   - the greeting was the intake text pasted verbatim, typos included
 *     ("We wanna get you started on you healing journey soon. So, l'll help
 *     you get started with your first call", with a lowercase L in "l'll"),
 *   - no step named the business, so the first text a lead ever received
 *     did not say who was texting,
 *   - no step carried a booking link, so a motivated lead had nothing to act
 *     on, and
 *   - no send step had quiet hours, so a 2 AM Meta lead got a 2 AM text.
 *
 * ENABLED IS LEFT ALONE. The row is disabled and stays disabled: enabling
 * waits on Kingsley approving the wording AND the real JaneApp link landing.
 * Enabling is a separate, deliberate act in the dashboard.
 *
 * REFUSES to --apply while KIN_JANEAPP_BOOKING_LINK is still the placeholder,
 * same guard as patch-scar-fairy-lead-flow.ts, so the sentinel can never
 * reach a lead's phone.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kin-lead-flow.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kin-lead-flow.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  buildKinLeadDefinition,
  bookingLinkIsPending,
  KIN_FLOW_NAME,
  KIN_JANEAPP_BOOKING_LINK
} from "./kin-lead-definition.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KIN_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KIN_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: row, error: fetchErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", KIN_FLOW_NAME)
  .maybeSingle();
if (fetchErr) {
  console.error(`[oneshot] flow fetch failed: ${fetchErr.message}`);
  process.exit(1);
}
if (!row) {
  console.error(`[oneshot] no flow named "${KIN_FLOW_NAME}" on business ${BUSINESS_ID}`);
  process.exit(1);
}

const next = buildKinLeadDefinition();
try {
  parseAiFlowDefinition(next);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error(`[oneshot] built definition failed schema validation: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

console.log(`[oneshot] flow ${row.id} ("${row.name}") enabled=${row.enabled}`);
console.log("[oneshot] CURRENT definition (rollback copy):");
console.log(JSON.stringify(row.definition));
console.log("[oneshot] NEW definition:");
console.log(JSON.stringify(next));

if (!APPLY) {
  if (bookingLinkIsPending()) {
    console.log(
      "[oneshot] NOTE: the JaneApp link is still the placeholder; --apply will refuse until it lands."
    );
  }
  console.log("[oneshot] dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

if (bookingLinkIsPending()) {
  console.error(
    `[oneshot] REFUSING: KIN_JANEAPP_BOOKING_LINK is still ${KIN_JANEAPP_BOOKING_LINK}. ` +
      "Set the real JaneApp link in kin-lead-definition.ts first."
  );
  process.exit(1);
}

const { error: updateErr } = await db
  .from("ai_flows")
  .update({
    definition: next,
    updated_at: new Date().toISOString(),
    edit_source: "oneshot",
    edit_actor: "patch-kin-lead-flow.ts"
  })
  .eq("id", row.id);
if (updateErr) {
  console.error(`[oneshot] update failed: ${updateErr.message}`);
  process.exit(1);
}
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { flowId: row.id, flowName: row.name, enabledLeftAs: row.enabled }
});
console.log("[oneshot] applied. enabled untouched; enable in the dashboard after owner approval.");
