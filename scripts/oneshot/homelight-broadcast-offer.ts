#!/usr/bin/env tsx
/**
 * One-shot: route the "HomeLight Referral" AiFlow to Amy AND Dave
 * simultaneously (broadcast offer, first "1" wins) instead of Dave only.
 *
 * Three idempotent edits:
 *   1. Roster: ensure "Amy Laidlaw" is an ACTIVE ai_flow_team_members row
 *      (broadcast recipients must be roster members — the claim machinery
 *      matches teammates by roster phone).
 *   2. The flow's route_to_team step: drop the single-agent pin
 *      (agentName "Dave Lane") for `agentNames: ["Dave Lane", "Amy Laidlaw"]`,
 *      append a "First to reply 1 gets it." line to the offer copy, and
 *      reword the owner fallback ("Dave didn't claim…" → "No one claimed…").
 *   3. The post-claim `to_agent` send_sms: un-pin it from Dave and address it
 *      to `{{vars.claimed_agent_phone}}` so WHOEVER claims gets the lead's
 *      contact card.
 *
 * The $1M+ keep-for-owner rule (ownerDirectWhen/starred alert/nudges) is
 * untouched — it still short-circuits before any offer.
 *
 * Requires the broadcast route_to_team engine support (same PR) deployed on
 * the ai-flow-worker + telnyx-sms-inbound BEFORE running with --apply: the
 * schema validates agentNames, and an old worker would find no pinned agent
 * and fall back to the owner on every lead.
 *
 * Validates the patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-broadcast-offer.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-broadcast-offer.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME       (default "HomeLight Referral")
 *           AIFLOW_BROADCAST_OWNER_NAME      (default "Amy Laidlaw")
 *           AIFLOW_BROADCAST_OWNER_PHONE     (default Amy's cell)
 *           AIFLOW_HOMELIGHT_AGENT_NAME      (default "Dave Lane")
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DEFAULT_OWNER_NAME = "Amy Laidlaw";
// Amy's cell — the same number business_telnyx_settings.forward_to_e164
// points at, so her broadcast offers land on the phone she already answers.
const DEFAULT_OWNER_PHONE = "+16026951142";
const DEFAULT_AGENT_NAME = "Dave Lane";

/** The simultaneity cue appended to the offer SMS (idempotency marker too). */
const FIRST_TO_CLAIM_LINE = "First to reply 1 gets it.";

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Patch the route step: single pin → broadcast pair, offer copy gains the
 * first-to-claim cue, owner fallback loses the "Dave didn't claim" wording.
 * Pure and idempotent (second run returns false).
 */
export function patchRouteToBroadcast(
  def: Definition,
  agentName: string,
  ownerName: string
): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "route_to_team") continue;
    // Only the Dave-pinned route step is rewritten; an already-broadcast (or
    // differently pinned) step is left alone.
    if (typeof step.agentName === "string" && step.agentName.trim() === agentName) {
      delete step.agentName;
      step.agentNames = [agentName, ownerName];
      changed = true;
    }
    const isOurBroadcast =
      Array.isArray(step.agentNames) &&
      step.agentNames.includes(agentName) &&
      step.agentNames.includes(ownerName);
    if (!isOurBroadcast) continue;
    if (typeof step.offerTemplate === "string" && !step.offerTemplate.includes(FIRST_TO_CLAIM_LINE)) {
      step.offerTemplate = `${step.offerTemplate}\n${FIRST_TO_CLAIM_LINE}`;
      changed = true;
    }
    if (
      typeof step.ownerFallbackTemplate === "string" &&
      /^Dave didn't claim/.test(step.ownerFallbackTemplate)
    ) {
      step.ownerFallbackTemplate = step.ownerFallbackTemplate.replace(
        /^Dave didn't claim/,
        "No one claimed"
      );
      changed = true;
    }
  }
  return changed;
}

/**
 * Re-address the post-claim contact-card SMS from the pinned agent to the
 * CLAIMER ({{vars.claimed_agent_phone}} is engine-provided after a claim).
 * Pure and idempotent.
 */
export function patchToAgentSmsToClaimer(def: Definition, agentName: string): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "send_sms") continue;
    if (typeof step.toAgentName !== "string" || step.toAgentName.trim() !== agentName) continue;
    delete step.toAgentName;
    step.to = "{{vars.claimed_agent_phone}}";
    changed = true;
  }
  return changed;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/** Ensure the owner is an active roster member. Returns what happened. */
async function ensureRosterMember(
  db: SupabaseClient,
  businessId: string,
  name: string,
  phoneE164: string,
  apply: boolean
): Promise<"exists" | "reactivated" | "inserted"> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id, name, phone_e164, active")
    .eq("business_id", businessId);
  if (error) {
    console.error(`Roster read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as { id: string; name: string; phone_e164: string; active: boolean }[];
  const existing = rows.find(
    (r) => r.name.trim().toLowerCase() === name.trim().toLowerCase() || r.phone_e164 === phoneE164
  );
  if (existing && existing.active) return "exists";
  if (existing) {
    if (apply) {
      const { error: upErr } = await db
        .from("ai_flow_team_members")
        .update({ active: true })
        .eq("id", existing.id);
      if (upErr) {
        console.error(`Roster reactivate failed: ${upErr.message}`);
        process.exit(1);
      }
    }
    return "reactivated";
  }
  if (apply) {
    const { error: insErr } = await db
      .from("ai_flow_team_members")
      .insert({ business_id: businessId, name, phone_e164: phoneE164, active: true });
    if (insErr) {
      console.error(`Roster insert failed: ${insErr.message}`);
      process.exit(1);
    }
  }
  return "inserted";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const ownerName = process.env.AIFLOW_BROADCAST_OWNER_NAME ?? DEFAULT_OWNER_NAME;
  const ownerPhone = process.env.AIFLOW_BROADCAST_OWNER_PHONE ?? DEFAULT_OWNER_PHONE;
  const agentName = process.env.AIFLOW_HOMELIGHT_AGENT_NAME ?? DEFAULT_AGENT_NAME;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Roster: the broadcast can only offer roster members.
  const rosterOutcome = await ensureRosterMember(db, businessId, ownerName, ownerPhone, args.apply);
  console.log(
    `Roster: ${ownerName} ${rosterOutcome}${args.apply ? "" : " [dry-run: not written]"}`
  );

  // 2 + 3. Patch the flow.
  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(`Flow read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`Flow "${flowName}" not found for business ${businessId}.`);
    process.exit(2);
  }
  const flow = row as { id: string; name: string; definition: Definition };
  const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;
  const before = JSON.stringify(flow.definition);

  const routePatched = patchRouteToBroadcast(def, agentName, ownerName);
  const smsPatched = patchToAgentSmsToClaimer(def, agentName);
  if (!routePatched && !smsPatched) {
    console.log("Flow already patched — nothing to do.");
    return;
  }

  // Re-validate exactly like the dashboard/CRUD path before any write.
  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`Patched "${flow.name}" would become INVALID — aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`\n=== ${flow.name} (${flow.id}) ===`);
  console.log(`  route -> broadcast [${agentName}, ${ownerName}]: ${routePatched ? "patched" : "already"}`);
  console.log(`  to_agent SMS -> claimer: ${smsPatched ? "patched" : "already"}`);
  console.log(`  BEFORE: ${before}`);
  console.log(`  AFTER : ${JSON.stringify(def)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update failed for ${flow.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-broadcast-offer.ts",
    businessId,
    details: {
      flow_id: flow.id,
      flow_name: flow.name,
      roster: rosterOutcome,
      route_patched: routePatched,
      to_agent_patched: smsPatched
    }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
