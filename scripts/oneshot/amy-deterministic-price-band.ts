#!/usr/bin/env tsx
/**
 * One-shot: the $1M price band becomes arithmetic, not an extraction's
 * opinion.
 *
 * Corinna Bennett, 2026-08-13 (run 36f319be): a ReferralExchange seller's
 * page was read as price "$613K" AND price_band "over_1m" IN THE SAME
 * extraction call. The number was right; the judgment about the number was
 * wrong, and three gates keyed on the judgment, so one flake silenced
 * everything at once:
 *
 *   - the AI call never went out (gated `price_band == under_1m`),
 *   - the team never saw an offer (ownerDirectWhen kept it for Amy as a
 *     "HIGH-VALUE $1M+" lead, and she did not acknowledge two reminders),
 *   - the unclaimed takeover skipped it (its arm required under_1m).
 *
 * An audit of 118 recent runs with a parseable price found exactly this one
 * mismatch: rare, but the failure mode lands on the single path with no
 * recovery. The fix is to stop asking a model to do a comparison:
 *
 *   1. Each reader gains `price_digits` (the price as bare digits, "0" when
 *      none is given): extracting ONE number is the easy half the model
 *      already got right.
 *   2. A `math` step (the new `less_than` operation) computes
 *      `price_under_1m` = "yes" | "no" | "not_a_number", deterministically.
 *   3. Every gate that keyed on `price_band` now keys on the computed var,
 *      failing the same safe way the original descriptions intended:
 *        - AI-call gates: `price_under_1m notEquals "no"` (unknown or
 *          unparseable price still gets the call, matching "no price shown →
 *          under_1m"),
 *        - ownerDirectWhen: `price_under_1m equals "no"` (only a PROVEN $1M+
 *          is kept from the team),
 *        - the takeover's band arm: `notEquals "no"` (only a proven $1M+ is
 *          excluded from the takeover).
 *
 * The `price_band` extraction FIELD stays (nothing gates on it any more;
 * removing it would churn templates for no behavioral gain), and so does
 * `price_gate`: its seller-scoping half is inherently an extraction, and its
 * failure modes were already designed to degrade toward the team.
 *
 * Read-modify-write against the LIVE definitions, validated through
 * parseAiFlowDefinition, idempotent, dry-run by default, `--revert` restores
 * from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-deterministic-price-band.ts            # dry run
 *   npx tsx scripts/oneshot/amy-deterministic-price-band.ts --apply
 *   npx tsx scripts/oneshot/amy-deterministic-price-band.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStepDeep, type Definition } from "./amy-under-500k-ai-owned";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-deterministic-price-band.ts";

type Step = Record<string, unknown>;

export const PRICE_DIGITS_FIELD = {
  name: "price_digits",
  description:
    "The price, home value, or budget as BARE DIGITS with no symbols, commas, letters, or " +
    "words (e.g. 613000 for $613K, 1200000 for $1.2M). If no price or value is given " +
    "anywhere, answer exactly: 0"
};

export const UNDER_1M_VAR = "price_under_1m";

/** The gate shapes, in one place so tests and patchers cannot drift. */
export const CALL_GATE = { var: UNDER_1M_VAR, notEquals: "no" };
export const OWNER_DIRECT_GATE = { var: UNDER_1M_VAR, equals: "no" };

/** Add price_digits to a reader and the compute step right after it. */
export function addComputedBand(def: Definition, readerId: string, mathId: string): string[] {
  const notes: string[] = [];
  const reader = findStepDeep(def.steps, readerId);
  if (!reader) throw new Error(`reader ${readerId} not found; aborting rather than guessing`);
  const fields = reader.fields as Array<{ name: string; description?: string }> | undefined;
  if (!Array.isArray(fields)) throw new Error(`reader ${readerId} has no fields array`);
  const existing = fields.find((f) => f.name === PRICE_DIGITS_FIELD.name);
  if (!existing) {
    fields.push({ ...PRICE_DIGITS_FIELD });
    notes.push(`${readerId}: price_digits field`);
  } else if (existing.description !== PRICE_DIGITS_FIELD.description) {
    existing.description = PRICE_DIGITS_FIELD.description;
    notes.push(`${readerId}: price_digits description updated`);
  }
  if (!findStepDeep(def.steps, mathId)) {
    const steps = def.steps ?? [];
    const idx = steps.findIndex((s) => s.id === readerId);
    if (idx < 0) throw new Error(`reader ${readerId} is not top-level; aborting`);
    steps.splice(idx + 1, 0, {
      id: mathId,
      type: "math",
      operation: "less_than",
      left: `{{vars.${PRICE_DIGITS_FIELD.name}}}`,
      right: "1000000",
      saveAs: UNDER_1M_VAR
    });
    notes.push(`${mathId}: ${UNDER_1M_VAR} computed, not extracted`);
  }
  return notes;
}

/** Swap a step's `when` from the extracted band to the computed call gate. */
export function rewireCallGate(def: Definition, stepId: string, notes: string[]): void {
  const step = findStepDeep(def.steps, stepId);
  if (!step) throw new Error(`call step ${stepId} not found; aborting rather than guessing`);
  const cur = step.when as { var?: string; equals?: string; notEquals?: string } | undefined;
  if (cur && cur.var === CALL_GATE.var && cur.notEquals === CALL_GATE.notEquals) return;
  if (!cur || cur.var !== "price_band" || cur.equals !== "under_1m") {
    throw new Error(`call step ${stepId} has an unexpected when guard; aborting`);
  }
  step.when = { ...CALL_GATE };
  notes.push(`${stepId}: call gate now computed`);
}

/** Swap a route's ownerDirectWhen from the extracted band to the computed gate. */
export function rewireOwnerDirect(def: Definition, routeId: string, notes: string[]): void {
  const step = findStepDeep(def.steps, routeId);
  if (!step || step.type !== "route_to_team") {
    throw new Error(`route ${routeId} not found; aborting rather than guessing`);
  }
  const cur = step.ownerDirectWhen as { var?: string; equals?: string } | undefined;
  if (!cur) return; // no owner-direct on this route: nothing to rewire
  if (cur.var === OWNER_DIRECT_GATE.var && cur.equals === OWNER_DIRECT_GATE.equals) return;
  if (cur.var !== "price_band" || cur.equals !== "over_1m") {
    throw new Error(`route ${routeId} ownerDirectWhen is unexpected; aborting`);
  }
  step.ownerDirectWhen = { ...OWNER_DIRECT_GATE };
  notes.push(`${routeId}: owner-direct now requires a PROVEN $1M+`);
}

/** Swap the live takeover branch's band arm to the computed gate. */
export function rewireTakeoverArm(def: Definition, prefix: string, notes: string[]): void {
  const branch = findStepDeep(def.steps, `${prefix}_team_unclaimed`);
  if (!branch) throw new Error(`${prefix}_team_unclaimed not found; aborting`);
  const arm = (branch.branches as Array<{ id?: string; condition?: Record<string, unknown> }>)?.find(
    (a) => a.id === `${prefix}_tu_open`
  );
  if (!arm) throw new Error(`${prefix}_tu_open arm not found; aborting`);
  const cur = arm.condition as { var?: string; equals?: string; notEquals?: string };
  if (cur.var === UNDER_1M_VAR && cur.notEquals === "no") return;
  if (cur.var !== "price_band" || cur.equals !== "under_1m") {
    throw new Error(`${prefix}_tu_open condition is unexpected; aborting`);
  }
  arm.condition = { var: UNDER_1M_VAR, notEquals: "no" };
  notes.push(`${prefix}_tu_open: takeover excludes only a PROVEN $1M+`);
}

export type PatchResult = { changed: boolean; notes: string[] };

function result(notes: string[]): PatchResult {
  return { changed: notes.length > 0, notes };
}

export function patchClever(def: Definition): PatchResult {
  const notes = addComputedBand(def, "read_details", "clever_price_lt_1m");
  rewireCallGate(def, "ai_call_1", notes);
  rewireOwnerDirect(def, "route", notes);
  rewireTakeoverArm(def, "clever", notes);
  return result(notes);
}

export function patchReferralExchange(def: Definition): PatchResult {
  const notes = addComputedBand(def, "browse", "re_price_lt_1m");
  for (const id of ["ai_call_buyer", "ai_call_seller", "ai_call_both"]) {
    rewireCallGate(def, id, notes);
  }
  for (const id of ["route_buyer", "route_seller", "route_both"]) {
    rewireOwnerDirect(def, id, notes);
  }
  rewireTakeoverArm(def, "re", notes);
  return result(notes);
}

export function patchRealtor(def: Definition): PatchResult {
  const notes = addComputedBand(def, "s1", "rt_price_lt_1m");
  rewireOwnerDirect(def, "s4", notes);
  rewireTakeoverArm(def, "rt", notes);
  return result(notes);
}

export function patchNewLeadIntake(def: Definition): PatchResult {
  const notes = addComputedBand(def, "parse", "nli_price_lt_1m");
  for (const id of ["route_assigned", "route_buyer", "route_seller", "route_both"]) {
    rewireOwnerDirect(def, id, notes);
  }
  rewireTakeoverArm(def, "nli", notes);
  return result(notes);
}

export const PATCHERS: Record<string, (def: Definition) => PatchResult> = {
  "Clever Lead - Accept": patchClever,
  "ReferralExchange Lead": patchReferralExchange,
  "Realtor.com Lead": patchRealtor,
  "New Lead Intake": patchNewLeadIntake
};

/**
 * After patching, nothing may still GATE on the extracted band. Templates may
 * mention the var in copy; a `"var": "price_band"` in a when/condition is a
 * consumer this script missed and grounds to abort.
 */
export function assertNoBandGates(def: Definition, flowName: string): void {
  const hits: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(rec)) {
        if (
          (k === "when" || k === "condition" || k === "ownerDirectWhen") &&
          v &&
          typeof v === "object" &&
          (v as { var?: string }).var === "price_band"
        ) {
          hits.push(`${path}.${k}`);
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(def.steps ?? [], "steps");
  if (hits.length > 0) {
    throw new Error(`${flowName}: price_band still gates at ${hits.join(", ")}; aborting`);
  }
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (isRevert) {
    const { data: rows, error } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", basename(SCRIPT))
      .order("applied_at", { ascending: false });
    if (error) {
      console.error(`Ledger read failed: ${error.message}`);
      process.exit(1);
    }
    const newest = new Map<string, Record<string, unknown>>();
    for (const row of (rows ?? []) as Array<{ details: Record<string, unknown> | null }>) {
      const d = row.details;
      const name = String(d?.flow_name ?? "");
      if (!name || d?.reverted === true || !d?.previous_definition) continue;
      if (!newest.has(name)) newest.set(name, d!);
    }
    if (newest.size === 0) {
      console.error("No applied ledger rows with a previous_definition to revert to.");
      process.exit(2);
    }
    for (const [name, d] of newest) {
      console.log(`revert ${name} (${d.flow_id})`);
      if (!apply) continue;
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: d.previous_definition })
        .eq("id", String(d.flow_id))
        .eq("business_id", businessId);
      if (upErr) {
        console.error(`Revert failed for ${name}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> reverted.");
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? SCRIPT,
        businessId,
        details: { flow_id: d.flow_id, flow_name: name, reverted: true }
      });
    }
    if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }

  const names = Object.keys(PATCHERS);
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .in("name", names);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flows not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let res: PatchResult;
    try {
      res = PATCHERS[row.name]!(def);
      assertNoBandGates(def, row.name);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!res.changed) {
      console.log(`${row.name}: already correct, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      if (e instanceof AiFlowValidationError) {
        console.error(`${row.name}: patched definition INVALID, refusing to write:`);
        for (const issue of e.issues) console.error(`  - ${issue}`);
        process.exit(2);
      }
      throw e;
    }
    console.log(`${row.name}:`);
    for (const note of res.notes) console.log(`  ${note}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def })
      .eq("id", row.id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Write failed for ${row.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: {
        flow_id: row.id,
        flow_name: row.name,
        notes: res.notes,
        previous_definition: previous
      }
    });
  }
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
