#!/usr/bin/env tsx
/**
 * One-shot: seed the example "ReferralExchange lead" AiFlow for a single
 * tenant as a REAL `ai_flows` row (not hard-coded into the engine). This is
 * the Phase 8 rollout seed for the AiFlows automation engine.
 *
 * The flow it writes:
 *   trigger : inbound SMS that contains a URL (and, by default, mentions the
 *             lead source) within a correlation window — handles the common
 *             "text then link" two-message case.
 *   steps   : extract_url -> browse_extract (lead type + contact/details) ->
 *             approval_gate -> two gated send_sms steps (buyer copy when
 *             lead_type contains "buyer", seller copy when it contains
 *             "seller"; only the matching one fires) -> notify_owner.
 *   options : suppressDefaultReply so the lead-source message does NOT also
 *             get a normal Coworker reply.
 *
 * The definition is validated through the SAME `parseAiFlowDefinition` the
 * dashboard + CRUD API use, so a malformed seed can never be written.
 *
 * Why one-shot (per scripts/oneshot/README.md):
 *   - Targets ONE business by id; reads every tenant-specific value from
 *     env/argv so the file stays PII-free.
 *   - Idempotent: refuses to create a second flow with the same name unless
 *     --force is passed. Re-running is a no-op that prints the existing row.
 *   - Seeded DISABLED by default (enabled=false) so nothing fires until the
 *     owner reviews it in /dashboard/aiflows. Pass --enable to seed enabled.
 *
 * Usage:
 *   # dry run (default): prints the validated definition, writes nothing
 *   AIFLOW_SEED_BUSINESS_ID=<uuid> \
 *     npx tsx scripts/oneshot/seed-referralexchange-aiflow.ts
 *
 *   # execute the insert (still disabled until reviewed)
 *   AIFLOW_SEED_BUSINESS_ID=<uuid> \
 *     npx tsx scripts/oneshot/seed-referralexchange-aiflow.ts --apply
 *
 *   # seed already-enabled (only after you've reviewed the definition)
 *   AIFLOW_SEED_BUSINESS_ID=<uuid> \
 *     npx tsx scripts/oneshot/seed-referralexchange-aiflow.ts --apply --enable
 *
 *   # override the lead-source match text / outbound copy without editing code
 *   AIFLOW_SEED_BUSINESS_ID=<uuid> \
 *   AIFLOW_SEED_MATCH_TEXT="ReferralExchange" \
 *   AIFLOW_SEED_BUYER_TEMPLATE="Hi {{vars.lead_name}}, ..." \
 *   AIFLOW_SEED_SELLER_TEMPLATE="Hi {{vars.lead_name}}, ..." \
 *     npx tsx scripts/oneshot/seed-referralexchange-aiflow.ts --apply
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 *   AIFLOW_SEED_BUSINESS_ID            (or pass --business-id <uuid>)
 * Optional env:
 *   AIFLOW_SEED_NAME                   (default "ReferralExchange lead")
 *   AIFLOW_SEED_MATCH_TEXT             (default "ReferralExchange"; "" = URL only)
 *   AIFLOW_SEED_BUYER_TEMPLATE         (SMS body sent when lead_type=buyer)
 *   AIFLOW_SEED_SELLER_TEMPLATE        (SMS body sent when lead_type=seller)
 *   AIFLOW_SEED_CORRELATION_MINUTES    (default 15)
 *
 * Exit codes:
 *   0  — seeded, or already existed (idempotent no-op), or dry-run
 *   1  — Supabase error
 *   2  — required env/arg missing or definition invalid
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
    else if (a === "--business-id") {
      args.businessId = argv[++i] ?? null;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUYER =
  "Hi {{vars.lead_name}}, I saw you're looking to buy in {{vars.location}} " +
  "(around {{vars.price}}). Are you still searching for a home? " +
  "I'd love to help — reply here.";

const DEFAULT_SELLER =
  "Hi {{vars.lead_name}}, I saw your {{vars.location}} listing. " +
  "Are you still looking for an agent to help you sell? — reply here.";

function buildDefinition(opts: {
  matchText: string;
  buyerTemplate: string;
  sellerTemplate: string;
  correlationMinutes: number;
  integrationLabel: string;
}): unknown {
  const conditions: Array<Record<string, unknown>> = [{ type: "has_url" }];
  if (opts.matchText.trim()) {
    conditions.push({ type: "contains", value: opts.matchText.trim(), caseInsensitive: true });
  }
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: opts.correlationMinutes,
      conditions
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "browse",
        type: "browse_extract",
        urlVar: "leadUrl",
        fields: [
          {
            name: "lead_type",
            description:
              "Is this lead a buyer or a seller? Answer with exactly one lowercase " +
              "word and nothing else: buyer or seller."
          },
          { name: "lead_name", description: "The lead's first name, if shown" },
          { name: "lead_phone", description: "The lead's phone number in E.164 if possible" },
          { name: "location", description: "City/area of the lead" },
          { name: "price", description: "Asking/target price, if shown" }
        ],
        // ReferralExchange lead pages are behind the agent's login, so browse via
        // the per-tenant render service using the stored "Referral Exchange"
        // integration credentials. Requires AIFLOW_RENDER_URL_TEMPLATE on the worker.
        auth: { integrationLabel: opts.integrationLabel }
      },
      {
        id: "approve",
        type: "approval_gate",
        prompt:
          "New {{vars.lead_type}} lead: {{vars.lead_name}} in {{vars.location}} " +
          "({{vars.price}}). Send the intro text to {{vars.lead_phone}}?"
      },
      // Branch on lead_type: only the matching send_sms fires (the other is
      // skipped via its `when` guard). `equals` (not `contains`) keeps the two
      // guards mutually exclusive — a normalized "buyer"/"seller" value can
      // satisfy at most one, so a lead is never double-texted. Matching is
      // case-insensitive, and the extraction prompt normalizes lead_type to a
      // single lowercase word.
      {
        id: "send_buyer",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: opts.buyerTemplate,
        when: { var: "lead_type", equals: "buyer" }
      },
      {
        id: "send_seller",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: opts.sellerTemplate,
        when: { var: "lead_type", equals: "seller" }
      },
      // Ungated so the owner is always told a lead came in; worded as "processed"
      // (not "sent") because if lead_type matched neither branch both sends are
      // skipped and no intro went out.
      {
        id: "notify",
        type: "notify_owner",
        message:
          "AiFlow processed a {{vars.lead_type}} lead: {{vars.lead_name}} " +
          "({{vars.lead_phone}}) in {{vars.location}}."
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

  const supabaseUrl = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.SUPABASE_URL
  );
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId = args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? null;
  if (!businessId) {
    console.error(
      "Missing business id: pass --business-id <uuid> or set AIFLOW_SEED_BUSINESS_ID"
    );
    process.exit(2);
  }

  const name = process.env.AIFLOW_SEED_NAME ?? "ReferralExchange lead";
  const definitionInput = buildDefinition({
    matchText: process.env.AIFLOW_SEED_MATCH_TEXT ?? "ReferralExchange",
    buyerTemplate: process.env.AIFLOW_SEED_BUYER_TEMPLATE ?? DEFAULT_BUYER,
    sellerTemplate: process.env.AIFLOW_SEED_SELLER_TEMPLATE ?? DEFAULT_SELLER,
    correlationMinutes: Number(process.env.AIFLOW_SEED_CORRELATION_MINUTES ?? "15"),
    integrationLabel: process.env.AIFLOW_SEED_INTEGRATION_LABEL ?? "Referral Exchange"
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

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

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
      `\nFlow "${name}" already exists for this business (id=${existing.id}, ` +
        `enabled=${existing.enabled}). Nothing to do. Pass --force to create a duplicate.`
    );
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to insert.");
    return;
  }

  const { data, error } = await db
    .from("ai_flows")
    .insert({
      business_id: businessId,
      name,
      enabled: args.enable,
      definition
    })
    .select("id")
    .single();
  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
  if (!args.enable) {
    console.log("Review it in /dashboard/aiflows and toggle it on when ready.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
