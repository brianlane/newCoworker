#!/usr/bin/env tsx
/**
 * One-shot: teach Amy's "HomeLight Referral" flow to claim a TEXT-PREFERRED
 * referral, and stop an unclaimable page from dead-lettering the run.
 *
 * WHY. On 2026-08-05 (run 0e9b52d2) the flow failed at `claim_click` with
 * `click_text "Call me to claim referral": no matching control on the page`,
 * and 57 downstream steps never ran, so a Mesa AZ seller never reached the
 * team. The captured failure page shows why: HomeLight has introduced a new
 * referral type that opens with a modal reading
 *
 *   "This client prefers texting ... You don't need to call and enter a PIN to
 *    accept these types of referrals. After you send the first message to the
 *    referral, you may call them as well."
 *
 * On that page there is NO call-to-claim button. The only actions are
 * "Send message" and "Decline referral", and HomeLight's own markup names the
 * first one `data-test="submit-claim-referral"`: sending the message IS the
 * claim. HomeLight also PRE-FILLS the message, personalised and in Amy's name
 * ("Hi <name>! This is Amy on behalf of HomeLight. I am with HomeSmart..."),
 * so nothing has to be composed here.
 *
 * WHAT THIS CHANGES. Three edits, all idempotent:
 *
 *   1. `open` (browse_extract) gains a `claim_mode` field answering how this
 *      referral can be claimed: call, text, or none. It defaults to `call` when
 *      the page is ambiguous, so an unreadable page behaves exactly as it does
 *      today rather than silently skipping the claim.
 *   2. `claim_click` is re-gated from `already_claimed equals no` to
 *      `claim_mode equals call`. `when` takes exactly ONE condition on ONE var
 *      (see whenSchema), which is why the mode field answers the already-claimed
 *      question too rather than needing a second gate.
 *   3. A new `claim_text` step runs when `claim_mode equals text`:
 *        - click_text_while_present "Continue" dismisses the modal. That kind is
 *          used deliberately: zero matches is SUCCESS for it, so if HomeLight
 *          stops showing the modal the step does not break.
 *        - click_selector `[data-test="submit-claim-referral"]` sends the
 *          pre-filled message, which claims the referral. A data-test attribute
 *          is used rather than the button text because the text is what broke:
 *          the visible label changed from a call-to-claim to "Send message",
 *          while HomeLight's own test id still says what the button DOES.
 *          Its styled-components classes (sc-538a0350-1 ...) are build hashes
 *          and must never be used as selectors.
 *
 * Both claim steps also gain `continueWhenText: "Decline referral"`. That marker
 * appears on any HomeLight referral page, so if the actions fail while we are
 * demonstrably still ON the referral page, the step is recorded skipped and the
 * run CARRIES ON to route_to_team and notify_unclaimed instead of dead-lettering.
 * That is the difference between losing a lead in silence and a human getting
 * the portal link. A genuinely broken page (login wall, error) has no such text
 * and still fails loudly.
 *
 * KNOWN GAP, deliberately not addressed here: the `route` step's offerTemplate
 * says "Our AI coworker answered HomeLight's call and is talking to them now",
 * which is accurate for a call-type referral and NOT for a text one. Varying it
 * would mean duplicating the whole 20-field route_to_team step, and those
 * templates were edited by another one-shot hours ago
 * (set-amy-lead-address-in-notices.ts), so this leaves them alone. Raise it
 * separately.
 *
 * Read-modify-write against the LIVE definition, so a dashboard edit or another
 * one-shot's changes are preserved. Validated through the SAME
 * parseAiFlowDefinition the dashboard and CRUD API use. Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-text-referral-claim.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-text-referral-claim.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_SEED_NAME (default "HomeLight Referral").
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME = process.env.AIFLOW_SEED_NAME ?? "HomeLight Referral";

/** HomeLight's own test id for the send-and-claim button on a text referral. */
const CLAIM_SELECTOR = '[data-test="submit-claim-referral"]';
/** On any referral page, so it proves "we are still here" rather than "it worked". */
const ON_REFERRAL_PAGE = "Decline referral";

const CLAIM_MODE_FIELD = {
  name: "claim_mode",
  // The schema caps a field description at 300 characters, so this is terse on
  // purpose. "call" is last and absorbs the unsure case, so an ambiguous page
  // behaves exactly as it does today instead of skipping the claim.
  description:
    "How is this referral claimed? Answer exactly one lowercase word. " +
    "text if the page says the client prefers texting or offers a Send message " +
    "button. none if another agent already claimed it or it is no longer " +
    "available. call otherwise, including when you cannot tell."
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

type BrowseExtract = Extract<FlowStep, { type: "browse_extract" }>;
type BrowseAction = Extract<FlowStep, { type: "browse_action" }>;

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changes: string[] } {
  const changes: string[] = [];
  const steps: FlowStep[] = [...def.steps];

  // 1. claim_mode on the page-open extraction.
  const openIdx = steps.findIndex((s) => s.id === "open" && s.type === "browse_extract");
  if (openIdx < 0) {
    throw new Error('no browse_extract step "open" found; is this the HomeLight Referral flow?');
  }
  const open = steps[openIdx] as BrowseExtract;
  const openFields = open.fields ?? [];
  if (!openFields.some((f) => f.name === CLAIM_MODE_FIELD.name)) {
    steps[openIdx] = { ...open, fields: [...openFields, CLAIM_MODE_FIELD] };
    changes.push(`add "${CLAIM_MODE_FIELD.name}" extraction field to step ${openIdx} ("open")`);
  }

  // 2. Re-gate the existing call claim, and stop it dead-lettering the run.
  const clickIdx = steps.findIndex((s) => s.id === "claim_click" && s.type === "browse_action");
  if (clickIdx < 0) {
    throw new Error('no browse_action step "claim_click" found; is this the HomeLight flow?');
  }
  const click = steps[clickIdx] as BrowseAction;
  const clickPatch: Partial<BrowseAction> = {};
  if (click.when?.var !== "claim_mode") {
    clickPatch.when = { var: "claim_mode", equals: "call" };
    changes.push(`re-gate "claim_click" on claim_mode equals "call"`);
  }
  if (!click.continueWhenText) {
    clickPatch.continueWhenText = ON_REFERRAL_PAGE;
    changes.push(`add continueWhenText "${ON_REFERRAL_PAGE}" to "claim_click"`);
  }
  if (Object.keys(clickPatch).length > 0) {
    steps[clickIdx] = { ...click, ...clickPatch } as FlowStep;
  }

  // 3. The text-preferred claim, right after the call one.
  if (!steps.some((s) => s.id === "claim_text")) {
    const claimText: FlowStep = {
      id: "claim_text",
      type: "browse_action",
      urlVar: click.urlVar,
      ...(click.auth ? { auth: click.auth } : {}),
      when: { var: "claim_mode", equals: "text" },
      actions: [
        // Zero matches is success for this kind, so a missing modal is fine.
        { kind: "click_text_while_present", target: "Continue" },
        { kind: "click_selector", target: CLAIM_SELECTOR }
      ],
      continueWhenText: ON_REFERRAL_PAGE
    } as FlowStep;
    steps.splice(clickIdx + 1, 0, claimText);
    changes.push(`insert "claim_text" after step ${clickIdx} (sends HomeLight's pre-filled message)`);
  }

  return { next: { ...def, steps }, changes };
}

async function main(): Promise<void> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) throw new Error(`read "${FLOW_NAME}": ${error.message}`);
  if (!data) throw new Error(`no "${FLOW_NAME}" flow for business ${BUSINESS_ID}`);
  const row = data as { id: string; name: string; enabled: boolean; definition: unknown };

  const current = parseAiFlowDefinition(row.definition);
  const { next, changes } = patch(current);
  if (changes.length === 0) {
    console.log(`"${FLOW_NAME}" already handles text-preferred referrals. Nothing to do.`);
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
  for (const c of changes) console.log(`Change   : ${c}`);
  console.log(`Summary  : ${summarizeDefinition(validated)}`);
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
    scriptPath: process.argv[1] ?? "homelight-text-referral-claim.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, flow_name: row.name, changes }
  });
  console.log(`\nPatched "${row.name}" (${changes.length} change(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
