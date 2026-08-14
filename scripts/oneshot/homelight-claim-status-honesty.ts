#!/usr/bin/env tsx
/**
 * One-shot: stop the HomeLight referral flow announcing a claim it never
 * completed, and give HomeLight's callback long enough to actually arrive.
 *
 * Amy C., 2026-08-14 (run 5ac0ee1b). The flow clicked "Call me to claim
 * referral" at 08:09:51 and waited 3 minutes for HomeLight to call back.
 * HomeLight called at 10:26, 137 minutes later. The step recorded `no_call`
 * and the run carried on telling everyone the referral was claimed: the
 * teammate got "HomeLight lead is yours" and the owner got "HomeLight
 * referral claimed by Gabrielle Mota", while the portal HTML saved that same
 * minute still showed the unclicked "Call me to claim referral" button.
 * HomeLight's own 90-minute nudge ("please respond to maintain your referral
 * volume") confirms it considered the referral unanswered.
 *
 * TWO FIXES.
 *
 * 1. `awaitStartMinutes` 3 -> 6. Not a guess: Kevin's callback (2026-08-11)
 *    landed at 3.1 minutes and was missed by six seconds. Measured callbacks
 *    since Jul 1 2026 were -0.8, -0.5, 3.1, 19.0 and 137 minutes, and five
 *    referrals got no call at all.
 *
 *    WHY NOT LONGER. Half of all referrals never get a callback, so every
 *    minute added is a minute those runs pay for nothing before the claimer
 *    is texted the lead's details, and docs/tenants/homelight-flow.md is
 *    explicit that latency is the product here. Missing the call is also
 *    recoverable on its own: the late-contact ladder re-reads HomeLight's
 *    email and is what rescued Amy C. at 10:30. 6 clears the one real
 *    callback we measurably lost, and nothing beyond it.
 *
 * 2. The copy states what is actually known. Routing DID assign the lead, so
 *    "assigned to you" is true; whether HomeLight's claim completed is a
 *    separate fact the flow already has in `hl_call_outcome`, whose companion
 *    `hl_call_outcome_label` is the engine's own human phrase ("no call came
 *    in", "spoke with them"). Templating that in beats inventing wording,
 *    because it stays correct for outcomes added later. The teammate SMS also
 *    gains the portal link, which is what makes the no_call case actionable:
 *    they can finish the claim by hand instead of waiting on a callback that
 *    may never come.
 *
 *    The route offer's "Our AI coworker answered HomeLight's call and is
 *    talking to them now" goes too. It is sent BEFORE any call exists, and on
 *    the text-claim path there is no call at all, which the dossier already
 *    listed as needing its own fix.
 *
 * Supersedes `homelight-await-call-start.ts`, which set the 3.
 *
 * Structure is untouched: no step is added, removed or reordered, so parked
 * runs resume exactly as before. Idempotent, validated through
 * parseAiFlowDefinition before writing, REFUSES when the live copy is not what
 * it was written against (so an unledgered builder edit stops the apply rather
 * than being silently reverted), dry-run by default, ledger-recorded.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-claim-status-honesty.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-claim-status-honesty.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
 *           HOMELIGHT_AWAIT_CALL_MINUTES (default 6)
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Steps this patches. Named, not positional: trunk indices shift. */
export const WAIT_STEP_ID = "wait_hl_call";
export const OFFER_STEP_ID = "route";
export const AGENT_SMS_STEP_ID = "to_agent";
export const OWNER_EMAIL_STEP_ID = "qt_email";

/**
 * Engine clamp is 0..60. This script's own ceiling stays low on purpose: the
 * step gates every step after it, so a large value here is a worse bug than
 * the missed callback it would be trying to catch.
 */
export const MAX_AWAIT_MINUTES = 10;

export const DEFAULT_AWAIT_MINUTES = 6;

/** Asserted before the call exists, and always false on the text-claim path. */
export const FALSE_CALL_LINE = "Our AI coworker answered HomeLight's call and is talking to them now.";
export const CLAIMING_LINE = "Our AI coworker is claiming it with HomeLight now.";

/** The claim outcome, in the engine's own words rather than ours. */
export const CLAIM_STATUS_LINE = "HomeLight claim call: {{vars.hl_call_outcome_label}}.";

const AGENT_OLD_OPENER = "HomeLight lead is yours:";
const AGENT_NEW_OPENER = "HomeLight lead assigned to you:";
const OWNER_OLD_OPENER = "HomeLight referral claimed by {{vars.claimed_agent}}.";
const OWNER_NEW_OPENER = "HomeLight referral assigned to {{vars.claimed_agent}}.";

/** The line the teammate SMS inserts its status block after. */
const AGENT_ANCHOR = "Address: {{vars.lead_address}}";

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  branches?: Array<Record<string, unknown> & { steps?: unknown }>;
  else?: unknown;
};
type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Depth-first walk over trunk steps, branch arms and else arms. */
function* walkSteps(steps: unknown): Generator<Step> {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    if (!step || typeof step !== "object") continue;
    yield step;
    for (const arm of Array.isArray(step.branches) ? step.branches : []) {
      yield* walkSteps(arm?.steps);
    }
    yield* walkSteps(step.else);
  }
}

function requireStep(def: Definition, id: string, type: string): Step {
  const matches = [...walkSteps(def.steps)].filter((s) => s.id === id);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one step "${id}", found ${matches.length}`);
  }
  const step = matches[0]!;
  if (step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

/**
 * Apply both fixes. Returns the edits made, so an already-patched flow reports
 * "nothing to do" instead of rewriting. Throws when the live copy is not what
 * this patch was written against: reverting someone else's edit unnoticed is
 * worse than refusing.
 */
export function patchDefinition(def: Definition, awaitMinutes: number): string[] {
  if (!Number.isInteger(awaitMinutes) || awaitMinutes < 1 || awaitMinutes > MAX_AWAIT_MINUTES) {
    throw new Error(
      `awaitStartMinutes must be an integer 1..${MAX_AWAIT_MINUTES} (ceiling), got ${awaitMinutes}`
    );
  }
  const edits: string[] = [];

  const wait = requireStep(def, WAIT_STEP_ID, "wait_for_call");
  const offer = requireStep(def, OFFER_STEP_ID, "route_to_team");
  const agent = requireStep(def, AGENT_SMS_STEP_ID, "send_sms");
  const owner = requireStep(def, OWNER_EMAIL_STEP_ID, "send_email");

  const offerCopy = typeof offer.offerTemplate === "string" ? offer.offerTemplate : "";
  const agentCopy = typeof agent.body === "string" ? agent.body : "";
  const ownerCopy = typeof owner.body === "string" ? owner.body : "";

  // Validate every anchor BEFORE writing anything, so a refusal never leaves
  // the definition half-patched.
  if (!offerCopy.includes(FALSE_CALL_LINE) && !offerCopy.includes(CLAIMING_LINE)) {
    throw new Error(
      `${OFFER_STEP_ID}.offerTemplate does not carry the expected claim line; it was edited elsewhere`
    );
  }
  if (!agentCopy.startsWith(AGENT_OLD_OPENER) && !agentCopy.startsWith(AGENT_NEW_OPENER)) {
    throw new Error(
      `${AGENT_SMS_STEP_ID}.body does not open with the expected copy; it was edited elsewhere`
    );
  }
  if (!ownerCopy.startsWith(OWNER_OLD_OPENER) && !ownerCopy.startsWith(OWNER_NEW_OPENER)) {
    throw new Error(
      `${OWNER_EMAIL_STEP_ID}.body does not open with the expected copy; it was edited elsewhere`
    );
  }
  if (agentCopy.startsWith(AGENT_OLD_OPENER) && !agentCopy.includes(AGENT_ANCHOR)) {
    throw new Error(`${AGENT_SMS_STEP_ID}.body has no "${AGENT_ANCHOR}" line to insert after`);
  }

  if (wait.awaitStartMinutes !== awaitMinutes) {
    wait.awaitStartMinutes = awaitMinutes;
    edits.push(`${WAIT_STEP_ID}.awaitStartMinutes=${awaitMinutes}`);
  }

  if (offerCopy.includes(FALSE_CALL_LINE)) {
    offer.offerTemplate = offerCopy.replace(FALSE_CALL_LINE, CLAIMING_LINE);
    edits.push(`${OFFER_STEP_ID}.offerTemplate: drops the "already talking to them" claim`);
  }

  if (agentCopy.startsWith(AGENT_OLD_OPENER)) {
    agent.body = agentCopy
      .replace(AGENT_OLD_OPENER, AGENT_NEW_OPENER)
      .replace(AGENT_ANCHOR, `${AGENT_ANCHOR}\n${CLAIM_STATUS_LINE}\nPortal: {{vars.leadUrl}}`);
    edits.push(`${AGENT_SMS_STEP_ID}.body: assigned-not-claimed, claim status, portal link`);
  }

  if (ownerCopy.startsWith(OWNER_OLD_OPENER)) {
    owner.body = ownerCopy.replace(
      OWNER_OLD_OPENER,
      `${OWNER_NEW_OPENER}\n${CLAIM_STATUS_LINE}`
    );
    edits.push(`${OWNER_EMAIL_STEP_ID}.body: assigned-not-claimed, claim status`);
  }

  return edits;
}

function awaitMinutesFromEnv(): number {
  const raw = process.env.HOMELIGHT_AWAIT_CALL_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AWAIT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_AWAIT_MINUTES) {
    console.error(
      `HOMELIGHT_AWAIT_CALL_MINUTES must be an integer 1..${MAX_AWAIT_MINUTES} (got "${raw}"). ` +
        "This step gates every step after it, so a long wait delays the claimer's hand-off."
    );
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required."
    );
    process.exit(2);
  }
  const businessId = args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const awaitMinutes = awaitMinutesFromEnv();

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`Flow "${flowName}" not found for business ${businessId}.`);
    process.exit(2);
  }
  const flow = row as { id: string; name: string; definition: Definition };
  const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;

  let applied: string[];
  try {
    applied = patchDefinition(def, awaitMinutes);
  } catch (err) {
    console.error(
      `Unexpected shape for "${flow.name}" (${flow.id}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "The flow was rebuilt or edited in the builder; re-read it before patching."
    );
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Flow     : ${flow.name} (${flow.id})`);
  console.log(`Wait     : ${awaitMinutes} min for HomeLight's claim call to start`);
  if (applied.length === 0) {
    console.log("\nAlready patched, nothing to do.");
    return;
  }
  for (const edit of applied) console.log(`Edit     : ${edit}`);

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`\nPatched definition is invalid: ${err.message}`);
    } else {
      console.error(`\nPatched definition is invalid: ${String(err)}`);
    }
    process.exit(2);
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    return;
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: def, updated_at: new Date().toISOString() })
    .eq("id", flow.id)
    .eq("business_id", businessId);
  if (upErr) {
    console.error(`Write failed: ${upErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-claim-status-honesty.ts",
    businessId,
    details: { flow_id: flow.id, flow_name: flow.name, await_minutes: awaitMinutes, edits: applied }
  });
  console.log("\nApplied.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
