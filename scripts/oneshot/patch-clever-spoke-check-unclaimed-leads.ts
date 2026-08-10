#!/usr/bin/env tsx
/**
 * One-shot: let the Clever spoke check reach a lead NOBODY ever claims.
 *
 * The flow's only trigger is `owner_assigned`, so it starts when a teammate
 * claims a lead. That is backwards for a safety net: the leads that already
 * got human attention also get the AI follow-up, and the leads nobody touched
 * get nothing. On 2026-08-10 fourteen of Amy's forty-five Clever-tagged
 * contacts had no owner at all, every one of them still tagged only
 * "New Lead, Clever" (never advanced to Contacted or Engaged), the oldest
 * sitting untouched for twenty-five days.
 *
 * Adds a SECOND trigger so a lead enters on a timer instead of on a claim:
 *
 *   { channel: "tag_changed", tag: "Clever", change: "added", conditions: [] }
 *
 * Why tag_changed and not contact_created, which is the intuitive choice: the
 * "Clever Lead - Accept" flow creates the contact at step 4 (`save_contact`,
 * upsert_customer) and only tags it "Clever" at step 5 (`tag_clever`). A
 * contact_created trigger therefore fires one step BEFORE the tag exists, so
 * nothing keyed on "clever" could ever match it. The tag_changed event fires
 * at step 5, still at acceptance and still long before any claim, which is
 * exactly the moment wanted. No condition list is needed: the trigger's own
 * `tag` field narrows to the Clever tag (case-insensitively) on its own.
 *
 * The flow needs no other edit, because two things already handle the
 * no-owner case:
 *
 *   - `read_contact` extracts `spoke_owner` from the event's "owner:" line, or
 *     "none" when there is no such line. A tag_changed event has none, so
 *     `spoke_check`'s agentNameVar pin resolves to nothing and the step is
 *     left UN-pinned, which offers the lead to the active roster rotation.
 *     Right behavior for an unclaimed lead: offer it to the team, and if
 *     nobody answers inside the 24h window, start the weekly AI calls.
 *   - The `converted` goal already lists `{ kind: "claimed" }`, so a lead
 *     claimed while the run is mid-grace jumps straight to the goal and is
 *     never called.
 *
 * Also sets `options.allowReentry = false`, which is NOT optional cosmetics.
 * With two triggers a lead that is tagged and later claimed would match both
 * and enroll TWICE, giving a real home seller two parallel weekly-call chains.
 * The re-entry gate blocks the second enrollment. Trade-off worth naming: a
 * contact who completed this flow once will not re-enter it if they come back
 * as a fresh Clever lead months later. Calling someone twice a week is the
 * worse failure.
 *
 * Does NOT backfill. The fourteen leads already sitting unowned emit no new
 * tag_changed event, so they need a separate deliberate backfill; this script
 * only changes what happens to leads accepted from here on.
 *
 * Read-modify-write against the LIVE definition (which has drifted from
 * scripts/oneshot/clever-spoke-check-definition.ts: the live copy gained the
 * `spoke_owner` extraction and the agentNameVar pin on 2026-08-08), so hand
 * edits made since the last one-shot are preserved. Validated through the SAME
 * parseAiFlowDefinition the dashboard and CRUD API use. Dry-run by default;
 * idempotent (re-running after --apply reports nothing to do).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-spoke-check-unclaimed-leads.ts          # dry run
 *   npx tsx scripts/oneshot/patch-clever-spoke-check-unclaimed-leads.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_SEED_NAME (default "Clever - Spoke Check & Weekly Call Follow-Up"),
 *           AIFLOW_CLEVER_TAG (default "Clever").
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition } from "../../src/lib/ai-flows/schema.ts";
import { patchSpokeCheckForUnclaimedLeads } from "./clever-spoke-check-unclaimed-patch.ts";

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME =
  process.env.AIFLOW_SEED_NAME ?? "Clever - Spoke Check & Weekly Call Follow-Up";
/** The tag the accept flow writes; the trigger narrows on it case-insensitively. */
const CLEVER_TAG = process.env.AIFLOW_CLEVER_TAG ?? "Clever";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function main(): Promise<void> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`read "${FLOW_NAME}": ${error.message}`);
  if (!data) throw new Error(`no "${FLOW_NAME}" flow for business ${BUSINESS_ID}`);
  const row = data as { id: string; name: string; enabled: boolean; definition: unknown };

  const current = parseAiFlowDefinition(row.definition);
  const { next, changes } = patchSpokeCheckForUnclaimedLeads(current, { cleverTag: CLEVER_TAG });
  if (changes.length === 0) {
    console.log(`"${FLOW_NAME}" already has the tag_changed trigger and the re-entry gate.`);
    return;
  }

  let validated: AiFlowDefinition;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Patched definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(2);
    }
    throw err;
  }

  console.log(`Business : ${BUSINESS_ID}`);
  console.log(`Flow     : ${row.name} (id=${row.id}, enabled=${row.enabled})`);
  console.log(`Changes  : ${changes.join("; ")}`);
  console.log(`Summary  : ${summarizeDefinition(validated)}`);
  // Printed so a bad apply can be reverted without digging for a backup.
  console.log(`\nPrevious definition (for rollback):\n${JSON.stringify(row.definition)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }

  const { error: updErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (updErr) throw new Error(`update failed: ${updErr.message}`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-clever-spoke-check-unclaimed-leads.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, flow_name: row.name, changes }
  });
  console.log(`\nPatched "${row.name}" (${changes.length} change(s)).`);
  console.log(
    "Note: leads already sitting unowned emit no new tag_changed event. " +
      "This changes what happens to leads accepted from here on."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
