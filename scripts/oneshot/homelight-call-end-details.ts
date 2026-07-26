#!/usr/bin/env tsx
/**
 * One-shot: stop letting HomeLight's withheld contact details break Amy's
 * referral follow-up.
 *
 * HomeLight does not release the seller's phone number until AFTER the call it
 * bridges. The flow read the portal exactly once, about a minute in, so:
 *   - `card` came back with a blank contact card,
 *   - `qt_email` attached a screenshot of that blank card and shipped empty
 *     fields to Amy,
 *   - and the only second looks were the 10-minute and 1-hour INBOX rungs, which
 *     by definition run after the call is over and never re-read the website.
 *
 * Four idempotent edits, all inserted around the existing steps:
 *
 *   1. RE-READ THE WEBSITE while the AI is still on the call (2 minutes, then 3
 *      more if still withheld), and hand anything that appears to the live
 *      conversation with a voice_brief. `fillOnlyEmpty` on both reads, because a
 *      re-read that STILL shows a blank card must not erase what we have.
 *   2. WAIT FOR THE CALL, then read the portal once more. This is the read that
 *      matters: HomeLight releases on the call attempt, so the page is finally
 *      populated. It carries `screenshot: true`, and since each screenshotting
 *      browse overwrites {{vars.screenshot_path}}, the existing `qt_email` (which
 *      runs after it) now attaches the card WITH the details on it instead of
 *      the blank pre-release one. That ordering is the whole fix for the QT.
 *   3. The wait also brings back what the AI got out of the seller DIRECTLY. The
 *      person on the line is often the only source for their own number, so
 *      those values backfill `lead_*` when nothing else supplied them, and the
 *      team-facing texts show both numbers labeled by source.
 *   4. ASK DAVE WHEN HE WILL CALL, folded into the `to_agent` text and the
 *      EXISTING `bp_wait` reply park (which already waits on the claimer's next
 *      message). A second route_to_team would have been the obvious way to get
 *      the "1" / "1, 20 min" handshake, but its owner fallback resets
 *      claimed_agent/claimed_agent_phone to "none", which would break every
 *      claim-gated step after it, `bp_wait`'s own phoneVar included.
 *
 * Requires the engine support (wait_for_call + browse_extract.fillOnlyEmpty)
 * deployed on the ai-flow-worker before --apply: an old worker would fail the
 * unknown step type.
 *
 * Validates the patched definition through parseAiFlowDefinition before writing;
 * dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-call-end-details.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-call-end-details.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
 *           HOMELIGHT_VOICE_FROM       (default "+14159851909")
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

export type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Array<{ name?: string; description?: string }>;
  branches?: Array<Record<string, unknown>>;
  else?: unknown;
};
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Anchors this patch reads. Missing one means the flow was rebuilt: fail loudly. */
export const CARD_STEP_ID = "card";
export const BRIEF_STEP_ID = "brief_call";
export const TO_AGENT_STEP_ID = "to_agent";
export const CLASSIFY_STEP_ID = "bp_classify";
export const BRANCH_STEP_ID = "bp_branch";

/** Step ids this patch adds, so a re-run recognizes its own work. */
export const RECHECK_STEP_IDS = [
  "recheck1_wait",
  "recheck1",
  "brief_release",
  "recheck2_wait",
  "recheck2",
  "brief_release2",
  "wait_hl_call",
  "final_read"
] as const;
export const ETA_ARM_ID = "bp_calling_at";

/**
 * Sentinel: has HomeLight released the contact details on the page yet? One var
 * PER READ, because the re-reads are `fillOnlyEmpty` and that applies to every
 * field on the step: a shared sentinel would freeze at whatever the first look
 * saw ("withheld"), and could never flip to "released" afterwards. The existing
 * retry rungs already use per-rung sentinels (late_/late2_) for the same reason.
 */
export const RELEASE_VARS = ["contact_release", "contact_release2", "contact_release3"] as const;
/** The first look's sentinel, which gates whether a second look happens. */
export const RELEASE_VAR = RELEASE_VARS[0];
/** Namespace for what the AI captured on the call. */
export const CALL_PREFIX = "call_";
/** The classify category for "here is when I will call them". */
export const ETA_CATEGORY = "calling_at";

const CLAIMED_WHEN = { var: "claimed_agent", notEquals: "none" } as const;
const NOT_RELEASED_WHEN = { var: RELEASE_VAR, notEquals: "released" } as const;

const releasedWhen = (v: string) => ({ var: v, equals: "released" });

const releaseField = (name: string) => ({
  name,
  description:
    "Answer exactly one lowercase word: released if this page now shows the CLIENT's own " +
    "phone number or email, withheld if it does not. Never count the agent's own contact " +
    "details or a HomeLight support number."
});

/** Walk the trunk and every nested arm, yielding each step. */
function walkSteps(steps: unknown, visit: (step: Step) => void): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    visit(step);
    if (Array.isArray(step.branches)) {
      for (const arm of step.branches) walkSteps(arm?.steps, visit);
    }
    walkSteps(step.else, visit);
  }
}

/** Find a step by id anywhere in the definition (trunk or nested arm). */
export function findStep(def: Definition, id: string): Step | null {
  let found: Step | null = null;
  walkSteps(def.steps, (step) => {
    if (found === null && step.id === id) found = step;
  });
  return found;
}

/**
 * The contact fields a portal re-read pulls. Copied from the `card` step so the
 * extractor is told the same "never the agent's own details" rules; re-reads
 * only ever BACKFILL, so a still-blank page cannot undo an earlier read.
 */
function contactFields(def: Definition): Array<{ name?: string; description?: string }> {
  const card = findStep(def, CARD_STEP_ID);
  if (!card) throw new Error(`step "${CARD_STEP_ID}" not found`);
  const wanted = new Set(["lead_name", "lead_phone", "lead_email", "lead_address"]);
  const fields = (card.fields ?? []).filter((f) => f?.name && wanted.has(f.name));
  if (fields.length === 0) throw new Error(`step "${CARD_STEP_ID}" has no contact fields to reuse`);
  return fields.map((f) => ({ ...f }));
}

/** A credentialed portal re-read that only fills gaps. */
function rereadStep(
  def: Definition,
  id: string,
  when: Record<string, unknown>,
  releaseVar: string,
  opts: { screenshot?: boolean } = {}
): Step {
  const card = findStep(def, CARD_STEP_ID)!;
  return {
    id,
    type: "browse_extract",
    urlVar: "leadUrl",
    ...(card.auth ? { auth: card.auth } : {}),
    // The point of the re-read: keep whatever the first pass (or the seller on
    // the call) already established, and only fill what is still blank. Note
    // this also freezes the release sentinel, which is why each read gets its
    // own (see RELEASE_VARS).
    fillOnlyEmpty: true,
    ...(opts.screenshot ? { screenshot: true } : {}),
    when,
    fields: [...contactFields(def), releaseField(releaseVar)]
  };
}

/**
 * Edit 1+2+3: the re-read block, inserted directly after `brief_call` so it sits
 * before `email_card` and the `lost_branch` sends. Everything downstream then
 * reads the post-call truth, and `qt_email` attaches the post-call screenshot
 * without needing to be moved.
 */
export function addRecheckBlock(def: Definition, fromE164: string): boolean {
  const steps = def.steps ?? [];
  if (steps.some((s) => s.id === "wait_hl_call")) return false;
  const at = steps.findIndex((s) => s.id === BRIEF_STEP_ID);
  if (at === -1) throw new Error(`trunk step "${BRIEF_STEP_ID}" not found`);
  // Hand the released card to the conversation still in progress. One per look,
  // because each look reports into its own sentinel. Double-briefing is not a
  // risk: the engine skips a brief when nothing rendered, and
  // voice_set_call_brief ignores a note it has already delivered.
  const briefStep = (id: string, releaseVar: string): Step => ({
    id,
    type: "voice_brief",
    fromE164,
    noteTemplate:
      "HomeLight just released the client's contact details: {{vars.lead_phone}} " +
      "{{vars.lead_email}}. Property address: {{vars.lead_address}}.",
    withinMinutes: 30,
    when: releasedWhen(releaseVar)
  });
  const block: Step[] = [
    { id: "recheck1_wait", type: "sleep", minutes: 2, when: CLAIMED_WHEN },
    rereadStep(def, "recheck1", CLAIMED_WHEN, RELEASE_VARS[0]),
    briefStep("brief_release", RELEASE_VARS[0]),
    // Only if the first look came up empty: a released card needs no second try.
    { id: "recheck2_wait", type: "sleep", minutes: 3, when: NOT_RELEASED_WHEN },
    rereadStep(def, "recheck2", NOT_RELEASED_WHEN, RELEASE_VARS[1]),
    briefStep("brief_release2", RELEASE_VARS[1]),
    // Park until the AI hangs up. What it got out of the seller comes back under
    // call_*, and backfills the flow's own vars when HomeLight supplied nothing:
    // the contact record and the seller's intro text need ONE number, and on a
    // withheld referral the conversation is the only place it exists.
    {
      id: "wait_hl_call",
      type: "wait_for_call",
      fromE164,
      withinMinutes: 30,
      timeoutMinutes: 45,
      saveAs: "hl_call_outcome",
      capturePrefix: CALL_PREFIX,
      backfill: [
        { from: "phone", to: "lead_phone" },
        { from: "email", to: "lead_email" },
        { from: "address", to: "lead_address" },
        { from: "name", to: "lead_name" }
      ],
      when: CLAIMED_WHEN
    },
    // The read that finally sees a populated card, and the screenshot the QT
    // email attaches (each screenshotting browse overwrites screenshot_path, and
    // this is the last one before qt_email runs).
    rereadStep(def, "final_read", CLAIMED_WHEN, RELEASE_VARS[2], { screenshot: true })
  ];
  def.steps = [...steps.slice(0, at + 1), ...block, ...steps.slice(at + 1)];
  return true;
}

/** The line that asks Dave when he will call. Doubles as the idempotency marker. */
export const ETA_ASK_LINE = "When can you call? Reply 1 if you're calling now";

/** The labeled second number, so a disagreement between sources is visible. */
export const SPOKEN_LINE = `Seller said on the call: {{vars.${CALL_PREFIX}phone}}`;

/**
 * Edit 4a: add the WHEN question and the spoken number to the claimer's text.
 *
 * Inserted into the existing body rather than rewritten over it: the body
 * references lead_type/city/price that earlier steps produce, and Amy edits this
 * copy by hand. Both numbers are always present ("none" when the AI got
 * nothing), so neither line can render as a dangling label.
 */
export function addEtaAsk(def: Definition): boolean {
  const toAgent = findStep(def, TO_AGENT_STEP_ID);
  if (!toAgent) throw new Error(`step "${TO_AGENT_STEP_ID}" not found`);
  const body = typeof toAgent.body === "string" ? toAgent.body : "";
  if (!body || body.includes(ETA_ASK_LINE)) return false;
  const lines = body.split("\n");
  // Directly under the address, next to the details it qualifies.
  const addressAt = lines.findIndex((l) => l.includes("{{vars.lead_address}}"));
  if (addressAt === -1) lines.push(SPOKEN_LINE);
  else lines.splice(addressAt + 1, 0, SPOKEN_LINE);
  lines.push(
    `${ETA_ASK_LINE}, or "1, 20 min" to tell us when.`,
    "If the number is bad, just say so."
  );
  toAgent.body = lines.join("\n");
  return true;
}

/**
 * Edit 4b: teach the EXISTING agent-reply classifier to recognize the answer.
 * `bp_wait` already parks on the claimer's next text, so the "when can you call"
 * handshake costs no extra wait and cannot reset the claim the way a second
 * route_to_team offer would.
 */
export function addEtaCategory(def: Definition): boolean {
  const classify = findStep(def, CLASSIFY_STEP_ID);
  if (!classify) throw new Error(`step "${CLASSIFY_STEP_ID}" not found`);
  const categories = Array.isArray(classify.categories)
    ? (classify.categories as Array<{ value?: string; description?: string }>)
    : null;
  if (!categories) throw new Error(`step "${CLASSIFY_STEP_ID}" has no categories`);
  if (categories.some((c) => c?.value === ETA_CATEGORY)) return false;
  // Ahead of other_update, which is the catch-all: first match wins.
  categories.splice(categories.length - 1, 0, {
    value: ETA_CATEGORY,
    description:
      "says WHEN they will call the lead, or confirms they are calling now - a bare " +
      '"1", "1, 20 min", "calling now", "in an hour", "after 5", or any other stated timing'
  });
  return true;
}

/**
 * Edit 4c: tell Amy what he said. A new arm on the existing branch, ahead of the
 * else so the timing reply is not forwarded as a generic update.
 */
export function addEtaArm(def: Definition): boolean {
  const branch = findStep(def, BRANCH_STEP_ID);
  if (!branch) throw new Error(`step "${BRANCH_STEP_ID}" not found`);
  if (!Array.isArray(branch.branches)) throw new Error(`step "${BRANCH_STEP_ID}" has no arms`);
  if (branch.branches.some((a) => a?.id === ETA_ARM_ID)) return false;
  branch.branches.push({
    id: ETA_ARM_ID,
    label: "Said when they'll call",
    condition: { var: "agent_report_class", equals: ETA_CATEGORY },
    steps: [
      {
        id: "bp_eta_notify",
        type: "notify_owner",
        message:
          "{{vars.claimed_agent}} says when they'll call {{vars.lead_name}} " +
          "({{vars.lead_phone}}): \"{{vars.agent_report}}\""
      }
    ]
  });
  return true;
}

/**
 * Edit 4d: the QT email carries both numbers labeled, so a disagreement between
 * what HomeLight has on file and what the seller said out loud is visible rather
 * than silently resolved.
 */
export const QT_SPOKEN_LINE = "Seller said on the call:";

export function addSpokenToQt(def: Definition): boolean {
  const qt = findStep(def, "qt_email");
  if (!qt) throw new Error('step "qt_email" not found');
  const body = typeof qt.body === "string" ? qt.body : "";
  if (!body || body.includes(QT_SPOKEN_LINE)) return false;
  qt.body = body.replace(
    "Address: {{vars.lead_address}}",
    `Address: {{vars.lead_address}}\n${QT_SPOKEN_LINE} {{vars.${CALL_PREFIX}phone}} ` +
      `{{vars.${CALL_PREFIX}email}}`
  );
  return qt.body !== body;
}

export function applyAll(def: Definition, fromE164: string): string[] {
  const applied: string[] = [];
  if (addRecheckBlock(def, fromE164)) applied.push("re-read block");
  if (addEtaAsk(def)) applied.push("when-can-you-call ask");
  if (addEtaCategory(def)) applied.push("classifier category");
  if (addEtaArm(def)) applied.push("timing-reply arm");
  if (addSpokenToQt(def)) applied.push("QT spoken line");
  return applied;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const fromE164 = process.env.HOMELIGHT_VOICE_FROM ?? "+14159851909";

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
    applied = applyAll(def, fromE164);
  } catch (err) {
    console.error(
      `The flow does not have the shape this patch expects, so nothing was written: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(2);
  }
  if (applied.length === 0) {
    console.log("Flow already patched, nothing to do.");
    return;
  }

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`Patched "${flow.name}" would become INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  console.log(`=== ${flow.name} (${flow.id}) ===`);
  for (const a of applied) console.log(`  applied: ${a}`);
  console.log(`  trunk steps: ${(def.steps ?? []).length}`);
  console.log(`\nAFTER: ${JSON.stringify(def)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }
  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update failed for ${flow.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-call-end-details.ts",
    businessId,
    details: { flow_id: flow.id, flow_name: flow.name, applied }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
