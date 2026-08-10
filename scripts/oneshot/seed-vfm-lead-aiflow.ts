#!/usr/bin/env tsx
/**
 * seed-vfm-lead-aiflow.ts: seed the Vantage Flow Media lead flow on the KYP
 * Ads tenant (definition: vfm-lead-flow-definition.ts, which carries the
 * full design rationale).
 *
 * Also ensures the flow's run_agent dependency exists: a business_agents
 * row ("VFM booked-time parser") that turns the lead's replies into an ISO
 * instant for the T-60 confirmation sleep. The agent is found by name and
 * created when absent, so re-runs converge.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API
 * use. Dry-run by default; idempotent (existing flow by name is left alone
 * unless --force).
 *
 * Assignee modes (see the definition module):
 *   --assignee-name "<roster name>"  roster mode: route_to_team pin + SMS
 *   (omitted)                        email-only mode: teammate touches are
 *                                    send_email to --assignee-email
 *
 * Usage (ids/PII from argv or env, never hard-coded):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-vfm-lead-aiflow.ts --business <uuid> \
 *     --assignee-email <email> [--assignee-name "<name>"]            # dry run
 *   ... --apply --enable                                             # land it, live
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  buildVfmLeadFlowDefinition,
  VFM_FLOW_NAME,
  VFM_PARSER_AGENT_NAME,
  VFM_PARSER_AGENT_INSTRUCTIONS
} from "./vfm-lead-flow-definition.ts";

loadEnv();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const ENABLE = process.argv.includes("--enable");
const FORCE = process.argv.includes("--force");
const BUSINESS_ID = argValue("--business") ?? process.env.VFM_BUSINESS_ID;
const ASSIGNEE_NAME = argValue("--assignee-name") ?? process.env.VFM_ASSIGNEE_NAME;
const ASSIGNEE_EMAIL = (argValue("--assignee-email") ?? process.env.VFM_ASSIGNEE_EMAIL)
  ?.trim()
  .toLowerCase();

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set VFM_BUSINESS_ID)");
  process.exit(1);
}
if (!ASSIGNEE_EMAIL) {
  console.error("[oneshot] pass --assignee-email (or set VFM_ASSIGNEE_EMAIL)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// Roster mode needs the pinned member to actually exist (apply-vfm-team.ts
// creates it); refuse early rather than seeding a flow whose pin can never
// resolve and silently owner-fallbacks every lead.
if (ASSIGNEE_NAME) {
  const { data: member, error } = await db
    .from("ai_flow_team_members")
    .select("id, name, active")
    .eq("business_id", BUSINESS_ID)
    .eq("name", ASSIGNEE_NAME)
    .maybeSingle();
  if (error) {
    console.error("[oneshot] roster read failed:", error.message);
    process.exit(1);
  }
  if (!member || member.active !== true) {
    console.error(
      `[oneshot] roster member "${ASSIGNEE_NAME}" not found or inactive. ` +
        "Run apply-vfm-team.ts first, or omit --assignee-name for email-only mode."
    );
    process.exit(1);
  }
}

// Ensure the parser agent (find by name, create when absent).
const { data: agents, error: agentReadErr } = await db
  .from("business_agents")
  .select("id, name, instructions, enabled")
  .eq("business_id", BUSINESS_ID)
  .eq("name", VFM_PARSER_AGENT_NAME);
if (agentReadErr) {
  console.error("[oneshot] business_agents read failed:", agentReadErr.message);
  process.exit(1);
}
let parserAgentId = agents?.[0]?.id as string | undefined;
const parserNeedsCreate = !parserAgentId;
const parserNeedsUpdate =
  !parserNeedsCreate &&
  (agents![0].instructions !== VFM_PARSER_AGENT_INSTRUCTIONS || agents![0].enabled !== true);

// Build + validate with a placeholder id first so the dry run shows the
// full definition even before the agent row exists.
const definitionInput = buildVfmLeadFlowDefinition({
  assigneeName: ASSIGNEE_NAME,
  assigneeEmail: ASSIGNEE_EMAIL,
  emailOnly: !ASSIGNEE_NAME,
  parserAgentId: parserAgentId ?? "00000000-0000-0000-0000-000000000000"
});

let definition;
try {
  definition = parseAiFlowDefinition(definitionInput);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("[oneshot] definition failed validation:");
    for (const issue of err.issues) console.error(`  - ${issue}`);
  } else {
    console.error("[oneshot] definition failed validation:", err);
  }
  process.exit(2);
}

console.log(`Business : ${BUSINESS_ID}`);
console.log(`Name     : ${VFM_FLOW_NAME}`);
console.log(`Mode     : ${ASSIGNEE_NAME ? `roster (pin: ${ASSIGNEE_NAME})` : "email-only"}`);
console.log(`Parser   : ${parserAgentId ?? "(will create)"}${parserNeedsUpdate ? " (will update)" : ""}`);
console.log(`Enabled  : ${ENABLE}`);
console.log(`Summary  : ${summarizeDefinition(definition)}`);
console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

const { data: existing, error: readErr } = await db
  .from("ai_flows")
  .select("id, enabled")
  .eq("business_id", BUSINESS_ID)
  .eq("name", VFM_FLOW_NAME)
  .maybeSingle();
if (readErr) {
  console.error(`[oneshot] flows read failed: ${readErr.message}`);
  process.exit(1);
}
if (existing && !FORCE) {
  console.log(
    `\nFlow "${VFM_FLOW_NAME}" already exists (id=${existing.id}, enabled=${existing.enabled}). ` +
      "Nothing to do. Pass --force to overwrite its definition in place."
  );
  process.exit(0);
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply to insert.");
  process.exit(0);
}

if (parserNeedsCreate) {
  const { data, error } = await db
    .from("business_agents")
    .insert({
      business_id: BUSINESS_ID,
      name: VFM_PARSER_AGENT_NAME,
      instructions: VFM_PARSER_AGENT_INSTRUCTIONS,
      output_format: "markdown"
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[oneshot] parser agent insert failed: ${error.message}`);
    process.exit(1);
  }
  parserAgentId = data.id;
  console.log(`Created parser agent id=${parserAgentId}.`);
} else if (parserNeedsUpdate) {
  const { error } = await db
    .from("business_agents")
    .update({ instructions: VFM_PARSER_AGENT_INSTRUCTIONS, enabled: true })
    .eq("id", parserAgentId!);
  if (error) {
    console.error(`[oneshot] parser agent update failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`Updated parser agent id=${parserAgentId}.`);
}

// Rebuild with the real agent id and re-validate before writing.
const finalDefinition = parseAiFlowDefinition(
  buildVfmLeadFlowDefinition({
    assigneeName: ASSIGNEE_NAME,
    assigneeEmail: ASSIGNEE_EMAIL,
    emailOnly: !ASSIGNEE_NAME,
    parserAgentId: parserAgentId!
  })
);

let flowId: string;
if (existing) {
  const { error } = await db
    .from("ai_flows")
    .update({ definition: finalDefinition, enabled: ENABLE })
    .eq("id", existing.id);
  if (error) {
    console.error(`[oneshot] flow update failed: ${error.message}`);
    process.exit(1);
  }
  flowId = existing.id;
  console.log(`\nUpdated AiFlow id=${flowId} (enabled=${ENABLE}).`);
} else {
  const { data, error } = await db
    .from("ai_flows")
    .insert({
      business_id: BUSINESS_ID,
      name: VFM_FLOW_NAME,
      enabled: ENABLE,
      definition: finalDefinition
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[oneshot] flow insert failed: ${error.message}`);
    process.exit(1);
  }
  flowId = data.id;
  console.log(`\nSeeded AiFlow id=${flowId} (enabled=${ENABLE}).`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    flow_id: flowId,
    flow_name: VFM_FLOW_NAME,
    enabled: ENABLE,
    mode: ASSIGNEE_NAME ? "roster" : "email_only",
    parser_agent_id: parserAgentId
  }
});
