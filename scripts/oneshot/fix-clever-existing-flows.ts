#!/usr/bin/env tsx
/**
 * One-shot: correct the two EXISTING live Clever flows (Phase 0 of the Clever
 * full-automation plan). Read-modify-write so we preserve the live copy
 * (esp. the Group Reply canned body) and only change what the plan calls for.
 *
 * "Clever Lead - Accept" (fires on the 314-470-8223 lead text + link):
 *   - trigger becomes `from_matches 3144708223` (+ keep has_url so we still
 *     require the lead link), dropping the brittle "Clever referral" contains.
 *   - the accept browse_action gets the missing initial `click_text "Accept"`
 *     BEFORE the `click_text_while_present "Next"` wizard loop.
 *   - drop the now-unneeded `rememberUrlKeyedByVar` (the two-message-to-Dave
 *     design replaced cross-run URL recall).
 *   - QT email to Amy + route_to_team claim to Dave are left untouched.
 *
 * "Clever Lead - Group Reply" (fires on the 314-470-8990 group intro):
 *   - trigger becomes `from_matches 3144708990`.
 *   - strip back to ONLY extract_text -> send_sms { replyToGroup } (remove the
 *     recall_url / Provide Update browse_action / notify_owner added last round).
 *   - the exact canned reply body is read from the live flow and preserved.
 *
 * Uses only primitives already shipped, so it's safe to apply before the engine
 * PR. Validated through parseAiFlowDefinition. Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/fix-clever-existing-flows.ts            # dry run
 *   npx tsx scripts/oneshot/fix-clever-existing-flows.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = process.env.AIFLOW_SEED_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const ACCEPT_FROM = "3144708223";
const GROUP_FROM = "3144708990";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };

async function loadFlow(name: string): Promise<Row> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`read "${name}": ${error.message}`);
  if (!data) throw new Error(`no "${name}" flow for business ${BUSINESS_ID}`);
  return data as Row;
}

/** Accept: from_matches trigger, initial Accept click, drop rememberUrl. */
function fixAccept(def: AiFlowDefinition): AiFlowDefinition {
  const steps = def.steps.map((s) => {
    if (s.type !== "browse_action" || s.id !== "accept") return s;
    const actions = Array.isArray(s.actions) ? [...s.actions] : [];
    // Don't prepend a second Accept if one already exists ANYWHERE in the
    // sequence — re-running this (or a flow that already clicks Accept later in
    // its wizard) must not double-accept the lead.
    const hasAcceptClick = actions.some(
      (a) =>
        a?.kind === "click_text" &&
        String(a?.target ?? "").trim().toLowerCase() === "accept"
    );
    const nextActions = hasAcceptClick
      ? actions
      : [{ kind: "click_text", target: "Accept" }, ...actions];
    const { rememberUrlKeyedByVar: _drop, ...rest } = s as Record<string, unknown>;
    return { ...rest, actions: nextActions } as FlowStep;
  });
  return {
    ...def,
    trigger: {
      ...def.trigger,
      conditions: [
        { type: "from_matches", value: ACCEPT_FROM },
        { type: "has_url" }
      ]
    } as AiFlowDefinition["trigger"],
    steps
  };
}

/** Group Reply: from_matches trigger, strip to extract + replyToGroup only. */
function fixGroupReply(def: AiFlowDefinition): AiFlowDefinition {
  const extract = def.steps.find((s) => s.type === "extract_text");
  const reply = def.steps.find((s) => s.type === "send_sms");
  if (!extract) throw new Error('Group Reply: no extract_text step found');
  if (!reply) throw new Error('Group Reply: no send_sms step found');
  // The live def may still carry a stale `to`/`toAgentName` next to
  // `replyToGroup` from an earlier round. The new "exactly one recipient
  // source" rule would reject that on re-validation and block --apply, so
  // normalize to a pure group reply while preserving the canned body.
  const { to: _to, toAgentName: _agent, ...replyRest } = reply as Record<string, unknown>;
  const groupReply = { ...replyRest, replyToGroup: true } as FlowStep;
  return {
    ...def,
    trigger: {
      ...def.trigger,
      conditions: [{ type: "from_matches", value: GROUP_FROM }]
    } as AiFlowDefinition["trigger"],
    steps: [extract, groupReply]
  };
}

function validate(name: string, nextDef: unknown): AiFlowDefinition {
  try {
    return parseAiFlowDefinition(nextDef);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`"${name}" failed validation:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`"${name}" failed validation:`, err);
    }
    process.exit(2);
  }
}

const accept = await loadFlow("Clever Lead - Accept");
const group = await loadFlow("Clever Lead - Group Reply");

const acceptNext = validate(accept.name, fixAccept(accept.definition));
const groupNext = validate(group.name, fixGroupReply(group.definition));

for (const [row, next] of [
  [accept, acceptNext],
  [group, groupNext]
] as const) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  console.log(`  before: ${row.definition.steps.length} steps`);
  console.log(`  after : ${summarizeDefinition(next)}`);
  console.log(JSON.stringify(next, null, 2));
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

// Supabase has no multi-table transaction from the JS client, so attempt BOTH
// writes rather than bailing after the first failure (which could leave Accept
// updated and Group Reply stale, i.e. out of sync). Each update is an
// idempotent read-modify-write to a fixed target state, so simply re-running
// the script reapplies any flow that didn't land.
const failures: string[] = [];
for (const [row, next] of [
  [accept, acceptNext],
  [group, groupNext]
] as const) {
  const { error } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (error) {
    console.error(`update "${row.name}" (id=${row.id}) failed: ${error.message}`);
    failures.push(row.name);
    continue;
  }
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}
if (failures.length > 0) {
  console.error(
    `\n${failures.length} flow(s) failed: ${failures.join(", ")}. ` +
      `The updates are idempotent — re-run with --apply to reapply (already-updated flows are unaffected).`
  );
  process.exit(1);
}
console.log("\nDone. Both existing Clever flows corrected (Phase 0).");
