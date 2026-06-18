#!/usr/bin/env tsx
/**
 * One-shot: seed the "Clever Lead - Group Reply" AiFlow for a single tenant.
 *
 * This is Flow B of the two-flow Clever design (see the Clever lead AI flow
 * plan). Clever introduces the agent to the seller in a GROUP text (seller +
 * Amy + our Telnyx DID). This flow:
 *   1. triggers on that intro text ("Clever Real Estate" + "introduce you to Amy"),
 *   2. reads the seller's first name straight from the message (extract_text), then
 *   3. posts Amy's canned reply back INTO the group thread via send_sms
 *      { replyToGroup }, which fans one group MMS to every participant except our
 *      own DID (the engine capability shipped in the Clever engine PR). The reply
 *      auto-sends (no approval gate), matching the live row.
 *
 * IMPORTANT — prerequisites before --apply / --enable:
 *   - The ai-flow-worker + telnyx-sms-inbound Edge functions must be on the
 *     Clever-engine build (the inbound handler now records group participants
 *     and the worker honors replyToGroup).
 *   - Confirm Clever's intro reaches the Telnyx number as a true group MMS
 *     (the one thing only the live test proves). If it doesn't, fall back to a
 *     1:1 send to the seller using the same trigger.
 *   - The default reply is Amy's exact canned copy; override via
 *     AIFLOW_CLEVER_REPLY_BODY only if the copy changes.
 *
 * Validated through the SAME `parseAiFlowDefinition` the dashboard + CRUD API
 * use. Dry-run by default; idempotent unless --force.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-lead-group-reply-aiflow.ts            # dry run
 *   AIFLOW_CLEVER_REPLY_BODY="Hi {{vars.seller_first_name}}, ..." \
 *     npx tsx scripts/oneshot/seed-clever-lead-group-reply-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_CLEVER_INTRO_MATCH_1 (default "Clever Real Estate")
 *   AIFLOW_CLEVER_INTRO_MATCH_2 (default "introduce you to Amy")
 *   AIFLOW_CLEVER_REPLY_BODY    (override Amy's default canned seller reply)
 */
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";

type Args = { apply: boolean; enable: boolean; force: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, enable: false, force: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--force") args.force = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

// Amy's exact canned intro reply (captured from her instructions). The greeting
// is templated on the seller's first name read from the intro text. Override
// with AIFLOW_CLEVER_REPLY_BODY only if the copy changes.
const DEFAULT_REPLY =
  "Hi {{vars.seller_first_name}}.\n\n" +
  "I am an agent partner with Clever Real Estate.\n\n" +
  "I offer a FREE Certified Appraisal to all my sellers from my licensed appraiser " +
  "to give buyers confidence and keep them from lowballing you. I'm licensed since " +
  "1989, one of the top agents in Arizona and sell homes fast! We also have cash " +
  "buyers on hand.\n\n" +
  "We will be emailing you a market analysis home valuation for your home.\n\n" +
  "When is a good time to discuss next steps for your FREE Appraisal & your cash offers?\n\n" +
  "Thanks, Amy Laidlaw ~ HomeSmart 😊";

function buildDefinition(opts: {
  match1: string;
  match2: string;
  replyBody: string;
}): unknown {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "contains", value: opts.match1, caseInsensitive: true },
        { type: "contains", value: opts.match2, caseInsensitive: true }
      ]
    },
    steps: [
      // Read the seller's first name straight from the intro text (no link).
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
      // Post the canned reply back into the group thread (all participants
      // except our own DID). Auto-sends (no approval gate) to match the live row.
      {
        id: "reply",
        type: "send_sms",
        replyToGroup: true,
        body: opts.replyBody
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  const name = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Group Reply";
  const replyBody = process.env.AIFLOW_CLEVER_REPLY_BODY ?? DEFAULT_REPLY;

  const definitionInput = buildDefinition({
    match1: process.env.AIFLOW_CLEVER_INTRO_MATCH_1 ?? "Clever Real Estate",
    match2: process.env.AIFLOW_CLEVER_INTRO_MATCH_2 ?? "introduce you to Amy",
    replyBody
  });

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

  console.log(`Business : ${businessId}`);
  console.log(`Name     : ${name}`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: existing, error: readErr } = await db
    .from("ai_flows")
    .select("id,enabled")
    .eq("business_id", businessId)
    .eq("name", name)
    .maybeSingle();
  if (readErr) {
    console.error(`Read failed: ${readErr.message}`);
    process.exit(1);
  }
  if (existing && !args.force) {
    console.log(
      `\nFlow "${name}" already exists (id=${existing.id}, enabled=${existing.enabled}). ` +
        "Nothing to do. Pass --force to create a duplicate."
    );
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to insert.");
    return;
  }

  const { data, error } = await db
    .from("ai_flows")
    .insert({ business_id: businessId, name, enabled: args.enable, definition })
    .select("id")
    .single();
  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
