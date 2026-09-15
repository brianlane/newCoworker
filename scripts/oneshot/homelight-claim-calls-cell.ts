#!/usr/bin/env tsx
/**
 * One-shot: when HomeLight will ring a teammate's cell, alert them instead
 * of waiting on the AI DID, and keep open's already_claimed read.
 *
 * INCIDENT, 2026-09-15, Arletta L. run 61550503. See
 * homelight-claim-calls-cell-definition.ts for the write-up.
 *
 * Idempotent, validated through parseAiFlowDefinition before writing, REFUSES
 * when the live copy is not what it was written against, dry-run by default,
 * ledger-recorded with the previous definition stored for `--revert`. Parked
 * runs re-anchor by `__resume_step_id`; apply refuses in-flight runs that
 * lack that marker or are parked on a step whose meaning moved (`--force`
 * overrides).
 *
 * Usage:
 *   npx tsx scripts/oneshot/homelight-claim-calls-cell.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-claim-calls-cell.ts --apply
 *   npx tsx scripts/oneshot/homelight-claim-calls-cell.ts --revert --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched / no-op / dry-run, 1 Supabase error, 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger";
import {
  CALLBACK_GATE_ID,
  SHIFT_UNSAFE_RESUME_IDS,
  patchDefinition,
  type Definition
} from "./homelight-claim-calls-cell-definition";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "homelight-claim-calls-cell.ts";
const FLOW_NAME = "HomeLight Referral";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
  "awaiting_reply",
  "awaiting_call"
] as const;

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback ?? "";
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
}

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

type FlowRow = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };

async function revert(db: SupabaseClient, businessId: string, apply: boolean): Promise<void> {
  const { data, error } = await db
    .from("applied_oneshots")
    .select("details,applied_at")
    .eq("business_id", businessId)
    .eq("script", SCRIPT)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const row = (data ?? []).find(
    (r) =>
      (r.details as { reverted?: boolean } | null)?.reverted !== true &&
      Array.isArray((r.details as { flows?: unknown[] } | null)?.flows)
  );
  if (!row) {
    console.error("No revertible ledger entry for this script and business.");
    process.exit(2);
  }
  const flows = (
    row.details as { flows: Array<{ id: string; name: string; previous: AiFlowDefinition }> }
  ).flows;
  console.log(`Reverting ${flows.length} flow(s) to the definitions stored ${row.applied_at}:`);
  for (const f of flows) console.log(`  ${f.name} (${f.id})`);
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }
  for (const f of flows) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: f.previous })
      .eq("id", f.id);
    if (upErr) {
      console.error(`Revert of ${f.name} failed: ${upErr.message}`);
      process.exit(1);
    }
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: { reverted: true, flow_ids: flows.map((f) => f.id) }
  });
  console.log("\nReverted.");
}

function pickFlow(rows: readonly FlowRow[], name: string): FlowRow {
  const matches = rows.filter((r) => r.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) {
    console.error(
      `Expected exactly one flow named "${name}", found ${matches.length}. ` +
        `Flows present: ${rows
          .filter((r) => /homelight/i.test(r.name))
          .map((r) => `"${r.name}"`)
          .join(", ")}`
    );
    process.exit(2);
  }
  return matches[0];
}

async function loadInFlight(
  db: SupabaseClient,
  flowId: string
): Promise<Array<{ id: string; status: string; resume: string | null }>> {
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("id, status, context")
    .eq("flow_id", flowId)
    .in("status", [...ACTIVE_RUN_STATUSES]);
  if (error) {
    console.error(`Run check failed: ${error.message}`);
    process.exit(1);
  }
  return (
    (data ?? []) as Array<{
      id: string;
      status: string;
      context: { vars?: Record<string, unknown> } | null;
    }>
  ).map((r) => {
    const marker = r.context?.vars?.["__resume_step_id"];
    return {
      id: r.id,
      status: r.status,
      resume: typeof marker === "string" && marker.length > 0 ? marker : null
    };
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const force = process.argv.includes("--force");
  const businessId = argValue("business-id", DEFAULT_BUSINESS_ID);

  const db = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  if (isRevert) return await revert(db, businessId, apply);

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", businessId);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const flow = pickFlow((data ?? []) as FlowRow[], FLOW_NAME);
  if (!flow.enabled) {
    console.error(`"${flow.name}" (${flow.id}) is DISABLED. Enable it before or after applying.`);
  }

  const inFlight = await loadInFlight(db, flow.id);
  const unmarked = inFlight.filter((r) => r.resume === null);
  const unsafe = inFlight.filter(
    (r) => r.resume !== null && (SHIFT_UNSAFE_RESUME_IDS as readonly string[]).includes(r.resume)
  );
  if (inFlight.length > 0) {
    console.log(
      `${inFlight.length} run(s) in flight (${unmarked.length} without a resume marker, ` +
        `${unsafe.length} parked on a moved step).`
    );
    for (const r of inFlight) {
      console.log(`  ${r.id} ${r.status} resume=${r.resume ?? "(none)"}`);
    }
  }

  const previous = JSON.parse(JSON.stringify(flow.definition)) as AiFlowDefinition;
  const next = JSON.parse(JSON.stringify(flow.definition)) as Definition;
  let edits: string[];
  try {
    edits = patchDefinition(next);
  } catch (err) {
    console.error(
      `Unexpected shape for "${flow.name}" (${flow.id}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "The flow was rebuilt or renamed; re-read it before patching."
    );
    process.exit(2);
  }

  if (edits.length === 0) {
    console.log(`\n${CALLBACK_GATE_ID} already in place. Nothing to do (already applied).`);
    console.log(`Trunk: ${(flow.definition.steps ?? []).map((s) => s.id).join(" -> ")}`);
    return;
  }

  try {
    parseAiFlowDefinition(next);
  } catch (err) {
    console.error(`\n"${flow.name}" would become INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`\n${flow.name} (${flow.id})`);
  console.log(`Trunk ${flow.definition.steps.length} -> ${next.steps?.length}`);
  for (const e of edits) console.log(`  - ${e}`);
  console.log(`After: ${(next.steps ?? []).map((s) => s.id).join(" -> ")}`);

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  if ((unmarked.length > 0 || unsafe.length > 0) && !force) {
    const bits = [
      unmarked.length > 0
        ? `${unmarked.length} in-flight run(s) lack __resume_step_id: ${unmarked
            .map((r) => `${r.id} (${r.status})`)
            .join(", ")}`
        : "",
      unsafe.length > 0
        ? `${unsafe.length} in-flight run(s) are parked on a moved step: ${unsafe
            .map((r) => `${r.id} (${r.resume})`)
            .join(", ")}`
        : ""
    ].filter(Boolean);
    console.error(`Refusing to apply: ${bits.join("; ")}. Re-run after they settle, or --force.`);
    process.exit(2);
  }

  const { error: upErr } = await db.from("ai_flows").update({ definition: next }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update of ${flow.name} failed: ${upErr.message}`);
    process.exit(1);
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flows: [{ id: flow.id, name: flow.name, previous }]
    }
  });
  console.log("\nApplied.");
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
