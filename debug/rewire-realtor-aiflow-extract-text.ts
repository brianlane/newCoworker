#!/usr/bin/env tsx
/**
 * One-shot: make the "Realtor.com Lead" AiFlow truly browser-free.
 *
 * The rltr.pro SMS already contains the buyer's name/phone/email/address/specs,
 * so there's no reason to open the link just to read them. This swaps the
 * browse_extract step (s2) for the new browser-free `extract_text` step (same
 * fields), which parses those fields straight out of the inbound message text
 * via the worker's Gemini extraction. The `extract_url` step (s1) stays so
 * {{vars.lead_url}} still feeds the owner email and team offer copy.
 *
 * It also sets options.suppressDefaultReply: true so the AI assistant doesn't
 * also fire its own auto-reply to a message this flow already handles.
 *
 * MUST run only AFTER the ai-flow-worker Edge function knows `extract_text`
 * (i.e. after the Phase 1 deploy) — an older worker would reject the step.
 *
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, and is idempotent (re-running is a no-op).
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/rewire-realtor-aiflow-extract-text.ts            # dry run
 *   tsx debug/rewire-realtor-aiflow-extract-text.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_UPDATE_FLOW_NAME.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError,
  type FlowStep
} from "../src/lib/ai-flows/schema.ts";

const BUSINESS_ID = process.env.AIFLOW_UPDATE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME = process.env.AIFLOW_UPDATE_FLOW_NAME ?? "Realtor.com Lead";

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No flow "${FLOW_NAME}" for business ${BUSINESS_ID}`);
    process.exit(1);
  }

  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}\n`);

  const def = parseAiFlowDefinition(row.definition);
  const steps: FlowStep[] = def.steps.map((s) => ({ ...s }));

  // Swap the browse_extract step for extract_text, preserving its id + fields
  // (+ any `when` guard) and dropping the browser-only urlVar/auth/screenshot.
  let swappedId: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "browse_extract") {
      steps[i] = {
        id: s.id,
        type: "extract_text",
        fields: s.fields,
        ...(s.when ? { when: s.when } : {})
      };
      swappedId = s.id;
      break;
    }
  }
  if (!swappedId && !steps.some((s) => s.type === "extract_text")) {
    console.error("No browse_extract (or existing extract_text) step found — nothing to swap");
    process.exit(1);
  }

  // Suppress the assistant's own auto-reply for messages this flow handles.
  const nextDefinition = {
    ...def,
    steps,
    options: { ...def.options, suppressDefaultReply: true }
  };

  let validated;
  try {
    validated = parseAiFlowDefinition(nextDefinition);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Updated definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Updated definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Flow                : ${row.id} (${row.name}, enabled=${row.enabled})`);
  console.log(`Summary             : ${summarizeDefinition(validated)}`);
  console.log(`Swapped to extract_text: ${swappedId ?? "(none — already extract_text)"}`);
  console.log(`suppressDefaultReply: ${validated.options?.suppressDefaultReply === true}`);

  if (!apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("\nUpdated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
