#!/usr/bin/env tsx
/**
 * One-shot: point Amy's HomeLight browse steps at the renamed credential.
 *
 * INCIDENT, 2026-08-17 06:26 UTC. Amy's `custom_integrations` row was renamed
 * from "Home Light" to "HomeLight" (Brian: "HomeLight no space is correct").
 * All ten live browse steps still asked for "Home Light" (seven on the
 * trunk, three inside branch arms).
 * `getCustomIntegrationByLabel` matches with `ilike` on the trimmed label, so
 * it forgives case but not the space: the lookup returned nothing,
 * `/api/integrations/custom/credentials` answered `integration_not_found`, the
 * render service turned that into `auth_config_error`, and the worker treats
 * that kind as PERMANENT (see the `kind === "login"` arm in
 * ai-flow-worker/index.ts). So the next HomeLight referral would have hard
 * failed at step 2 (`open`): no portal read, no claim, no route to the team,
 * and HomeLight reassigns an unanswered referral within minutes.
 *
 * No runs fired between the rename and this fix, so nothing was lost.
 *
 * WHAT THIS DOES. Rewrites `auth.integrationLabel` "Home Light" -> "HomeLight"
 * on every step of every flow for the business, branch arms included. It is
 * label-scoped, not flow-scoped, so a HomeLight step living in some other flow
 * is caught too; the pre-flight prints every flow and step id it will touch.
 *
 * IDEMPOTENT: a second run finds nothing to change and exits 0 without writing.
 * REVERSIBLE: `--revert --apply` restores each flow's exact previous definition
 * from the ledger, the same mechanism the other Amy appliers use.
 *
 * WHY NOT JUST RENAME THE ROW BACK: that was the faster fix and Brian chose
 * this direction deliberately, because "HomeLight" is the correct product
 * spelling. The cost of this direction is that the seed had to move with it:
 * `seed-homelight-lead-aiflow.ts` defaulted to "Home Light", so a re-seed would
 * have recreated the outage. Its default and header are corrected in the same
 * PR.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-homelight-integration-label.ts            # dry run
 *   npx tsx scripts/oneshot/amy-homelight-integration-label.ts --apply
 *   npx tsx scripts/oneshot/amy-homelight-integration-label.ts --revert --apply
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
import {
  NEW_LABEL,
  OLD_LABEL,
  integrationLabelsIn,
  relabelIntegration
} from "./amy-homelight-integration-label-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "amy-homelight-integration-label.ts";

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

type FlowRow = { id: string; name: string; definition: AiFlowDefinition };

/** Restore each flow's stored previous definition from the ledger. */
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
  const flows = (row.details as { flows: Array<{ id: string; name: string; previous: AiFlowDefinition }> })
    .flows;
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const businessId = argValue("business-id", DEFAULT_BUSINESS_ID);
  const from = argValue("from", OLD_LABEL);
  const to = argValue("to", NEW_LABEL);

  const db = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  if (isRevert) return await revert(db, businessId, apply);

  // Pre-flight: prove the target credential actually exists under the new
  // spelling before repointing anything at it. Repointing ten live steps at a
  // label with no row would swap one outage for an identical one.
  const { data: integrations, error: intErr } = await db
    .from("custom_integrations")
    .select("label,is_active,secret_encrypted")
    .eq("business_id", businessId);
  if (intErr) {
    console.error(`custom_integrations read failed: ${intErr.message}`);
    process.exit(1);
  }
  const target = (integrations ?? []).find(
    (r) => String(r.label).trim().toLowerCase() === to.trim().toLowerCase()
  );
  if (!target) {
    console.error(
      `No custom_integrations row labelled "${to}" for ${businessId}. ` +
        `Present: ${(integrations ?? []).map((r) => `"${r.label}"`).join(", ") || "(none)"}`
    );
    process.exit(2);
  }
  if (!target.is_active) {
    console.error(`Integration "${to}" exists but is_active=false; activate it first.`);
    process.exit(2);
  }
  if (!target.secret_encrypted) {
    console.error(`Integration "${to}" has no stored secret; set it before repointing flows.`);
    process.exit(2);
  }
  console.log(`Credential "${to}": present, active, secret stored.`);

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as FlowRow[];

  const touched: Array<{ id: string; name: string; previous: AiFlowDefinition; steps: string[] }> = [];
  const updates: Array<{ id: string; name: string; definition: AiFlowDefinition }> = [];

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as AiFlowDefinition;
    const next = JSON.parse(JSON.stringify(row.definition)) as AiFlowDefinition;
    const changed = relabelIntegration(next, from, to);
    if (changed.length === 0) continue;

    // Validate before any write: a definition the authoring validator rejects
    // must never reach a live row.
    try {
      parseAiFlowDefinition(next);
    } catch (err) {
      console.error(`"${row.name}" would become INVALID, aborting before any write:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }
    touched.push({ id: row.id, name: row.name, previous, steps: changed });
    updates.push({ id: row.id, name: row.name, definition: next });
  }

  if (touched.length === 0) {
    console.log(`\nNo step references "${from}". Nothing to do (already applied).`);
    const labels = [...new Set(rows.flatMap((r) => integrationLabelsIn(r.definition)))].sort();
    console.log(`Labels in use: ${labels.map((l) => `"${l}"`).join(", ")}`);
    return;
  }

  console.log(`\nRepointing "${from}" -> "${to}" on ${touched.length} flow(s):`);
  for (const t of touched) {
    console.log(`  ${t.name} (${t.id})`);
    console.log(`    steps: ${t.steps.join(", ")}`);
  }
  const total = touched.reduce((n, t) => n + t.steps.length, 0);
  console.log(`  ${total} step(s) total.`);

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  for (const u of updates) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: u.definition })
      .eq("id", u.id);
    if (upErr) {
      console.error(`Update of ${u.name} failed: ${upErr.message}`);
      process.exit(1);
    }
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      from,
      to,
      step_count: total,
      flows: touched.map((t) => ({ id: t.id, name: t.name, steps: t.steps, previous: t.previous }))
    }
  });
  console.log(`\nUpdated ${total} step(s) across ${updates.length} flow(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
