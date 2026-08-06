/**
 * setup-hq-inbox-triage-flow.ts: one-shot to author the HQ tenant's team-inbox
 * triage AiFlow (dogfooding plan, email phase).
 *
 * Watches the connected newcoworkerteam@gmail.com mailbox (the inbox behind
 * team@ / contact@newcoworker.com) via the `email` trigger channel, classifies
 * each inbound message, texts Brian for the three human-attention categories
 * (sales lead / support / billing), and applies a matching Gmail label via
 * email_organize so the inbox stays filed. Automated platform notices,
 * contact-form copies (already triaged by the webhook flow), newsletters, and
 * unclassifiable mail stay silent (and unlabeled).
 *
 * Idempotent upsert-by-name, validated with parseAiFlowDefinition first.
 *
 * ---------------------------------------------------------------------------
 * Aug 5 2026 rewrite. Two texts arrived minutes apart about ONE Gmail thread
 * (an intro, then its "Re:"), the first with an empty subject slot and a bare
 * hyphen where the separator was, the second summarizing thread mechanics
 * rather than an ask. Four things changed:
 *
 *   1. The subject is {{trigger.subject}}, not an extracted field. It was
 *      always in scope verbatim; the extractor had to guess it out of an
 *      unlabeled subject+body blob and returned "". (The authoring validator
 *      used to reject {{trigger.subject}} as an unknown field, which is why
 *      the flow paid for a model call to re-derive it. Fixed in PR #1185.)
 *   2. email_gist is prompted for an ASK, not a narration, and returns "" when
 *      a message has no new ask at all.
 *   3. Each notify carries a cooldown on {{trigger.thread_id}}, so a reply on
 *      a thread Brian was already told about stays quiet for the working day.
 *      The email_organize steps still run, so the mail is filed either way.
 *   4. Each alert ends in a Gmail deep link, shortened at send time and
 *      deliberately untracked.
 *
 * The em dashes this file used to carry are gone too (rule 4). They were the
 * literal source of the bare "-" in the live text, since gsmSafeSmsText
 * rewrites them on the way out. tests/no-em-dashes.test.ts now guards it.
 *
 * NOTE ON DRIFT: before this rewrite the LIVE flow had only the 5 steps up to
 * the notifies. The three email_organize steps existed here but had never been
 * applied, so HQ/* labeling had never actually run despite the dossier saying
 * it did. Applying this version turns labeling AND folder-moving on for the
 * first time (confirmed with Brian, Aug 5 2026).
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   npx tsx scripts/oneshot/setup-hq-inbox-triage-flow.ts          # dry-run
 *   npx tsx scripts/oneshot/setup-hq-inbox-triage-flow.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

const {
  HQ_BUSINESS_ID,
  FLOW_NAME,
  GMAIL_CONNECTION_ROW_ID,
  buildHqInboxTriageDefinition
} = await import("./hq-inbox-triage-definition.ts");
const { HQ_REPLY_DRAFTER_AGENT_NAME, HQ_REPLY_DRAFTER_INSTRUCTIONS } = await import(
  "./hq-inbox-reply-drafter.ts"
);
const { parseAiFlowDefinition } = await import("../../src/lib/ai-flows/schema.ts");
const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = await createSupabaseServiceClient();

/**
 * The reply drafter, upserted BY NAME before the flow is authored: the flow
 * references it by uuid, so the agent has to exist first and the flow has to
 * learn the id the upsert settled on. Editing the instructions in the
 * dashboard is expected and safe; re-running this resets them to the repo
 * copy, which is the whole point of pinning them in a test.
 */
async function ensureReplyDrafter(): Promise<string> {
  const { data: existing, error } = await db
    .from("business_agents")
    .select("id, instructions")
    .eq("business_id", HQ_BUSINESS_ID)
    .eq("name", HQ_REPLY_DRAFTER_AGENT_NAME)
    .maybeSingle();
  if (error) {
    console.error("[inbox-triage] agent lookup failed:", error.message);
    process.exit(1);
  }
  const row = existing as { id: string; instructions: string } | null;
  if (row) {
    const drifted = row.instructions !== HQ_REPLY_DRAFTER_INSTRUCTIONS;
    console.log(
      `[inbox-triage] agent "${HQ_REPLY_DRAFTER_AGENT_NAME}": exists (id=${row.id})` +
        (drifted ? ", instructions DIFFER from the repo copy and will be reset" : ", instructions match")
    );
    if (APPLY && drifted) {
      const { error: updErr } = await db
        .from("business_agents")
        .update({ instructions: HQ_REPLY_DRAFTER_INSTRUCTIONS, updated_at: new Date().toISOString() })
        .eq("business_id", HQ_BUSINESS_ID)
        .eq("id", row.id);
      if (updErr) throw new Error(`agent update: ${updErr.message}`);
    }
    return row.id;
  }
  console.log(`[inbox-triage] agent "${HQ_REPLY_DRAFTER_AGENT_NAME}": will create`);
  if (!APPLY) return "00000000-0000-4000-8000-000000000000";
  const { data: created, error: insErr } = await db
    .from("business_agents")
    .insert({
      business_id: HQ_BUSINESS_ID,
      name: HQ_REPLY_DRAFTER_AGENT_NAME,
      instructions: HQ_REPLY_DRAFTER_INSTRUCTIONS,
      // Plain text in, plain text out: an email body, never markdown.
      output_format: "same_as_input"
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`agent insert: ${insErr.message}`);
  return (created as { id: string }).id;
}

const replyDrafterAgentId = await ensureReplyDrafter();
const definition = buildHqInboxTriageDefinition(replyDrafterAgentId);
parseAiFlowDefinition(definition);
console.log(`[inbox-triage] "${FLOW_NAME}" definition valid`);

// The email poller resolves the trigger's connection row at poll time, so
// verify it exists and is an email-capable provider before authoring.
const { data: conn, error: connErr } = await db
  .from("workspace_oauth_connections")
  .select("id, provider_config_key, metadata")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("id", GMAIL_CONNECTION_ROW_ID)
  .maybeSingle();
if (connErr || !conn) {
  console.error("[inbox-triage] Gmail connection row not found, aborting", connErr?.message ?? "");
  process.exit(1);
}
console.log("[inbox-triage] mailbox connection:", conn.provider_config_key, (conn.metadata as { provider_account_email?: string } | null)?.provider_account_email);

const { data: existing, error: listErr } = await db
  .from("ai_flows")
  .select("id, enabled, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (listErr) {
  console.error("[inbox-triage] existing-flow lookup failed:", listErr.message);
  process.exit(1);
}
console.log(
  `[inbox-triage] "${FLOW_NAME}": ${existing ? `exists (id=${(existing as { id: string }).id}), will refresh` : "will create (enabled)"}`
);

/**
 * Print what this run would actually change, step by step.
 *
 * The live row is the source of truth, not this file, and the two had silently
 * diverged: live carried 5 steps while this builder defined 9, so the three
 * email_organize steps had never run even though the tenant dossier said they
 * had. A dry run that only printed "will refresh" could not surface that. This
 * one names every added, removed, and modified step, so the drift is visible
 * BEFORE --apply rather than after.
 */
type DiffStep = { id: string; type?: string };

/**
 * Every step in display order, branch arms included.
 *
 * Without this a step that MOVED into a branch arm reads as a deletion: the
 * first run of this flow's branch rewrite reported three phantom "REMOVE"
 * warnings for notify steps that had simply moved inside an arm. Worse than
 * the noise, a genuine removal could hide among the false ones.
 */
function flattenForDiff(steps: unknown): DiffStep[] {
  const out: DiffStep[] = [];
  for (const raw of Array.isArray(steps) ? steps : []) {
    const step = raw as DiffStep & { branches?: { steps?: unknown }[]; else?: unknown };
    if (typeof step?.id !== "string") continue;
    out.push(step);
    for (const arm of step.branches ?? []) out.push(...flattenForDiff(arm?.steps));
    out.push(...flattenForDiff(step.else));
  }
  return out;
}

function reportDiff(live: unknown): void {
  const liveSteps = flattenForDiff((live as { steps?: unknown } | null)?.steps);
  const nextSteps = flattenForDiff(definition.steps);
  const liveById = new Map(liveSteps.map((s) => [s.id, s]));
  const nextById = new Map(nextSteps.map((s) => [s.id, s]));

  console.log(
    `[inbox-triage] live has ${liveSteps.length} step(s), this file has ${nextSteps.length} (branch arms included)`
  );
  for (const step of nextSteps) {
    const before = liveById.get(step.id);
    if (!before) {
      console.log(`[inbox-triage]   + ADD     ${step.id} (${step.type})`);
    } else if (JSON.stringify(before) !== JSON.stringify(step)) {
      console.log(`[inbox-triage]   ~ CHANGE  ${step.id} (${step.type})`);
      console.log(`[inbox-triage]       live: ${JSON.stringify(before)}`);
      console.log(`[inbox-triage]       next: ${JSON.stringify(step)}`);
    }
  }
  for (const step of liveSteps) {
    if (!nextById.has(step.id)) {
      console.log(`[inbox-triage]   - REMOVE  ${step.id}  <-- this DELETES live behavior, is that intended?`);
    }
  }
}

if (existing) reportDiff((existing as { definition?: unknown }).definition);

if (!APPLY) {
  console.log("[inbox-triage] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

let flowId: string;
if (existing) {
  flowId = (existing as { id: string }).id;
  const { error } = await db
    .from("ai_flows")
    .update({ definition, updated_at: new Date().toISOString() })
    .eq("id", flowId);
  if (error) throw new Error(`flow update: ${error.message}`);
  console.log(`[inbox-triage] refreshed (id=${flowId})`);
} else {
  const { data, error } = await db
    .from("ai_flows")
    .insert({
      business_id: HQ_BUSINESS_ID,
      name: FLOW_NAME,
      enabled: true,
      definition
    })
    .select("id")
    .single();
  if (error) throw new Error(`flow insert: ${error.message}`);
  flowId = (data as { id: string }).id;
  console.log(`[inbox-triage] created (id=${flowId})`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "setup-hq-inbox-triage-flow.ts",
  businessId: HQ_BUSINESS_ID,
  details: { flowId, flowName: FLOW_NAME, connectionRowId: GMAIL_CONNECTION_ROW_ID }
});
console.log("[inbox-triage] ledger recorded. Done.");
process.exit(0);
