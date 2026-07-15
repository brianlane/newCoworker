#!/usr/bin/env tsx
/**
 * One-shot: seed the "Clever - Spoke Check & Weekly Call Follow-Up" AiFlow
 * (Amy's request, Jul 2026):
 *
 *   "Once the AI accepts the lead and sends it to Dave, Dave responds whether
 *    he spoke with the lead. If not, the AI calls the lead once a week; when
 *    the lead says now is a good time, text Dave the lead's info + cash
 *    offers ('LIVE TRANSFER is coming — pick up!') and live-transfer the
 *    call to him."
 *
 * Trigger: `owner_assigned` scoped to Clever-tagged contacts — fires when the
 * accept flow's route_to_team claim assigns the lead to a roster member (the
 * accept flow tags contacts "Clever" via patch-clever-accept-followup.ts).
 *
 * Steps:
 *   1. extract_text     — lead_name / lead_phone from the contact-event text.
 *   2. recall_url       — the Clever lead page URL the accept flow remembered
 *                         (keyed by phone; see patch-clever-accept-followup).
 *   3. browse_extract   — credentialed re-read of that page for the CURRENT
 *                         address + cash offers (skipped when no URL was
 *                         remembered — the messages just omit those lines).
 *   4. sleep 3 days     — give the agent time to reach the lead themselves.
 *   5. route_to_team    — the spoke check, pinned to the agent: "Reply 1 =
 *                         YES I spoke with them, 2 = NO not yet". Reply 1 →
 *                         claimed_agent set → every follow-up step below
 *                         skips. Reply 2 / 24h timeout → owner fallback tells
 *                         Amy the weekly AI calls are starting.
 *   6. place_ai_call    — attempt 1 (gated claimed_agent = none): the AI
 *                         calls the lead with the scripted greeting; on "now
 *                         is a good time" it texts the agent the pre-alert
 *                         and live-transfers. Outcome → {{vars.call_outcome}}.
 *   7-13. branches      — attempts 2..8, one per week: each branch re-checks
 *                         claimed_agent (via its `when`) and call_outcome
 *                         (arms) — once a call was transferred OR answered,
 *                         the remaining attempts skip; otherwise sleep 7 days
 *                         and call again.
 *   14. goal            — replied / appointment_booked / claimed: the moment
 *                         the lead converts by any other path, the run jumps
 *                         here and pending calls never fire.
 *   15. notify_owner    — final outcome summary to Amy.
 *
 * Employee-agnostic: the agent is a roster member resolved BY NAME at seed
 * time (AIFLOW_CLEVER_AGENT_NAME, default "Dave Lane") into employee
 * ContactRefs, so a renumber/rename after seeding is picked up live.
 *
 * PREREQUISITES:
 *   - the place_ai_call engine build (ai-flow-worker + telnyx-voice-originate
 *     + telnyx-voice-call-end deployed, VPS voice bridge redeployed);
 *   - patch-clever-accept-followup.ts applied (URL memory + Clever tag);
 *   - the agent exists on the AiFlow team roster.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API
 * use. Dry-run by default; idempotent (won't create a 2nd flow with the same
 * name unless --force). --apply records to the applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-spoke-check-aiflow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-clever-spoke-check-aiflow.ts --apply    # insert (disabled)
 *   npx tsx scripts/oneshot/seed-clever-spoke-check-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_CLEVER_AGENT_NAME         (default "Dave Lane")
 *   AIFLOW_CLEVER_INTEGRATION_LABEL  (default "Clever")
 *   AIFLOW_CLEVER_OFFICE_NAME        (default "Amy Laidlaw's office")
 *   AIFLOW_CLEVER_CALL_ATTEMPTS      (default 8, max 8)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
const { buildSpokeCheckDefinition } = await import("./clever-spoke-check-definition.ts");

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
  const agentName = process.env.AIFLOW_CLEVER_AGENT_NAME ?? "Dave Lane";
  const attempts = Math.min(
    Math.max(Number(process.env.AIFLOW_CLEVER_CALL_ATTEMPTS ?? "8") || 8, 1),
    8
  );

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Resolve the agent to a roster row so the flow carries LIVE employee refs
  // (renumber/rename after seeding is picked up automatically).
  const { data: member, error: memberErr } = await db
    .from("ai_flow_team_members")
    .select("id,name,phone_e164,active")
    .eq("business_id", businessId)
    .ilike("name", agentName)
    .maybeSingle();
  if (memberErr) {
    console.error(`roster lookup failed: ${memberErr.message}`);
    process.exit(1);
  }
  if (!member) {
    console.error(
      `No roster member named "${agentName}" for business ${businessId} — add them on the Team page first.`
    );
    process.exit(2);
  }
  const roster = member as { id: string; name: string; phone_e164: string; active: boolean };
  if (!roster.active) {
    console.error(`Roster member "${roster.name}" is inactive — activate them first.`);
    process.exit(2);
  }

  const name = process.env.AIFLOW_SEED_NAME ?? "Clever - Spoke Check & Weekly Call Follow-Up";
  const definitionInput = buildSpokeCheckDefinition({
    agentName: roster.name,
    agentRef: { source: "employee", id: roster.id, label: roster.name },
    integrationLabel: process.env.AIFLOW_CLEVER_INTEGRATION_LABEL ?? "Clever",
    officeName: process.env.AIFLOW_CLEVER_OFFICE_NAME ?? "Amy Laidlaw's office",
    attempts
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
  console.log(`Agent    : ${roster.name} (${roster.phone_e164}, roster ${roster.id})`);
  console.log(`Attempts : ${attempts} weekly call(s)`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

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
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "seed-clever-spoke-check-aiflow.ts",
    businessId,
    details: { flow_id: data.id, flow_name: name, agent: roster.name, attempts }
  });
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
