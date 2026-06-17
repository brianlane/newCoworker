/**
 * One-shot: wire the Clever auto-update across the two live flows, now that the
 * engine supports cross-run URL recall + select_option.
 *
 * Flow A ("Clever Lead - Accept"): have the accept browse_action REMEMBER the
 * lead's Clever connection URL keyed by the lead's phone (rememberUrlKeyedByVar),
 * so the later group-reply run can find the same page.
 *
 * Flow B ("Clever Lead - Group Reply"):
 *   - drop the approval_gate (Amy wants the group reply to auto-send), then
 *   - recall_url the saved connection URL by the inbound group participants,
 *   - browse_action "Provide Update" (verified live 2026-06-17 on the real
 *     portal): click "Provide Update" -> click "We Spoke" -> select "No" in the
 *     native <select name="Did you schedule a time to meet in person?"> ->
 *     fill the notes textarea (placeholder "Type additional details about this
 *     update") -> click "Submit Update". Guarded by `when connection_url
 *     contains http` so a recall miss skips it cleanly, and
 *   - notify_owner: text Amy a summary after the whole automation.
 *
 * Read-modify-write, validated through parseAiFlowDefinition. Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx debug/wire-clever-provide-update.ts            # dry run
 *   npx tsx debug/wire-clever-provide-update.ts --apply
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../src/lib/ai-flows/schema.ts"
);
import type { AiFlowDefinition, FlowStep } from "../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = process.env.AIFLOW_SEED_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

// Verified live on the real Clever portal (Connection Details -> Provide Update).
const MEETING_SELECT = 'select[name="Did you schedule a time to meet in person?"]';
const NOTES_PLACEHOLDER = "Type additional details about this update";
const UPDATE_NOTE =
  "Accepted the lead and routed it to our team. Reached out to {{vars.seller_first_name}} to connect — following up tomorrow afternoon.";

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

/** Flow A: ensure the accept step remembers its URL keyed by the lead's phone. */
function wireAccept(def: AiFlowDefinition): AiFlowDefinition {
  return {
    ...def,
    steps: def.steps.map((s) =>
      s.type === "browse_action" && s.id === "accept"
        ? { ...s, rememberUrlKeyedByVar: "lead_phone" }
        : s
    )
  };
}

/** Flow B: drop the gate, recall the URL, post the update, summarize to Amy. */
function wireGroupReply(def: AiFlowDefinition): AiFlowDefinition {
  const kept = def.steps.filter((s) => s.type !== "approval_gate");

  const recall: FlowStep = {
    id: "recall",
    type: "recall_url",
    keyFromTrigger: "participants",
    saveAs: "connection_url"
  };
  const notify: FlowStep = {
    id: "notify",
    type: "notify_owner",
    message:
      "Clever: I texted {{vars.seller_first_name}} in the group thread, and I'm logging a 'We Spoke' update on their Clever connection."
  };
  const update: FlowStep = {
    id: "update",
    type: "browse_action",
    urlVar: "connection_url",
    auth: { integrationLabel: "Clever" },
    actions: [
      { kind: "click_text", target: "Provide Update" },
      { kind: "click_text", target: "We Spoke" },
      { kind: "select_option", target: MEETING_SELECT, valueTemplate: "No" },
      { kind: "fill_placeholder", target: NOTES_PLACEHOLDER, valueTemplate: UPDATE_NOTE },
      { kind: "click_text", target: "Submit Update" }
    ],
    when: { var: "connection_url", contains: "http" }
  };

  // extract -> reply -> recall -> notify (always) -> update (gated, last).
  return { ...def, steps: [...kept, recall, notify, update] };
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
const groupReply = await loadFlow("Clever Lead - Group Reply");

const acceptNext = validate(accept.name, wireAccept(accept.definition));
const groupNext = validate(groupReply.name, wireGroupReply(groupReply.definition));

console.log(`Flow A: ${accept.name} (id=${accept.id}, enabled=${accept.enabled})`);
console.log(`  -> ${summarizeDefinition(acceptNext)}`);
console.log(`Flow B: ${groupReply.name} (id=${groupReply.id}, enabled=${groupReply.enabled})`);
console.log(`  steps: ${groupReply.definition.steps.length} -> ${groupNext.steps.length}`);
console.log(`  -> ${summarizeDefinition(groupNext)}`);

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

for (const [id, def, label] of [
  [accept.id, acceptNext, accept.name],
  [groupReply.id, groupNext, groupReply.name]
] as const) {
  const { error } = await db.from("ai_flows").update({ definition: def }).eq("id", id);
  if (error) {
    console.error(`update "${label}" failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`Updated "${label}" (id=${id}).`);
}
console.log("\nDone. Both Clever flows wired for cross-run status updates.");
