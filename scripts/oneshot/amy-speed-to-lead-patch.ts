/**
 * amy-speed-to-lead-patch.ts: convert Amy Laidlaw's seller routing from
 * "pinned to Dave" to a three-way race, and make the reach ladder take
 * turns.
 *
 * What it changes, per flow (pure helpers in
 * amy-speed-to-lead-definition.ts; this file only reads, validates, writes,
 * and records):
 *
 *   Clever Lead - Accept       route -> agentNames trio; ai_call_1/2/3 gain
 *                              rotateFirst 2 (Dave and Gabby alternate
 *                              ringing first, Amy last resort) and the
 *                              summary follows whoever rang first.
 *   ReferralExchange Lead      route_seller + route_both -> agentNames trio,
 *                              fallback copy no longer blames Dave alone.
 *   New Lead Intake            route_seller + route_both -> same.
 *   HomeLight Referral         route gains Gabrielle beside Dave and Amy.
 *   Clever - Spoke Check       spoke_check retargets to whoever claimed the
 *                              lead (agentNameVar from the owner_assigned
 *                              notice); templates neutralized.
 *
 * REQUIRES the reach-rotation engine PR deployed first: a worker that does
 * not know notifyFirstReachTarget fails a notifyRef-less call step with
 * "no notify number configured".
 *
 * Dry-run by default; --apply writes. Each applied flow stores its ENTIRE
 * previous definition in applied_oneshots.details.previous_definition, and
 * --revert restores exactly that (per flow with --only), because there is
 * no flow-version table to lean on.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-speed-to-lead-patch.ts                       # dry-run, all flows
 *   npx tsx scripts/oneshot/amy-speed-to-lead-patch.ts --only "HomeLight Referral" --apply
 *   npx tsx scripts/oneshot/amy-speed-to-lead-patch.ts --revert --only "HomeLight Referral" --apply
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";
import {
  AMY_NAME,
  DAVE_NAME,
  GABRIELLE_NAME,
  addBroadcastRecipient,
  addReachRotation,
  convertRouteToBroadcast,
  retargetSpokeCheck,
  type Ref
} from "./amy-speed-to-lead-definition";
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

type Definition = AiFlowDefinition;

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT_PATH = "scripts/oneshot/amy-speed-to-lead-patch.ts";

type Args = { apply: boolean; revert: boolean; businessId: string | null; only: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, revert: false, businessId: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    if (a === "--revert") args.revert = true;
    if (a === "--business-id") args.businessId = argv[i + 1] ?? null;
    if (a === "--only") args.only = argv[i + 1] ?? null;
  }
  return args;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

type RosterRow = {
  id: string;
  name: string;
  active: boolean;
  phone_e164: string | null;
  named_broadcast_enabled: boolean | null;
  named_routing_enabled: boolean | null;
};

/**
 * Resolve the trio and print their availability toggles. Hard requirements:
 * exactly one ACTIVE row per name, each with a phone, each with
 * named_broadcast_enabled (the offers are agentNames broadcasts; a false
 * here silently drops that person from every race). named_routing_enabled
 * only degrades the spoke-check pin to owner fallback, so it warns.
 */
async function resolveTrio(
  // Loosely typed like the sibling patch scripts: the generic default of
  // createClient does not unify across call sites.
  db: any,
  businessId: string
): Promise<{ dave: Ref; gabby: Ref; amy: Ref }> {
  const wanted = [DAVE_NAME, GABRIELLE_NAME, AMY_NAME];
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id, name, active, phone_e164, named_broadcast_enabled, named_routing_enabled")
    .eq("business_id", businessId)
    .in("name", wanted);
  if (error) throw new Error(`roster read failed: ${error.message}`);
  const rows = (data ?? []) as RosterRow[];
  const out: Record<string, Ref> = {};
  console.log("\nRoster pre-flight:");
  for (const name of wanted) {
    const matches = rows.filter((r) => r.name === name && r.active);
    if (matches.length !== 1) {
      throw new Error(`expected exactly one ACTIVE roster member named "${name}", found ${matches.length}`);
    }
    const row = matches[0];
    if (!row.phone_e164) throw new Error(`roster member "${name}" has no phone`);
    // Only an explicit false excludes in the engine; null means available.
    if (row.named_broadcast_enabled === false) {
      throw new Error(
        `roster member "${name}" has named_broadcast_enabled=false; the three-way offer would silently skip them. Fix the roster first.`
      );
    }
    if (row.named_routing_enabled === false) {
      console.warn(
        `  WARN: "${name}" has named_routing_enabled=false; a spoke check pinned to them falls to owner fallback.`
      );
    }
    console.log(
      `  ${name}: phone=${row.phone_e164} named_broadcast=${row.named_broadcast_enabled} named_routing=${row.named_routing_enabled}`
    );
    out[name] = { id: row.id, label: row.name, source: "employee" };
  }
  return { dave: out[DAVE_NAME], gabby: out[GABRIELLE_NAME], amy: out[AMY_NAME] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId = args.businessId ?? DEFAULT_BUSINESS_ID;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (args.revert) {
    await revert(db, businessId, args);
    return;
  }

  const trio = await resolveTrio(db, businessId);

  const plans: { flowName: string; patch: (def: Definition) => Record<string, boolean> }[] = [
    {
      flowName: "HomeLight Referral",
      patch: (def) => ({
        gabrielle_added: addBroadcastRecipient(def, "route", GABRIELLE_NAME)
      })
    },
    {
      flowName: "Clever Lead - Accept",
      patch: (def) => ({
        broadcast: convertRouteToBroadcast(def, "route"),
        reach_rotation: addReachRotation(def, trio)
      })
    },
    {
      flowName: "ReferralExchange Lead",
      patch: (def) => ({
        broadcast_seller: convertRouteToBroadcast(def, "route_seller"),
        broadcast_both: convertRouteToBroadcast(def, "route_both")
      })
    },
    {
      flowName: "New Lead Intake",
      patch: (def) => ({
        broadcast_seller: convertRouteToBroadcast(def, "route_seller"),
        broadcast_both: convertRouteToBroadcast(def, "route_both")
      })
    },
    {
      flowName: "Clever - Spoke Check & Weekly Call Follow-Up",
      patch: (def) => ({ spoke_check_retargeted: retargetSpokeCheck(def) })
    }
  ];

  for (const plan of plans) {
    if (args.only && plan.flowName !== args.only) continue;
    const { data: row, error } = await db
      .from("ai_flows")
      .select("id, name, definition, enabled")
      .eq("business_id", businessId)
      .eq("name", plan.flowName)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for "${plan.flowName}": ${error.message}`);
      process.exit(1);
    }
    if (!row) {
      console.error(`Flow "${plan.flowName}" not found for business ${businessId}.`);
      process.exit(2);
    }
    const flow = row as { id: string; name: string; definition: Definition; enabled: boolean };
    const previous = JSON.parse(JSON.stringify(flow.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;

    const results = plan.patch(def);
    const changed = Object.values(results).some(Boolean);

    console.log(`\n=== ${flow.name} (${flow.id}) enabled=${flow.enabled} ===`);
    for (const [k, v] of Object.entries(results)) {
      console.log(`  ${k.padEnd(24)}: ${v ? "yes" : "already"}`);
    }
    if (!changed) {
      console.log("  nothing to do.");
      continue;
    }

    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`Patched "${flow.name}" would become INVALID, aborting before any write:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    console.log(`\nAFTER: ${JSON.stringify(def)}`);
    if (!args.apply) {
      console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
      continue;
    }
    const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
    if (upErr) {
      console.error(`Update failed for ${flow.id}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: SCRIPT_PATH,
      businessId,
      details: {
        flow_id: flow.id,
        flow_name: flow.name,
        ...results,
        previous_definition: previous
      }
    });
  }
}

/** Restore the previous_definition stored by the newest apply for each flow. */
async function revert(
  db: any,
  businessId: string,
  args: Args
): Promise<void> {
  const { data, error } = await db
    .from("applied_oneshots")
    .select("id, details, applied_at")
    .eq("business_id", businessId)
    // The ledger stores the script BASENAME (recordOneshotApplied normalizes
    // it); there is no script_path column, and filtering on one made every
    // --revert exit 1 on a PostgREST "column does not exist" error.
    .eq("script", basename(SCRIPT_PATH))
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as { id: string; details: Record<string, unknown> }[];
  const newestPerFlow = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const name = String(r.details?.flow_name ?? "");
    if (!name || r.details?.reverted === true || !r.details?.previous_definition) continue;
    if (!newestPerFlow.has(name)) newestPerFlow.set(name, r.details);
  }
  if (newestPerFlow.size === 0) {
    console.error("No applied ledger rows with a previous_definition to revert to.");
    process.exit(2);
  }
  for (const [flowName, details] of newestPerFlow) {
    if (args.only && flowName !== args.only) continue;
    const flowId = String(details.flow_id);
    const prev = details.previous_definition as Definition;
    console.log(`\n=== revert ${flowName} (${flowId}) to ${prev.steps?.length} trunk steps ===`);
    if (!args.apply) {
      console.log("[dry-run] Not writing. Re-run with --revert --apply to write.");
      continue;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: prev })
      .eq("id", flowId)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Revert failed for ${flowId}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    await recordOneshotApplied(db, {
      scriptPath: SCRIPT_PATH,
      businessId,
      details: { flow_id: flowId, flow_name: flowName, reverted: true }
    });
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers in the definition module).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
