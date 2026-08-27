#!/usr/bin/env tsx
/**
 * One-shot: seed (or update) Amy Laidlaw's "Needs Follow Up" cadence flow.
 *
 * The definition is built by amy-needs-follow-up-definition.ts, which carries
 * the reasoning; this file only reads, validates, writes and records.
 *
 * Idempotent by NAME: a re-run replaces the definition of the existing flow
 * rather than seeding a second one, which is what stops a lead being enrolled
 * in two cadences.
 *
 * ORDERING when the write introduces a var the templates read (as the
 * two-var site scheme did, 2026-08-27): run the matching parked-run heal
 * FIRST (amy-heal-parked-cadence-lead-site.ts), so no in-flight run meets a
 * template whose var it never extracted.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-amy-needs-follow-up-aiflow.ts          # dry run
 *   npx tsx scripts/oneshot/seed-amy-needs-follow-up-aiflow.ts --apply
 *
 * Exit codes: 0 seeded/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { buildNeedsFollowUpDefinition, FOLLOW_UP_TAG } from "./amy-needs-follow-up-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
export const FLOW_NAME = "Needs Follow Up (AI cadence)";

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const definition = buildNeedsFollowUpDefinition();
  try {
    parseAiFlowDefinition(definition);
  } catch (e) {
    console.error("Definition is INVALID, refusing to write:");
    if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
    else console.error(e);
    process.exit(2);
  }
  const steps = (definition as { steps: unknown[] }).steps;
  console.log(`${FLOW_NAME}: ${steps.length} steps, trigger tag "${FOLLOW_UP_TAG}"`);

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled")
    .eq("business_id", businessId)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const existing = data as { id: string; enabled: boolean } | null;
  console.log(existing ? `  updating existing flow ${existing.id}` : "  seeding a new flow");

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  if (existing) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition, enabled: true })
      .eq("id", existing.id);
    if (upErr) {
      console.error(`Update failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "seed-amy-needs-follow-up-aiflow.ts",
      businessId,
      details: { flow_id: existing.id, flow_name: FLOW_NAME, updated: true }
    });
    return;
  }
  const { data: ins, error: insErr } = await db
    .from("ai_flows")
    .insert({ business_id: businessId, name: FLOW_NAME, definition, enabled: true })
    .select("id")
    .maybeSingle();
  if (insErr) {
    console.error(`Insert failed: ${insErr.message}`);
    process.exit(1);
  }
  const flowId = (ins as { id: string } | null)?.id ?? "";
  console.log(`  -> seeded ${flowId}.`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "seed-amy-needs-follow-up-aiflow.ts",
    businessId,
    details: { flow_id: flowId, flow_name: FLOW_NAME, seeded: true, tag: FOLLOW_UP_TAG }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
