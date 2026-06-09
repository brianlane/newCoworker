#!/usr/bin/env tsx
/**
 * One-shot: upgrade the "ReferralExchange lead" AiFlow for one tenant to the
 * screenshot + email + MMS routing shape (June 2026 request):
 *
 *   1. `browse` gains `screenshot: true` (render service captures the lead page).
 *   2. Three gated `send_email` steps right after `browse` email the owner the
 *      lead with the screenshot attached. Subject codes: BS for buyers, QT for
 *      sellers, BS QT for both — "{{vars.lead_name}} <code> RX".
 *   3. The single ungated `route_to_team` step is replaced by three gated
 *      copies (buyer / seller / both) — so routing only runs when lead_type
 *      extracted to a known value — each with `attachScreenshot: true` so the
 *      agent offer SMS carries the screenshot as MMS.
 *
 * Validates the result through parseAiFlowDefinition before writing, prints
 * the previous definition for rollback, and is idempotent (re-running after
 * success makes no further changes).
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/update-amy-aiflow-screenshot-email.ts            # dry run
 *   tsx debug/update-amy-aiflow-screenshot-email.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_UPDATE_FLOW_NAME, AIFLOW_UPDATE_OWNER_EMAIL.
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
const FLOW_NAME = process.env.AIFLOW_UPDATE_FLOW_NAME ?? "ReferralExchange lead";
const OWNER_EMAIL = process.env.AIFLOW_UPDATE_OWNER_EMAIL ?? "amy@amylaidlaw.com";

const EMAIL_BODY =
  "New {{vars.lead_type}} lead from ReferralExchange: {{vars.lead_name}} " +
  "({{vars.lead_phone}}) in {{vars.location}}, around {{vars.price}}. " +
  "Screenshot of the lead page is attached.";

function emailStep(id: string, leadType: string, subjectCode: string): FlowStep {
  return {
    id,
    type: "send_email",
    to: OWNER_EMAIL,
    subject: `{{vars.lead_name}} ${subjectCode} RX`,
    body: EMAIL_BODY,
    attachScreenshot: true,
    when: { var: "lead_type", equals: leadType }
  };
}

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
  const steps: FlowStep[] = [...def.steps];

  // 1. screenshot on the browse step.
  const browseIdx = steps.findIndex((s) => s.type === "browse_extract");
  if (browseIdx === -1) {
    console.error("No browse_extract step found");
    process.exit(1);
  }
  const browse = steps[browseIdx];
  if (browse.type === "browse_extract" && browse.screenshot !== true) {
    steps[browseIdx] = { ...browse, screenshot: true };
  }

  // 2. Gated owner emails directly after browse (idempotent by id).
  const emails: FlowStep[] = [
    emailStep("email_buyer", "buyer", "BS"),
    emailStep("email_seller", "seller", "QT"),
    emailStep("email_both", "both", "BS QT")
  ].filter((e) => !steps.some((s) => s.id === e.id));
  steps.splice(browseIdx + 1, 0, ...emails);

  // 3. Replace the single ungated route with three gated, MMS-attaching copies.
  const routeIdx = steps.findIndex((s) => s.type === "route_to_team" && s.id === "route");
  if (routeIdx !== -1) {
    const route = steps[routeIdx];
    if (route.type === "route_to_team") {
      const gated: FlowStep[] = (["buyer", "seller", "both"] as const).map((t) => ({
        ...route,
        id: `route_${t}`,
        attachScreenshot: true,
        when: { var: "lead_type", equals: t }
      }));
      steps.splice(routeIdx, 1, ...gated);
    }
  }

  const nextDefinition = { ...def, steps };
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

  console.log(`Flow     : ${row.id} (${row.name}, enabled=${row.enabled})`);
  console.log(`Summary  : ${summarizeDefinition(validated)}`);
  console.log(`New steps: ${validated.steps.map((s) => s.id).join(" -> ")}`);

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
