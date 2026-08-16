#!/usr/bin/env tsx
/**
 * One-shot: make the HomeLight claim click VERIFIED instead of fire-and-forget,
 * and revive the contact-reveal email ladders that were silently inert.
 *
 * WHY. On 2026-08-16 two referrals arrived (runs 58034590 09:09 and def440a9
 * 09:28 Phoenix). Both `claim_click` steps resolved the real
 * `data-test="submit-claim-referral"` button and reported success
 * (actionsCompleted: 1), and Telnyx carrier records show HomeLight never
 * placed the claim callback for either. When Amy clicked the same button by
 * hand at 09:40 the callback arrived within seconds, the voice flow answered,
 * pressed 1, and HomeLight said "Connecting you now". A clean Playwright click
 * on a Next.js portal can be swallowed client-side (handler not attached yet,
 * or a silent request failure); a dispatched click is not a registered claim.
 * Meanwhile the offer told the team "Our AI coworker is claiming it with
 * HomeLight now.", so nobody looked at the portal for 30 minutes.
 *
 * WHAT THIS CHANGES.
 *
 *  1. `claim_verify` (browse_extract) right after the claim steps: a FRESH
 *     load of the referral page reads `claim_state`. HomeLight stores the
 *     claim-call state server-side, so a fresh navigation shows "Pick up now
 *     to claim this lead / We're calling you / Call me again" when the click
 *     registered, and the untouched claim button when it did not.
 *  2. `claim_fix` (branch, arm on `claim_state contains "NOT CONFIRMED"`):
 *     one retry click (`claim_retry`, call-mode only; the fresh navigation
 *     also gives the app time to finish loading, which is the most likely
 *     reason the first click was swallowed), then `claim_verify2` re-reads and
 *     OVERWRITES `claim_state`, so downstream copy reflects the final truth.
 *     `claim_retry` carries `continueWhenText: "HomeLight"` (present on any
 *     HomeLight page) because a retry failure must degrade to the verified
 *     NOT-CONFIRMED message, never dead-letter the run and take the offer,
 *     the routing, and 60 downstream steps with it (the Jul 31 lesson).
 *  3. Honest copy. The offer's flat claim line becomes
 *     "Claim status: {{vars.claim_state}}." and the same status rides the
 *     $1M+ owner-direct text, the owner fallback, the unclaimed reminders'
 *     details block, and the unclaimed owner notice. When the state is
 *     "NOT CONFIRMED, claim by hand now" the copy IS the rescue instruction,
 *     and the portal link is already on the next line.
 *  4. Revive the reveal ladders. `email_extract` writes NO vars when no
 *     mailbox message matches ({found:false}, ai-flow-worker), so every gate
 *     keyed on `<status> equals "missing"` is unmet on the common
 *     first-read-too-early case and the 15/60-minute retry ladder silently
 *     never ran (both 2026-08-16 runs: step result {"found":false}, no
 *     u1_status, every later rung when_unmet). Re-gate the retry rungs and
 *     the late_missing arm on `notEquals "found"`: an unset status now means
 *     "keep trying", which is the reading the ladder was built for.
 *  5. Wider, tighter mailbox reads. The unclaimed read ran 73+ minutes after
 *     arrival with `lookbackMinutes: 60`, so its window could not even reach
 *     back to the referral email's arrival. All six HomeLight reads go to
 *     240 minutes, and every first-name matcher gains
 *     "{{vars.price_digits}}" (bodyContains terms are AND-ed, and blank
 *     renders are dropped, so this only ever narrows).
 *
 * Idempotent, validated through parseAiFlowDefinition before writing, REFUSES
 * when the live copy is not what it was written against, dry-run by default,
 * ledger-recorded with the previous definition stored for `--revert`.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-verified-claim.ts                 # dry run
 *   npx tsx scripts/oneshot/homelight-verified-claim.ts --apply         # write
 *   npx tsx scripts/oneshot/homelight-verified-claim.ts --revert --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral").
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

const SCRIPT = "homelight-verified-claim.ts";
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** Step ids this patch inserts (and refuses to duplicate). */
export const VERIFY_STEP_ID = "claim_verify";
export const FIX_BRANCH_ID = "claim_fix";
export const RETRY_STEP_ID = "claim_retry";
export const VERIFY2_STEP_ID = "claim_verify2";

/** The unverified assertion this patch retires. */
export const CLAIMING_LINE = "Our AI coworker is claiming it with HomeLight now.";
/** Its replacement: the verified state, in the extraction's own words. */
export const CLAIM_STATUS_LINE = "Claim status: {{vars.claim_state}}.";
/** Compact variant for the reminder details block. */
export const CLAIM_DETAILS_LINE = "Claim: {{vars.claim_state}}";

/**
 * The exact values `claim_state` may take. They are copy, not just tokens:
 * templates render them directly after "Claim status:", so each reads as a
 * sentence fragment. The retry gate matches on STATE_UNCONFIRMED's stable
 * prefix (contains "NOT CONFIRMED", case-insensitive at evaluation).
 */
export const STATE_CALLING = "HomeLight is calling our line";
export const STATE_SENT = "claim message sent";
export const STATE_TAKEN = "another agent has it";
export const STATE_UNCONFIRMED = "NOT CONFIRMED, claim by hand now";

/** Schema caps extraction field descriptions at 300 chars; the test pins it. */
export const CLAIM_STATE_FIELD = {
  name: "claim_state",
  description:
    `Claim state. If it shows Pick up now, We're calling you, or Call me again answer: ${STATE_CALLING}. ` +
    `If our claim message shows as sent answer: ${STATE_SENT}. ` +
    `Taken by another agent: ${STATE_TAKEN}. ` +
    `Claim button still unused or unsure: ${STATE_UNCONFIRMED}.`
};

/**
 * On the failure page of a retry, this proves "still on the portal" broadly:
 * a retry click that finds no button (state already flipped, or truly gone)
 * must record skipped and carry on to claim_verify2, never end the run.
 */
export const RETRY_CONTINUE_MARKER = "HomeLight";

/** Every HomeLight mailbox read widens to reach back to the referral's arrival. */
export const EMAIL_LOOKBACK_MINUTES = 240;
/** AND-ed with the first-name term; a blank render is dropped, so it only narrows. */
export const PRICE_MATCH_TEMPLATE = "{{vars.price_digits}}";
export const EMAIL_READ_IDS = [
  "email_card",
  "late_read",
  "late2_read",
  "unclaimed_email_read",
  "unclaimed_email_read_2",
  "unclaimed_email_read_3"
] as const;

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  when?: { var?: string; equals?: string; notEquals?: string; contains?: string };
  branches?: Array<
    Record<string, unknown> & {
      id?: string;
      condition?: { var?: string; equals?: string; notEquals?: string; contains?: string };
      steps?: Step[];
    }
  >;
  else?: Step[];
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
 * Flip a `<statusVar> equals "missing"` gate to `<statusVar> notEquals "found"`.
 * Unset now passes (email_extract writes nothing on a no-match, so unset IS the
 * retry case), "found" still stops the ladder. Idempotent; anything else refuses.
 */
function regate(
  holder: { var?: string; equals?: string; notEquals?: string; contains?: string },
  statusVar: string,
  where: string,
  edits: string[]
): void {
  if (holder.var !== statusVar) {
    throw new Error(`${where}: gates on "${String(holder.var)}", expected "${statusVar}"`);
  }
  if (holder.notEquals === "found" && holder.equals === undefined) return; // already patched
  if (holder.equals !== "missing") {
    throw new Error(`${where}: expected equals "missing", found ${JSON.stringify(holder)}`);
  }
  delete holder.equals;
  holder.notEquals = "found";
  edits.push(`${where}: ${statusVar} equals "missing" -> notEquals "found"`);
}

/** Insert `line` on its own row directly after the row containing `anchor`. */
function insertAfterLine(text: string, anchor: string, line: string): string {
  const idx = text.indexOf(anchor);
  if (idx < 0) throw new Error(`anchor line "${anchor}" not found`);
  const lineEnd = text.indexOf("\n", idx);
  if (lineEnd < 0) return `${text}\n${line}`;
  return `${text.slice(0, lineEnd)}\n${line}${text.slice(lineEnd)}`;
}

/**
 * Apply every edit. Returns what changed so an already-patched flow reports
 * "nothing to do". Throws when the live copy is not what this was written
 * against: silently reverting someone else's edit is worse than refusing.
 */
export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];
  const trunk = def.steps;
  if (!Array.isArray(trunk)) throw new Error("definition has no steps array");

  // ── 1+2. claim_verify and the claim_fix retry branch ─────────────────────
  const click = requireStep(def, "claim_click", "browse_action");
  const clickTrunkIdx = trunk.findIndex((s) => s.id === "claim_click");
  const textTrunkIdx = trunk.findIndex((s) => s.id === "claim_text");
  if (clickTrunkIdx < 0 || textTrunkIdx !== clickTrunkIdx + 1) {
    throw new Error("claim_click / claim_text are not adjacent trunk steps");
  }
  const routeTrunkIdx = trunk.findIndex((s) => s.id === "route");
  if (routeTrunkIdx < 0) throw new Error('no trunk step "route"');
  const auth = click.auth;
  const urlVar = click.urlVar;
  if (!auth || typeof urlVar !== "string") {
    throw new Error("claim_click carries no auth/urlVar to inherit");
  }

  if (!trunk.some((s) => s.id === VERIFY_STEP_ID)) {
    trunk.splice(textTrunkIdx + 1, 0, {
      id: VERIFY_STEP_ID,
      type: "browse_extract",
      urlVar,
      auth,
      fields: [CLAIM_STATE_FIELD]
    });
    edits.push(`insert "${VERIFY_STEP_ID}" after "claim_text"`);
  }

  if (!trunk.some((s) => s.id === FIX_BRANCH_ID)) {
    const verifyIdx = trunk.findIndex((s) => s.id === VERIFY_STEP_ID);
    trunk.splice(verifyIdx + 1, 0, {
      id: FIX_BRANCH_ID,
      type: "branch",
      question: "Did the HomeLight claim register, or does it need another click?",
      else: [],
      branches: [
        {
          id: "claim_fix_go",
          label: "Claim not confirmed: click it again and re-check",
          condition: { var: CLAIM_STATE_FIELD.name, contains: "NOT CONFIRMED" },
          steps: [
            {
              id: RETRY_STEP_ID,
              type: "browse_action",
              urlVar,
              auth,
              when: { var: "claim_mode", equals: "call" },
              actions: [{ kind: "click_text", target: "Call me to claim referral" }],
              continueWhenText: RETRY_CONTINUE_MARKER
            },
            {
              id: VERIFY2_STEP_ID,
              type: "browse_extract",
              urlVar,
              auth,
              fields: [CLAIM_STATE_FIELD]
            }
          ]
        }
      ]
    });
    edits.push(`insert "${FIX_BRANCH_ID}" (retry + re-verify) after "${VERIFY_STEP_ID}"`);
  }

  // ── 3. Honest copy ───────────────────────────────────────────────────────
  const route = requireStep(def, "route", "route_to_team");
  const offerCopy = typeof route.offerTemplate === "string" ? route.offerTemplate : "";
  if (offerCopy.includes(CLAIMING_LINE)) {
    route.offerTemplate = offerCopy.replace(CLAIMING_LINE, CLAIM_STATUS_LINE);
    edits.push(`route.offerTemplate: "${CLAIMING_LINE}" -> "${CLAIM_STATUS_LINE}"`);
  } else if (!offerCopy.includes(CLAIM_STATUS_LINE)) {
    throw new Error("route.offerTemplate carries neither the old claim line nor the new one");
  }

  const ownerDirect = typeof route.ownerDirectTemplate === "string" ? route.ownerDirectTemplate : "";
  if (ownerDirect && !ownerDirect.includes(CLAIM_STATUS_LINE)) {
    const anchor = "Tap to claim: {{vars.leadUrl}}";
    if (!ownerDirect.includes(anchor)) {
      throw new Error(`route.ownerDirectTemplate has no "${anchor}" line`);
    }
    route.ownerDirectTemplate = ownerDirect.replace(anchor, `${CLAIM_STATUS_LINE}\n${anchor}`);
    edits.push("route.ownerDirectTemplate: claim status above the portal link");
  }

  const ownerFallback =
    typeof route.ownerFallbackTemplate === "string" ? route.ownerFallbackTemplate : "";
  if (ownerFallback && !ownerFallback.includes(CLAIM_STATUS_LINE)) {
    route.ownerFallbackTemplate = insertAfterLine(
      ownerFallback,
      "Address: {{vars.lead_address}}",
      CLAIM_STATUS_LINE
    );
    edits.push("route.ownerFallbackTemplate: claim status after the address");
  }

  const reminders = route.unclaimedReminders as { detailsTemplate?: string } | undefined;
  if (!reminders || typeof reminders.detailsTemplate !== "string") {
    throw new Error("route.unclaimedReminders.detailsTemplate is missing");
  }
  if (!reminders.detailsTemplate.includes(CLAIM_DETAILS_LINE)) {
    reminders.detailsTemplate = `${reminders.detailsTemplate}\n${CLAIM_DETAILS_LINE}`;
    edits.push("route.unclaimedReminders.detailsTemplate: claim line appended");
  }

  const notifyUnclaimed = requireStep(def, "notify_unclaimed", "notify_owner");
  const notifyCopy = typeof notifyUnclaimed.message === "string" ? notifyUnclaimed.message : "";
  if (!notifyCopy.includes(CLAIM_STATUS_LINE)) {
    notifyUnclaimed.message = insertAfterLine(
      notifyCopy,
      "Address: {{vars.lead_address}}",
      CLAIM_STATUS_LINE
    );
    edits.push("notify_unclaimed.message: claim status after the address");
  }

  // ── 4. Revive the reveal ladders ─────────────────────────────────────────
  const lateMissing = requireStep(def, "late_missing", "branch");
  const lateArm = (lateMissing.branches ?? []).find((b) => b.id === "late_missing_hit");
  if (!lateArm?.condition) throw new Error('branch "late_missing" has no "late_missing_hit" arm');
  regate(lateArm.condition, "contact_status", 'arm "late_missing_hit"', edits);

  for (const [id, statusVar] of [
    ["unclaimed_wait_2", "u1_status"],
    ["unclaimed_email_read_2", "u1_status"],
    ["unclaimed_wait_3", "u2_status"],
    ["unclaimed_email_read_3", "u2_status"]
  ] as const) {
    const step = [...walkSteps(def.steps)].find((s) => s.id === id);
    if (!step?.when) throw new Error(`step "${id}" with a when-gate not found`);
    regate(step.when, statusVar, `"${id}".when`, edits);
  }

  // ── 5. Wider, tighter mailbox reads ──────────────────────────────────────
  for (const id of EMAIL_READ_IDS) {
    const read = requireStep(def, id, "email_extract");
    const lookback = typeof read.lookbackMinutes === "number" ? read.lookbackMinutes : 0;
    if (lookback < EMAIL_LOOKBACK_MINUTES) {
      read.lookbackMinutes = EMAIL_LOOKBACK_MINUTES;
      edits.push(`"${id}".lookbackMinutes: ${lookback} -> ${EMAIL_LOOKBACK_MINUTES}`);
    }
    const match = read.matchTemplates;
    if (!Array.isArray(match) || !match.includes("{{vars.lead_first_name}}")) {
      throw new Error(`"${id}".matchTemplates does not carry the first-name term`);
    }
    if (!match.includes(PRICE_MATCH_TEMPLATE)) {
      match.push(PRICE_MATCH_TEMPLATE);
      edits.push(`"${id}".matchTemplates: add ${PRICE_MATCH_TEMPLATE}`);
    }
  }

  return edits;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const bi = process.argv.indexOf("--business-id");
  const businessId = bi >= 0 ? (process.argv[bi + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required."
    );
    process.exit(2);
  }
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (isRevert) {
    const { data: rows, error } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", SCRIPT)
      .order("applied_at", { ascending: false });
    if (error) {
      console.error(`Ledger read failed: ${error.message}`);
      process.exit(1);
    }
    const newest = (rows ?? [])
      .map((r) => (r as { details: Record<string, unknown> | null }).details)
      .find((d) => d && d.reverted !== true && d.previous);
    if (!newest) {
      console.error("No applied ledger rows with a previous definition to revert to.");
      process.exit(2);
    }
    const previous = newest.previous as { flow_id: string; flow: string; definition: unknown };
    console.log(`revert ${previous.flow} (${previous.flow_id})`);
    if (!apply) {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
      return;
    }
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: previous.definition })
      .eq("id", previous.flow_id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Revert failed: ${upErr.message}`);
      process.exit(1);
    }
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: { reverted: true, flow: previous.flow }
    });
    console.log("  -> reverted.");
    return;
  }

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

  let edits: string[];
  try {
    edits = patchDefinition(def);
  } catch (err) {
    console.error(
      `Unexpected shape for "${flow.name}" (${flow.id}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "The flow was edited elsewhere; re-read it before patching."
    );
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Flow     : ${flow.name} (${flow.id})`);
  if (edits.length === 0) {
    console.log("\nAlready patched, nothing to do.");
    return;
  }
  for (const edit of edits) console.log(`Edit     : ${edit}`);

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`\nPatched definition is invalid:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`\nPatched definition is invalid: ${String(err)}`);
    }
    process.exit(2);
  }

  if (!apply) {
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
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: {
      flow_id: flow.id,
      flow_name: flow.name,
      edits,
      previous: { flow_id: flow.id, flow: flow.name, definition: flow.definition }
    }
  });
  console.log(`\nApplied (${edits.length} edit(s)).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
