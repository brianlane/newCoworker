#!/usr/bin/env tsx
/**
 * One-shot: seed the "Clever Homeward Offers" AiFlow for a single tenant.
 *
 * Clever's Homeward cash-offer texts arrive on a dedicated number
 * (470-221-2279). We do NOT auto-reply to them; instead we forward the offer to
 * the pinned agent (Dave) with a fixed coaching preamble, so the agent has the
 * numbers AND the reminder of how to position them. The agent's phone is
 * resolved from the roster at run time (send_sms toAgentName), so it stays
 * correct as the roster changes, and {{agent.name}} renders the salutation.
 *
 *   inbound (470-221-2279)  ->  suppress default reply
 *                           ->  text Dave: <preamble> + <verbatim offer text>
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API use.
 * Dry-run by default; idempotent (won't create a 2nd flow with the same name
 * unless --force). --enable requires an active roster member matching the agent
 * name (otherwise the send would fail at run time).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-homeward-aiflow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-clever-homeward-aiflow.ts --apply
 *   npx tsx scripts/oneshot/seed-clever-homeward-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_CLEVER_HOMEWARD_FROM    (default "4702212279")
 *   AIFLOW_CLEVER_AGENT_NAME       (default "Dave Lane" — must match a roster name)
 *   AIFLOW_CLEVER_HOMEWARD_PREAMBLE (default below)
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

// Amy's verbatim coaching preamble (captured from her instructions). The agent
// salutation + the inbound offer text are appended around it.
const DEFAULT_PREAMBLE =
  "{{agent.name}}, Remember you may not need to give them these numbers if you " +
  "tell them they're usually lower than after the boots on the ground inspection. " +
  "They get even less and they get part of the money upfront and then maybe get " +
  "some of the remaining equity after it closes escrow if they sell it for enough. " +
  "Instead, suggest my free Appraisal and we will list it below Appraisal and get " +
  "a quick sale with multiple offers.";

function buildDefinition(opts: { from: string; agentName: string; preamble: string }): unknown {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [{ type: "from_matches", value: opts.from }]
    },
    steps: [
      {
        id: "tell_agent",
        type: "send_sms",
        toAgentName: opts.agentName,
        body: `${opts.preamble}\n\nHomeward offer received:\n{{trigger.windowText}}`
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

  const name = process.env.AIFLOW_SEED_NAME ?? "Clever Homeward Offers";
  const agentName = process.env.AIFLOW_CLEVER_AGENT_NAME ?? "Dave Lane";
  const definitionInput = buildDefinition({
    from: process.env.AIFLOW_CLEVER_HOMEWARD_FROM ?? "4702212279",
    agentName,
    preamble: process.env.AIFLOW_CLEVER_HOMEWARD_PREAMBLE ?? DEFAULT_PREAMBLE
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
  console.log(`Agent    : ${agentName}`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Guard: --enable only when the named agent is actually on the active roster,
  // or every inbound offer would fail with "agent not on the active roster".
  if (args.enable) {
    const { data: roster, error: rErr } = await db
      .from("ai_flow_team_members")
      .select("name")
      .eq("business_id", businessId)
      .eq("active", true);
    if (rErr) {
      console.error(`Roster check failed: ${rErr.message}`);
      process.exit(1);
    }
    const want = agentName.trim().toLowerCase();
    if (!(roster ?? []).some((r) => String(r.name).trim().toLowerCase() === want)) {
      console.error(
        `\nRefusing to --enable: no active roster member named "${agentName}". ` +
          "Set AIFLOW_CLEVER_AGENT_NAME to a roster name first."
      );
      process.exit(2);
    }
  }

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
