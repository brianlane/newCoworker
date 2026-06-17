/**
 * One-shot: set the REAL canned reply on the existing "Clever Lead - Group
 * Reply" AiFlow (Flow B) and enable it. Updates the row in place (by
 * business_id + name) so we don't create a duplicate of the placeholder seed.
 *
 * Reply copy is Amy's exact group-text response, with the seller's first name
 * templated to {{vars.seller_first_name}} (the rest is verbatim).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx debug/enable-clever-group-reply.ts            # dry run
 *   npx tsx debug/enable-clever-group-reply.ts --apply    # update + enable
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../src/lib/ai-flows/schema.ts"
);

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = process.env.AIFLOW_SEED_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const NAME = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Group Reply";

const REPLY_BODY =
  "Hi {{vars.seller_first_name}}.\n\n" +
  "I am an agent partner with Clever Real Estate.\n\n" +
  "I offer a FREE Certified Appraisal to all my sellers from my licensed appraiser " +
  "to give buyers confidence and keep them from lowballing you. I'm licensed since 1989, " +
  "one of the top agents in Arizona and sell homes fast! We also have cash buyers on hand.\n\n" +
  "We will be emailing you a market analysis home valuation for your home.\n\n" +
  "When is a good time to discuss next steps for your FREE Appraisal & your cash offers?\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart \u{1F60A}";

const definitionInput = {
  version: 1,
  trigger: {
    channel: "sms",
    correlationWindowMinutes: 15,
    conditions: [
      { type: "contains", value: "Clever Real Estate", caseInsensitive: true },
      { type: "contains", value: "introduce you to Amy", caseInsensitive: true }
    ]
  },
  steps: [
    {
      id: "extract",
      type: "extract_text",
      fields: [
        {
          name: "seller_first_name",
          description: "The seller's first name from the Clever intro message"
        }
      ]
    },
    {
      id: "approve",
      type: "approval_gate",
      prompt: "Send the Clever intro reply to {{vars.seller_first_name}}?"
    },
    { id: "reply", type: "send_sms", replyToGroup: true, body: REPLY_BODY }
  ],
  options: { suppressDefaultReply: true }
};

let definition;
try {
  definition = parseAiFlowDefinition(definitionInput);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("Definition failed validation:");
    for (const issue of err.issues) console.error(`  - ${issue}`);
  } else {
    console.error("Definition failed validation:", err);
  }
  process.exit(2);
}

console.log(`Business : ${BUSINESS_ID}`);
console.log(`Name     : ${NAME}`);
console.log(`Summary  : ${summarizeDefinition(definition)}`);
console.log(`Reply body:\n${REPLY_BODY}\n`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: existing, error: readErr } = await db
  .from("ai_flows")
  .select("id,enabled")
  .eq("business_id", BUSINESS_ID)
  .eq("name", NAME)
  .maybeSingle();
if (readErr) {
  console.error(`Read failed: ${readErr.message}`);
  process.exit(1);
}
if (!existing) {
  console.error(`No existing "${NAME}" flow to update. Run the seed script first.`);
  process.exit(1);
}
console.log(`Existing : id=${existing.id} enabled=${existing.enabled}`);

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply to update + enable.");
  process.exit(0);
}

const { error: updErr } = await db
  .from("ai_flows")
  .update({ definition, enabled: true })
  .eq("id", existing.id);
if (updErr) {
  console.error(`Update failed: ${updErr.message}`);
  process.exit(1);
}
console.log(`\nUpdated AiFlow id=${existing.id} with real reply copy and enabled=true.`);
