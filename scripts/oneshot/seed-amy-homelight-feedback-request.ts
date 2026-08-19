#!/usr/bin/env tsx
/**
 * One-shot: seed the "HomeLight Update Request" AiFlow for a single tenant.
 *
 * HomeLight texts Amy from +1 415-549-1442 asking for referral feedback, and no
 * flow claims that number, so it falls through to the general assistant. On
 * 2026-08-07 that produced a 30-message robot loop over 16 minutes: our AI
 * answered HomeLight's autoresponder, addressed it as "Aaron", and kept going
 * until HomeLight's one-way replies ran out. PR #1239's robot-loop cap is the
 * only reason the Aug 13 nudge did not repeat it.
 *
 * This flow gives the number a named owner: extract the link and the counts,
 * text Amy, reply to nobody. It submits NOTHING to HomeLight, on purpose. The
 * prompt asks the agent to rate REFERRAL QUALITY, a subjective judgement that
 * shapes the referrals she is sent next, so a canned automated answer is worth
 * less to her than her own and could degrade her lead flow. The factual STAGE
 * update on the agent dashboard is a separate surface and is not touched here.
 *
 * The definition, the trigger needles and the reasoning live in
 * `amy-homelight-feedback-request-definition.ts`.
 *
 * IDEMPOTENT: a second run finds the flow by name and exits 0 without writing
 * unless --force. Seeded DISABLED by default per the house pattern; --enable
 * turns it on in the same write.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-amy-homelight-feedback-request.ts            # dry run
 *   npx tsx scripts/oneshot/seed-amy-homelight-feedback-request.ts --apply --enable
 *
 * Exit codes: 0 seeded / no-op / dry-run, 1 Supabase error, 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  summarizeDefinition
} from "@/lib/ai-flows/schema";
import { FLOW_NAME, buildDefinition } from "./amy-homelight-feedback-request-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const SCRIPT = "seed-amy-homelight-feedback-request.ts";

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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const enable = process.argv.includes("--enable");
  const force = process.argv.includes("--force");
  const businessId = argValue("business-id", DEFAULT_BUSINESS_ID);

  const db = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  let definition;
  try {
    definition = parseAiFlowDefinition(buildDefinition());
  } catch (err) {
    console.error("Definition failed validation:");
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  const { data: existing, error: readErr } = await db
    .from("ai_flows")
    .select("id,name,enabled")
    .eq("business_id", businessId)
    .ilike("name", FLOW_NAME);
  if (readErr) {
    console.error(`Read failed: ${readErr.message}`);
    process.exit(1);
  }

  console.log(`Flow    : ${FLOW_NAME}`);
  console.log(`Business: ${businessId}`);
  console.log(`Summary : ${summarizeDefinition(definition)}`);
  console.log(`Enabled : ${enable}`);

  if ((existing ?? []).length > 0 && !force) {
    const row = existing![0];
    console.log(`\nAlready seeded as ${row.id} (enabled=${row.enabled}). Nothing to do.`);
    console.log("Re-run with --force to overwrite its definition.");
    return;
  }

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply (add --enable to turn it on).");
    return;
  }

  if ((existing ?? []).length > 0) {
    const row = existing![0];
    const { error } = await db
      .from("ai_flows")
      .update({ definition, enabled: enable })
      .eq("id", row.id);
    if (error) {
      console.error(`Update failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`\nOverwrote ${row.id}.`);
  } else {
    const { data, error } = await db
      .from("ai_flows")
      .insert({ business_id: businessId, name: FLOW_NAME, definition, enabled: enable })
      .select("id")
      .single();
    if (error) {
      console.error(`Insert failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`\nSeeded ${data?.id}.`);
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: { flow_name: FLOW_NAME, enabled: enable, forced: force }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
