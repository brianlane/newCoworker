/**
 * amy-seller-ai-call-patch.ts: put the AI's seller call ladder on Amy
 * Laidlaw's two seller lead sources, and sweep the callback-time capture
 * field her scripts forbid.
 *
 * What it changes, per flow (pure helpers in
 * amy-seller-ai-call-definition.ts; this file only reads, validates,
 * writes, and records):
 *
 *   Clever Lead - Accept      cash_offers extraction field; ai_call_1
 *                             before the route step; the nested follow-up
 *                             tree and the stop goal after it; the offer
 *                             templates gain the done/result/next block.
 *   ReferralExchange Lead     same ladder, seller-gated (call_gate wraps
 *                             attempt 1; the follow-up tree carries the
 *                             seller check as its when).
 *   New Lead Intake           "best time to reach them" removed from every
 *                             captureFields (Amy: never ask when to call
 *                             back).
 *
 * Dry-run by default; --apply writes. Each applied flow stores its ENTIRE
 * previous definition in applied_oneshots.details.previous_definition, and
 * --revert restores exactly that, because there is no flow-version table to
 * lean on.
 *
 * Usage:
 *   npx tsx scripts/oneshot/amy-seller-ai-call-patch.ts                      # dry-run, all flows
 *   npx tsx scripts/oneshot/amy-seller-ai-call-patch.ts --only "Clever Lead - Accept"
 *   npx tsx scripts/oneshot/amy-seller-ai-call-patch.ts --apply
 *   npx tsx scripts/oneshot/amy-seller-ai-call-patch.ts --revert --only "Clever Lead - Accept" --apply
 *
 * Requires deployed worker support for callWindow/waitMinutes and the
 * call-outcome companion vars (PRs #1211/#1227), which are live on main.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";
import {
  AMY_NAME,
  DAVE_NAME,
  addCashOffersField,
  addSellerCallLadder,
  removeBestTimeCaptureField,
  type Ref
} from "./amy-seller-ai-call-definition";
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

type Definition = AiFlowDefinition;

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

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

/**
 * Resolve a roster member to the {id, label, source} ref shape flow steps
 * store. By name, at apply time, from ai_flow_team_members: never a
 * hardcoded row id and never a bare name string (this account's dossier
 * lists that as a sharp edge).
 */
async function resolveEmployeeRef(
  db: any,
  businessId: string,
  name: string
): Promise<Ref> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id, name, active")
    .eq("business_id", businessId)
    .eq("name", name);
  if (error) throw new Error(`team member lookup failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; name: string; active: boolean }[];
  const active = rows.filter((r) => r.active);
  if (active.length !== 1) {
    throw new Error(
      `expected exactly one ACTIVE roster member named "${name}", found ${active.length}`
    );
  }
  return { id: active[0].id, label: active[0].name, source: "employee" };
}

const SCRIPT_PATH = "scripts/oneshot/amy-seller-ai-call-patch.ts";

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

  const dave = await resolveEmployeeRef(db, businessId, DAVE_NAME);
  // Amy is not dialed by any step yet (reach_teammate lands later), but
  // resolving her now fails fast if the roster changed under us.
  await resolveEmployeeRef(db, businessId, AMY_NAME);

  const plans: {
    flowName: string;
    patch: (def: Definition) => Record<string, boolean>;
  }[] = [
    {
      flowName: "Clever Lead - Accept",
      patch: (def) => ({
        cash_offers_field: addCashOffersField(def),
        ladder: addSellerCallLadder(def, "clever", { dave }, { routeStepId: "route" })
      })
    },
    {
      flowName: "ReferralExchange Lead",
      patch: (def) => ({
        ladder: addSellerCallLadder(
          def,
          "referral_exchange",
          { dave },
          {
            routeStepId: "route_seller",
            callGate: { var: "route_lead_type", equals: "seller" }
          }
        )
      })
    },
    {
      flowName: "New Lead Intake",
      patch: (def) => ({ best_time_capture_removed: removeBestTimeCaptureField(def) })
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
      console.log(`  ${k.padEnd(26)}: ${v ? "yes" : "already"}`);
    }
    console.log(`  trunk steps               : ${previous.steps.length} -> ${def.steps.length}`);
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
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def })
      .eq("id", flow.id);
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
        // The whole rollback story: there is no flow-version table, so the
        // ledger row carries the exact definition this write replaced.
        previous_definition: previous
      }
    });
  }
}

/**
 * Restore the previous_definition stored by the newest apply for each flow.
 * Reverts are themselves recorded, so the ledger tells the whole story.
 */
async function revert(
  db: any,
  businessId: string,
  args: Args
): Promise<void> {
  const { data, error } = await db
    .from("applied_oneshots")
    .select("id, details, applied_at")
    .eq("business_id", businessId)
    .eq("script_path", SCRIPT_PATH)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as { id: string; details: Record<string, unknown> }[];
  const newestPerFlow = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const name = String(r.details?.flow_name ?? "");
    // Skip our own revert records and rows without a stored definition.
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
    console.log(`\n=== revert ${flowName} (${flowId}) to ${prev.steps?.length} steps ===`);
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
