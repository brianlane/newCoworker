#!/usr/bin/env tsx
/**
 * One-shot: rename the GATE fields whose names merely contain a phone token.
 *
 * Three live flows extract a routing token (buyer/seller/both, yes/no) into a
 * field whose NAME reads like a phone field: `phone_lead_type`, `has_phone`.
 * `isPhoneFieldName` matches on any phone token anywhere in the name, so PR
 * #885 (Jul 24 2026) started running `sanitizeExtractedPhone` over them and
 * rewrote every value to "none". On Amy's ReferralExchange flow that skipped
 * all three route_to_team steps: 11 leads were texted but never offered to her
 * team before it was caught.
 *
 * The engine fix (postProcessExtractedField: only validate a value that
 * actually looks like a phone attempt) is what repairs behavior, and it repairs
 * these flows without any edit here. This script removes the dependency on that
 * heuristic entirely, so the names stop inviting the same class of bug:
 *
 *   ReferralExchange Lead        phone_lead_type -> route_lead_type
 *   New Lead Intake              phone_lead_type -> sms_lead_type
 *   Booking confirmation - live  has_phone       -> lead_reachable
 *
 * Each rename rewrites the extraction field name AND every `when.var` that
 * references it (including guards nested inside branch arms). It also fixes the
 * ReferralExchange owner-notification copy, which asserted "Not routed due to
 * no phone" on leads that had just been texted at the very number it named.
 *
 * Idempotent: a flow already carrying the new name is reported and skipped.
 * Validates each patched definition through parseAiFlowDefinition before
 * writing, prints the previous definition for rollback, dry-run by default,
 * and records the apply in applied_oneshots.
 *
 * Deploy the engine fix BEFORE running this: on an old worker the new names are
 * simply not phone-named, so the values survive. This script is safe either
 * way, but the ordering keeps the two changes independent.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/rename-phone-named-gate-fields.ts           # dry run
 *   npx tsx scripts/oneshot/rename-phone-named-gate-fields.ts --apply   # write
 *   npx tsx scripts/oneshot/rename-phone-named-gate-fields.ts --only "New Lead Intake"
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business ids come from env so no tenant id is hard-coded here:
 *   AIFLOW_AMY_BUSINESS_ID, AIFLOW_KYP_BUSINESS_ID (or --business-id applies to all).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null; only: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else if (a === "--only") args.only = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * The owner notification on the ReferralExchange flow's no-phone arm. It states
 * a reason ("no phone") that the run itself disproves whenever the engine bug
 * fired, so it is corrected alongside the rename that prevents a recurrence.
 */
const RE_NOTIFY_NO_PHONE_ID = "notify_no_phone";
const RE_OLD_OUTCOME = "Outcome: Not routed due to no phone, so emailed directly.";
const RE_NEW_OUTCOME =
  "Outcome: No phone was listed for this lead, so we emailed instead of routing.";

type Rename = {
  /** Which tenant env var carries this flow's business id. */
  businessEnv: string;
  flowName: string;
  from: string;
  to: string;
  /** Applied after the rename; returns true when it changed something. */
  extraEdit?: (steps: Step[]) => boolean;
};

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Array<{ name?: string; description?: string }>;
  when?: { var?: string };
  branches?: Array<{ steps?: Step[]; condition?: { var?: string } }>;
  else?: Step[];
  message?: string;
};

export const RENAMES: readonly Rename[] = [
  {
    businessEnv: "AIFLOW_AMY_BUSINESS_ID",
    flowName: "ReferralExchange Lead",
    from: "phone_lead_type",
    to: "route_lead_type",
    extraEdit: (steps) => {
      let changed = false;
      for (const s of steps) {
        if (s.id !== RE_NOTIFY_NO_PHONE_ID || typeof s.message !== "string") continue;
        if (!s.message.includes(RE_OLD_OUTCOME)) continue;
        s.message = s.message.replace(RE_OLD_OUTCOME, RE_NEW_OUTCOME);
        changed = true;
      }
      return changed;
    }
  },
  {
    businessEnv: "AIFLOW_AMY_BUSINESS_ID",
    flowName: "New Lead Intake",
    from: "phone_lead_type",
    to: "sms_lead_type"
  },
  {
    businessEnv: "AIFLOW_KYP_BUSINESS_ID",
    // The em dash is the LIVE flow name's own character, not prose: this string
    // is the `ai_flows.name` lookup key and must match the row byte for byte.
    flowName: "Booking confirmation (SMS + email) — live",
    from: "has_phone",
    to: "lead_reachable"
  }
];

/**
 * Rewrite every occurrence of `from` in a step tree: the extraction field that
 * defines it, and each `when` / branch `condition` that reads it. Walks nested
 * branch arms, where most of the New Lead Intake guards live.
 */
export function renameVarInSteps(steps: Step[], from: string, to: string): number {
  let hits = 0;
  for (const s of steps) {
    for (const f of s.fields ?? []) {
      if (f.name === from) {
        f.name = to;
        hits++;
      }
    }
    if (s.when?.var === from) {
      s.when.var = to;
      hits++;
    }
    for (const b of s.branches ?? []) {
      if (b.condition?.var === from) {
        b.condition.var = to;
        hits++;
      }
      if (b.steps) hits += renameVarInSteps(b.steps, from, to);
    }
    if (s.else) hits += renameVarInSteps(s.else, from, to);
  }
  return hits;
}

/**
 * Templates read the var as {{vars.<name>}}. None of the three flows currently
 * interpolate these gate fields, but a rename that missed one would render an
 * empty string silently, so rewrite them rather than trusting today's shape.
 */
export function renameVarInTemplates(definition: unknown, from: string, to: string): unknown {
  const json = JSON.stringify(definition);
  const next = json.split(`{{vars.${from}}}`).join(`{{vars.${to}}}`);
  return JSON.parse(next);
}

function requireBusinessId(rename: Rename, override: string | null): string {
  const id = override ?? process.env[rename.businessEnv] ?? "";
  if (!id) {
    console.error(
      `Missing business id for "${rename.flowName}": set ${rename.businessEnv} or pass --business-id`
    );
    process.exit(2);
  }
  return id;
}

async function patchOne(
  db: SupabaseClient,
  rename: Rename,
  args: Args
): Promise<{ applied: boolean; flowId: string | null }> {
  const businessId = requireBusinessId(rename, args.businessId);
  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .eq("name", rename.flowName)
    .maybeSingle();
  if (error) {
    console.error(`Read failed for "${rename.flowName}": ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.log(`\n"${rename.flowName}": no such flow for ${businessId}. Skipping.`);
    return { applied: false, flowId: null };
  }

  console.log(`\n=== ${rename.flowName} (${row.id}, enabled=${row.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

  const withTemplates = renameVarInTemplates(row.definition, rename.from, rename.to) as {
    steps: Step[];
  };
  const hits = renameVarInSteps(withTemplates.steps ?? [], rename.from, rename.to);
  const extra = rename.extraEdit?.(withTemplates.steps ?? []) ?? false;

  if (hits === 0 && !extra) {
    console.log(`No "${rename.from}" references left. Already applied, nothing to do.`);
    return { applied: false, flowId: row.id };
  }

  let validated;
  try {
    validated = parseAiFlowDefinition(withTemplates);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Patched definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Patched definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Renamed ${rename.from} -> ${rename.to} in ${hits} place(s).`);
  if (extra) console.log("Corrected the no-phone outcome wording.");

  if (!args.apply) {
    console.log("[dry-run] Not writing. Re-run with --apply.");
    return { applied: false, flowId: row.id };
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId,
    details: { flowId: row.id, flowName: rename.flowName, from: rename.from, to: rename.to, hits }
  });
  console.log("Updated.");
  return { applied: true, flowId: row.id };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const targets = args.only
    ? RENAMES.filter((r) => r.flowName === args.only)
    : RENAMES.slice();
  if (targets.length === 0) {
    console.error(`--only "${args.only}" matched no configured flow`);
    process.exit(2);
  }

  let applied = 0;
  for (const rename of targets) {
    const res = await patchOne(db, rename, args);
    if (res.applied) applied++;
  }
  console.log(
    `\n${args.apply ? `Applied to ${applied} flow(s).` : "[dry-run] Re-run with --apply to write."}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
