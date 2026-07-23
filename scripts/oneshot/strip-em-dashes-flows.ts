#!/usr/bin/env tsx
/**
 * One-shot: strip em dashes from a tenant's LIVE AiFlow copy (README
 * "Writing rule: NO EM DASHES, ever").
 *
 * Repo fixes cover code; this covers the templates already stored in the
 * ai_flows table, whose bodies land on customers' and teammates' phones
 * (Amy's ReferralExchange/HomeLight copy, seeded owner-direct alerts, ...).
 *
 * ONLY output-copy fields are patched (the allowlist below): message
 * bodies, subjects, offer/fallback/notify templates, prompts, and display
 * labels. Matcher fields are deliberately untouched; trigger `contains`
 * values, `matchTemplates`, `matchText`, `fromContains` and friends exist
 * to MATCH text customers or lead sources send, and recognizing an em dash
 * is not writing one.
 *
 * Every patched definition is re-validated through the SAME
 * parseAiFlowDefinition the dashboard uses before any write. Dry-run by
 * default (prints a per-field before/after diff); --apply writes and
 * records the run in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/strip-em-dashes-flows.ts              # dry run
 *   npx tsx scripts/oneshot/strip-em-dashes-flows.ts --apply      # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid result.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
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

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const EM_DASH = "\u2014";

/**
 * Step/object keys whose STRING values are output copy (sent, spoken, or
 * shown). Everything else (ids, var names, phone numbers, matcher fields,
 * conditions) is never touched.
 */
export const COPY_KEYS = new Set([
  "body",
  "message",
  "subject",
  "emailSubject",
  "offerTemplate",
  "ownerFallbackTemplate",
  "claimedNotifyTemplate",
  "ownerDirectTemplate",
  "promptTemplate",
  "question",
  "label",
  "description",
  "whisper",
  "greeting",
  "persona"
]);

/**
 * The README replacement policy: comma (or a hyphen/nothing at line edges)
 * instead of an em dash. A dash OPENING a line is a signature/list dash
 * ("— The Team" becomes "- The Team", never ", The Team"), and a dash
 * CLOSING a line is dropped, so the rewrite can never strand a comma at
 * either edge of a line.
 */
export function stripEmDashesFromCopy(value: string): string {
  return value
    .split("\n")
    .map((line) =>
      line
        // Leading signature/list dash.
        .replace(new RegExp(`^(\\s*)${EM_DASH}\\s*`), "$1- ")
        // Trailing dash carries no content: drop it.
        .replace(new RegExp(`\\s*${EM_DASH}\\s*$`), "")
        // Interior separators become commas.
        .replace(new RegExp(` ${EM_DASH} `, "g"), ", ")
        .replace(new RegExp(`${EM_DASH} `, "g"), ", ")
        .replace(new RegExp(` ${EM_DASH}`, "g"), ",")
        .replace(new RegExp(EM_DASH, "g"), ", ")
    )
    .join("\n");
}

export type PatchedField = { path: string; before: string; after: string };

/**
 * Recursively patch copy-key string values in place. Pure w.r.t. inputs
 * (callers pass a deep clone); returns the list of patched fields.
 */
export function patchCopyFields(node: unknown, path = ""): PatchedField[] {
  const patched: PatchedField[] = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      patched.push(...patchCopyFields(item, `${path}[${i}]`));
    });
    return patched;
  }
  if (node === null || typeof node !== "object") return patched;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = path ? `${path}.${key}` : key;
    if (typeof value === "string") {
      if (COPY_KEYS.has(key) && value.includes(EM_DASH)) {
        const after = stripEmDashesFromCopy(value);
        obj[key] = after;
        patched.push({ path: fieldPath, before: value, after });
      }
      continue;
    }
    // Never descend into trigger/conditions: matcher territory. (Copy keys
    // never live there, but being explicit keeps the intent readable.)
    if (key === "trigger" || key === "triggers" || key === "conditions") continue;
    patched.push(...patchCopyFields(value, fieldPath));
  }
  return patched;
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

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const flows = (data ?? []) as {
    id: string;
    name: string;
    enabled: boolean;
    definition: unknown;
  }[];
  console.log(`Business : ${businessId}`);
  console.log(`Flows    : ${flows.length}`);

  // Phase 1: compute and VALIDATE every patch before any write, so a flow
  // that would become invalid aborts the whole run with zero flows touched
  // (never a mixed half-patched tenant).
  const pending: {
    id: string;
    name: string;
    def: unknown;
    patched: PatchedField[];
  }[] = [];
  for (const flow of flows) {
    const def = JSON.parse(JSON.stringify(flow.definition)) as unknown;
    const patched = patchCopyFields(def);
    if (patched.length === 0) continue;

    // Re-validate exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`Patched "${flow.name}" would become INVALID; aborting before any write:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    console.log(`\n=== ${flow.name} (${flow.id}) enabled=${flow.enabled}`);
    for (const f of patched) {
      console.log(`  ${f.path}`);
      console.log(`    BEFORE: ${f.before.replace(/\n/g, "\\n").slice(0, 200)}`);
      console.log(`    AFTER : ${f.after.replace(/\n/g, "\\n").slice(0, 200)}`);
    }
    pending.push({ id: flow.id, name: flow.name, def, patched });
  }

  if (pending.length === 0) {
    console.log("\nNo em dashes in any flow's copy fields. Nothing to do.");
    return;
  }
  if (!args.apply) {
    console.log(
      `\n[dry-run] ${pending.length} flow(s) would be patched. Re-run with --apply to write.`
    );
    return;
  }

  // Phase 2: every patch validated, write them all. A write failure records
  // what DID land in the ledger before exiting, so a partial apply is
  // visible instead of silent.
  const written: { id: string; name: string; fields: number }[] = [];
  for (const p of pending) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: p.def })
      .eq("id", p.id);
    if (upErr) {
      console.error(`Update failed for ${p.id} ("${p.name}"): ${upErr.message}`);
      console.error(
        `${written.length} of ${pending.length} flow(s) were already updated; recording the partial apply in the ledger. Re-run to finish (idempotent).`
      );
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? "strip-em-dashes-flows.ts",
        businessId,
        details: { flows: written, partial: true, failed_flow_id: p.id }
      });
      process.exit(1);
    }
    console.log(`updated ${p.name} (${p.id})`);
    written.push({ id: p.id, name: p.name, fields: p.patched.length });
  }
  console.log(`\nPatched ${written.length} flow(s).`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "strip-em-dashes-flows.ts",
    businessId,
    details: { flows: written }
  });
}

// Run only when executed directly (not when imported by the unit test,
// which exercises the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
