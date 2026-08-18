#!/usr/bin/env tsx
/**
 * One-shot: Amy's owner-notification policy.
 *
 * Amy, 2026-08-17: "Notify owner on all appointments booked. Notify owner
 * when a lead is not claimed with Red exclamation marks. Turn off all other
 * notifications to owner (notify owner step if lead was routed to a team
 * member aka owner isn't needed). All leads for Buyers & Sellers under $1
 * million to also get follow up for three days with texts and calls by Ai.
 * All leads for Buyers & Seller over $1 million to get sent to owner in
 * capital letters, high dollar lead with red exclamation marks and after
 * three attempts to owner and unclaimed by owner, lead to get follow up for
 * three days with text and calls by Ai."
 *
 * WHAT THIS SCRIPT DOES, AND WHAT IT DELIBERATELY DOES NOT:
 *
 *  - Appointment alerts are NOT here. `maybeAlertUnassignedBooking` already
 *    fires on every confirmed booking (the flag reads
 *    `unassigned_booking_alerts`, but it dispatches on all three ownership
 *    states: solo, covered, unowned). Amy's row has it ON. Nothing to change
 *    in the flows; the employee-recipient half is a platform change, not a
 *    flow change.
 *  - Under $1M follow-up is NOT here either. `price_under_1m` already gates
 *    the "Needs Follow Up" takeover in every flow that has one, and buyers
 *    reach it (they always read `price_gate: "team"`, so they clear the
 *    `notEquals "ai"` guard). Verified against the live definitions.
 *
 * So three things change, and all three are edits to existing steps or new
 * sibling arms. Nothing is deleted and nothing is reordered:
 *
 *  1. BANNER THE UNCLAIMED NOTICES. Every `ownerFallbackTemplate` (the
 *     "nobody claimed this" text a route step sends the owner) and every
 *     owner notice that means "nobody has this lead" gains the same
 *     `‼️‼️‼️‼️‼️` banner the final claim reminder already uses
 *     (FINAL_REMINDER_BANNER in _shared/ai_flows/offer_reminders.ts). One
 *     banner, one meaning, across the account.
 *
 *  2. SILENCE THE ROUTED NOTICES. A `notify_owner` that only ever says "a
 *     teammate has this and here is what happened" gets an UNSATISFIABLE
 *     `when` instead of being removed. That matters: `ai_flow_runs
 *     .current_step` is a flat index over the flattened definition, so
 *     deleting a step renumbers every step after it and walks parked runs
 *     onto the wrong instruction. A step that stays in place and evaluates
 *     false costs one skipped index and moves nothing.
 *
 *     The guard compares a var the step ALREADY reads against a value nothing
 *     can hold: `owner-notice-disabled-by-amy-2026-08-17`. An invented var
 *     would have been tidier, and does not work: parseAiFlowDefinition
 *     rejects a `when` naming a var no earlier step produces, which is the
 *     right rule and is why the guard borrows an existing one.
 *
 *     KEPT ON, because each one means Amy still has to do something:
 *     unclaimed notices, "no phone so nobody was offered this lead", the two
 *     Clever call-failure alerts, the Clever capacity alert, and HomeLight's
 *     "they never sent the contact info at all".
 *
 *  3. THE $1M+ PATH. `ownerDirectTemplate` swaps its `****************` rules
 *     for the same `‼️‼️‼️‼️‼️` banner and puts the headline in capitals, and
 *     each `*_team_unclaimed` branch gains the arm it never had. Today those
 *     branches carry ONE arm (`price_under_1m notEquals "no"`) and an empty
 *     `else`, so a $1M+ lead Amy never claimed falls out of the flow with no
 *     follow-up at all. The new arm waits out her attempts and then tags
 *     "Needs Follow Up", the account's single chokepoint for AI follow-up.
 *
 *     HOMELIGHT IS EXEMPT from the new arm, for the same reason it was exempt
 *     from the under-$500K gate: it withholds the lead's phone and email until
 *     a claim happens, so there is nothing for a text-and-call cadence to run
 *     against. Its banner and capitals still apply.
 *
 * "UNCLAIMED BY OWNER" IS NOT `claimed_agent`. The worker states it outright:
 * an owner ack stops the reminders but "claimed_agent stays 'none'
 * throughout (the owner acking is NOT a teammate claim)". Gating the new arm
 * on claimed_agent would have swept every $1M+ lead Amy DID acknowledge into
 * the AI cadence. It gates on the exhaustion marker the worker appends to
 * actions_taken instead, which fires only after the alert and both reminders
 * went unanswered: exactly the "three attempts to owner" Amy described.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-owner-notice-policy.ts            # dry run
 *   npx tsx scripts/oneshot/amy-owner-notice-policy.ts --apply
 *   npx tsx scripts/oneshot/amy-owner-notice-policy.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { FOLLOW_UP_TAG } from "./amy-needs-follow-up-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-owner-notice-policy.ts";

/**
 * Same five characters as FINAL_REMINDER_BANNER
 * (supabase/functions/_shared/ai_flows/offer_reminders.ts). Copied rather than
 * imported: this script builds definitions for the Next app's schema and must
 * not pull an Edge-runtime module into that graph. A test pins the two equal.
 */
export const UNCLAIMED_BANNER = "‼️‼️‼️‼️‼️";

/**
 * The value a silenced notice waits for, and will never see.
 *
 * The first attempt here used a var of its own (`owner_notice_enabled`), and
 * `parseAiFlowDefinition` rejected it: a `when` may only name a var some
 * EARLIER step produces, so an invented var cannot be written at all. That
 * guard is right, so the guard reuses a var the step already has instead and
 * compares it to a value nothing can ever hold. A teammate's report, a lead's
 * name, and a routing verdict are all free to be anything except this.
 *
 * Spelling it out longhand is deliberate: whoever opens the flow builder next
 * sees why the step is off without having to find this file.
 */
export const OWNER_NOTICE_OFF = "owner-notice-disabled-by-amy-2026-08-17";

/**
 * What the worker appends to `actions_taken` when the owner ignored the
 * high-value alert AND both reminders (ownerDirectResume, the nudges-exhausted
 * path). Copied literal, pinned to the worker source by a test.
 *
 * This, not `claimed_agent`, is the signal for "unclaimed by owner". The
 * worker is explicit that an owner ack is not a claim: "A reply, any reply,
 * acknowledges the alert and stops the reminders; claimed_agent stays 'none'
 * throughout (the owner acking is NOT a teammate claim)". Gating the takeover
 * on `claimed_agent == "none"` would therefore have swept every $1M+ lead Amy
 * DID acknowledge into the AI cadence, which is the opposite of her rule.
 *
 * Matching the exhaustion marker positively also means no waiting step is
 * needed: the route step does not complete until the owner replies or the
 * second reminder lapses at 30 minutes, so the verdict is already in
 * `actions_taken` by the time this branch evaluates. And a late "1" cannot
 * change it, because the exhaustion path deletes `step_index`, which makes the
 * late-claim matcher skip the run entirely.
 */
export const OWNER_IGNORED_MARKER = "owner did not acknowledge the high-value alert";

type Step = Record<string, unknown>;
export type Definition = { steps?: Step[] } & Record<string, unknown>;
export type PatchResult = { changed: boolean; notes: string[] };

/** Find a step by id anywhere in the tree (arms and else included). */
export function findStepDeep(steps: Step[] | undefined, id: string): Step | undefined {
  for (const s of steps ?? []) {
    if (s.id === id) return s;
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps?: Step[] }> | undefined) ?? []) {
        const hit = findStepDeep(arm.steps, id);
        if (hit) return hit;
      }
      const inElse = findStepDeep(s.else as Step[] | undefined, id);
      if (inElse) return inElse;
    }
  }
  return undefined;
}

/** Every step in the tree, arms and else included, in definition order. */
export function allSteps(steps: Step[] | undefined): Step[] {
  const out: Step[] = [];
  for (const s of steps ?? []) {
    out.push(s);
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps?: Step[] }> | undefined) ?? []) {
        out.push(...allSteps(arm.steps));
      }
      out.push(...allSteps(s.else as Step[] | undefined));
    }
  }
  return out;
}

// --- 1. Banner the unclaimed notices ----------------------------------------

/**
 * Prefix the banner to `text`, unless it already carries it. Returns the text
 * unchanged when it does, so a re-run is a no-op rather than a stack of
 * banners.
 */
export function withBanner(text: string): string {
  return text.startsWith(UNCLAIMED_BANNER) ? text : `${UNCLAIMED_BANNER}\n${text}`;
}

/**
 * Banner every `ownerFallbackTemplate` in the flow. That field is BY
 * DEFINITION the unclaimed notice: a route step sends it only when the offer
 * window closed with nobody claiming, so there is no need to name the steps
 * one by one, and a route step added later is covered automatically.
 */
export function bannerOwnerFallbacks(def: Definition, notes: string[]): boolean {
  let changed = false;
  for (const s of allSteps(def.steps)) {
    const cur = s.ownerFallbackTemplate;
    if (typeof cur !== "string" || cur.length === 0) continue;
    const next = withBanner(cur);
    if (next === cur) continue;
    s.ownerFallbackTemplate = next;
    notes.push(`${String(s.id)}: ownerFallbackTemplate banner`);
    changed = true;
  }
  return changed;
}

/**
 * Banner a named `notify_owner` message. Used for the unclaimed notices that
 * are their own step rather than a route step's fallback (HomeLight's
 * `notify_unclaimed`, and the two "no phone so nobody was offered this"
 * notices).
 */
export function bannerNotice(def: Definition, stepId: string, notes: string[]): boolean {
  const step = findStepDeep(def.steps, stepId);
  if (!step || step.type !== "notify_owner") {
    throw new Error(`notify_owner ${stepId} not found; aborting rather than guessing`);
  }
  const cur = step.message;
  if (typeof cur !== "string") throw new Error(`notify_owner ${stepId} has no message`);
  const next = withBanner(cur);
  if (next === cur) return false;
  step.message = next;
  notes.push(`${stepId}: unclaimed notice banner`);
  return true;
}

// --- 2. Silence the routed notices ------------------------------------------

/**
 * Give a `notify_owner` a guard that can never hold, so the step stays at its
 * index and is skipped forever.
 *
 * The var is the one the step's own `when` already names, because the
 * validator has already accepted that var as produced by an earlier step.
 * A step with no `when` has no such proof, so the caller names a var the
 * step's own message renders: same guarantee, stated explicitly rather than
 * guessed.
 */
export function silenceNotice(
  def: Definition,
  stepId: string,
  fallbackVar: string | undefined,
  notes: string[]
): boolean {
  const step = findStepDeep(def.steps, stepId);
  if (!step || step.type !== "notify_owner") {
    throw new Error(`notify_owner ${stepId} not found; aborting rather than guessing`);
  }
  const cur = step.when as { var?: string; equals?: string } | undefined;
  if (cur?.equals === OWNER_NOTICE_OFF) return false;
  const guardVar = cur?.var ?? fallbackVar;
  if (!guardVar) {
    throw new Error(`notify_owner ${stepId} has no when var and no fallback var was given`);
  }
  step.when = { var: guardVar, equals: OWNER_NOTICE_OFF };
  notes.push(`${stepId}: silenced on ${guardVar} (step kept in place, index unchanged)`);
  return true;
}

/**
 * Silence a list of notices. Each entry is the step id, optionally followed by
 * the var to guard on when the step carries no `when` of its own.
 */
export function silenceNotices(
  def: Definition,
  entries: Array<string | [string, string]>,
  notes: string[]
): boolean {
  let changed = false;
  for (const entry of entries) {
    const [id, fallbackVar] = typeof entry === "string" ? [entry, undefined] : entry;
    if (silenceNotice(def, id, fallbackVar, notes)) changed = true;
  }
  return changed;
}

// --- 3. The $1M+ path -------------------------------------------------------

/**
 * The old rules line. Two per template (open and close), and the literal is
 * distinctive enough that a plain replace cannot hit anything else.
 */
export const OLD_HIGH_VALUE_RULE = "****************";

/**
 * The headline as it stands today, e.g.
 *   "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you, not offered to the team."
 *   "HIGH-VALUE Realtor.com lead ($1M+) kept for you, not offered to the team."
 * The subject is captured so the source name survives the rewrite.
 */
const HEADLINE_RE =
  /^HIGH-VALUE (.+?) \(\$1M\+\) kept for you, not offered to the team\.$/m;

/**
 * Amy asked for "high dollar lead" in capital letters. Uppercasing the whole
 * line would mangle `{{vars.lead_type}}` into `{{VARS.LEAD_TYPE}}`, which
 * renders as literal text, so the placeholder is dropped from the headline
 * instead: the detail lines underneath already carry the lead type, and every
 * flow then reads with the same shape ("HIGH DOLLAR LEAD", "HIGH DOLLAR
 * REALTOR.COM LEAD", "HIGH DOLLAR HOMELIGHT REFERRAL").
 */
export function highDollarHeadline(subject: string): string {
  const cleaned = subject.replace(/\{\{[^}]*\}\}\s*/g, "").trim();
  return `HIGH DOLLAR ${cleaned.toUpperCase()} ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM.`;
}

/** Rewrite one ownerDirectTemplate: banner rules, capitalised headline. */
export function rewriteHighDollarTemplate(template: string): string {
  const withRules = template.split(OLD_HIGH_VALUE_RULE).join(UNCLAIMED_BANNER);
  return withRules.replace(HEADLINE_RE, (_full, subject: string) =>
    highDollarHeadline(subject)
  );
}

/** Rewrite every ownerDirectTemplate in the flow. */
export function rewriteHighDollarTemplates(def: Definition, notes: string[]): boolean {
  let changed = false;
  for (const s of allSteps(def.steps)) {
    const cur = s.ownerDirectTemplate;
    if (typeof cur !== "string" || cur.length === 0) continue;
    const next = rewriteHighDollarTemplate(cur);
    if (next === cur) continue;
    s.ownerDirectTemplate = next;
    notes.push(`${String(s.id)}: ownerDirectTemplate banner + capitals`);
    changed = true;
  }
  return changed;
}

/**
 * Add the $1M+ arm to a `*_team_unclaimed` branch.
 *
 * The arm is a sibling APPENDED after the existing under-$1M arm, so every
 * index inside that arm is untouched. The tag step is cloned from the
 * flow's own existing takeover tag rather than written from scratch: each
 * flow names its phone var differently and some carry a note that tells the
 * cadence's round 1 whether a call already happened, and copying keeps the
 * new arm honest without a per-flow table here.
 */
export function addHighDollarTakeover(
  def: Definition,
  branchId: string,
  prefix: string,
  notes: string[],
  opts: { ownerDirect: boolean } = { ownerDirect: true }
): boolean {
  const branch = findStepDeep(def.steps, branchId);
  if (!branch || branch.type !== "branch") {
    throw new Error(`branch ${branchId} not found; aborting rather than guessing`);
  }
  const arms = branch.branches as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error(`branch ${branchId} has no arms`);
  }
  const armId = `${prefix}_tu_high`;
  if (arms.some((a) => a.id === armId)) return false;

  // Clone the existing takeover tag so phoneVar / noteTemplate match the
  // flow. Every *_team_unclaimed has at least one; if that stops being true
  // the shape changed and guessing would be wrong.
  const existingTag = allSteps(
    arms.flatMap((a) => (a.steps as Step[] | undefined) ?? [])
  ).find(
    (s) =>
      s.type === "update_contact" &&
      Array.isArray(s.addTags) &&
      (s.addTags as string[]).includes(FOLLOW_UP_TAG)
  );
  if (!existingTag) {
    throw new Error(`branch ${branchId} has no existing ${FOLLOW_UP_TAG} tag step to copy`);
  }
  const tag: Step = {
    id: `${armId}_tag`,
    type: "update_contact",
    phoneVar: existingTag.phoneVar,
    addTags: [FOLLOW_UP_TAG]
  };
  // The note tells the cadence whether a call already went out. On this path
  // no AI call has happened (the lead was Amy's direct, never contacted), so
  // the cadence's immediate round-1 call IS the first contact and the note is
  // deliberately omitted.

  // Which "nobody has this" actually applies depends on who was asked.
  //
  //  - ownerDirect flows kept the $1M+ lead for Amy and never offered it, so
  //    claimed_agent is "none" whether she answered or not. The only honest
  //    signal is the worker's exhaustion marker.
  //  - Follow Up Requested has no ownerDirectTemplate at all, so its $1M+
  //    leads DO go to the team and claimed_agent means what it usually means.
  const stillOpen = opts.ownerDirect
    ? { var: "actions_taken", contains: OWNER_IGNORED_MARKER }
    : { var: "claimed_agent", equals: "none" };

  arms.push({
    id: armId,
    label: opts.ownerDirect
      ? "$1M+: Amy had it direct, and all three attempts lapsed unanswered"
      : "$1M+: offered to the team and nobody claimed it",
    condition: { var: "price_under_1m", equals: "no" },
    steps: [
      {
        id: `${armId}_check`,
        type: "branch",
        question: opts.ownerDirect
          ? "Did the owner ignore the high-dollar alert and both reminders?"
          : "Still unclaimed after the offer ran its course?",
        else: [],
        branches: [
          {
            id: `${armId}_still`,
            label: "Nobody has this lead: the AI owns the follow-up now",
            condition: stillOpen,
            steps: [tag]
          }
        ]
      }
    ]
  });
  notes.push(`${branchId}: $1M+ arm added (${armId}), under-$1M arm untouched`);
  return true;
}

// --- Per-flow patchers -------------------------------------------------------

export function patchReferralExchange(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  if (bannerNotice(def, "notify_no_phone", notes)) changed = true;
  if (
    silenceNotices(def, ["notify", "notify_both", "notify_buyer", "bp_forward"], notes)
  ) {
    changed = true;
  }
  if (rewriteHighDollarTemplates(def, notes)) changed = true;
  if (addHighDollarTakeover(def, "re_team_unclaimed", "re", notes)) changed = true;
  return { changed, notes };
}

export function patchRealtor(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  if (silenceNotices(def, [["s5", "lead_name"], "bp_forward"], notes)) changed = true;
  if (rewriteHighDollarTemplates(def, notes)) changed = true;
  if (addHighDollarTakeover(def, "rt_team_unclaimed", "rt", notes)) changed = true;
  return { changed, notes };
}

export function patchNewLeadIntake(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  if (bannerNotice(def, "notify_no_phone", notes)) changed = true;
  if (silenceNotices(def, ["notify"], notes)) changed = true;
  if (rewriteHighDollarTemplates(def, notes)) changed = true;
  if (addHighDollarTakeover(def, "nli_team_unclaimed", "nli", notes)) changed = true;
  return { changed, notes };
}

export function patchCleverAccept(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  // call_gap_alert / call_fail_alert stay ON: "the AI never dialled" and "the
  // call failed" both mean nobody has spoken to this lead.
  if (silenceNotices(def, [["notify", "lead_name"], "bp_forward"], notes)) changed = true;
  if (rewriteHighDollarTemplates(def, notes)) changed = true;
  if (addHighDollarTakeover(def, "clever_team_unclaimed", "clever", notes)) changed = true;
  return { changed, notes };
}

export function patchHomeLight(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  if (bannerNotice(def, "notify_unclaimed", notes)) changed = true;
  // late2_never_notify stays ON: HomeLight never sent the contact info, so
  // no outreach of any kind went out and Amy has to work the portal.
  if (
    silenceNotices(
      def,
      [
        "notify",
        "lost_notify",
        "late_notify",
        "late2_notify",
        "bp_forward",
        ["bp_eta_notify", "claimed_agent"]
      ],
      notes
    )
  ) {
    changed = true;
  }
  if (rewriteHighDollarTemplates(def, notes)) changed = true;
  // No $1M+ takeover arm here on purpose: HomeLight withholds the lead's
  // phone and email until a claim, so a text-and-call cadence has nothing to
  // dial. Same exemption as the under-$500K gate.
  return { changed, notes };
}

export function patchFollowUpRequested(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  // No ownerDirectTemplate in this flow, so a $1M+ lead really is offered to
  // the team here and claimed_agent is the right signal.
  if (addHighDollarTakeover(def, "fur_team_unclaimed", "fur", notes, { ownerDirect: false })) {
    changed = true;
  }
  return { changed, notes };
}

export function patchSpokeCheck(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = bannerOwnerFallbacks(def, notes);
  if (silenceNotices(def, [["wrap_up", "lead_name"]], notes)) changed = true;
  return { changed, notes };
}

export function patchGroupReplyConnected(def: Definition): PatchResult {
  const notes: string[] = [];
  const changed = silenceNotices(def, [["notify", "seller_first_name"]], notes);
  return { changed, notes };
}

export function patchCadence(def: Definition): PatchResult {
  const notes: string[] = [];
  const changed = bannerOwnerFallbacks(def, notes);
  return { changed, notes };
}

export const PATCHERS: Record<string, (def: Definition) => PatchResult> = {
  "ReferralExchange Lead": patchReferralExchange,
  "Realtor.com Lead": patchRealtor,
  "New Lead Intake": patchNewLeadIntake,
  "Clever Lead - Accept": patchCleverAccept,
  "HomeLight Referral": patchHomeLight,
  "Follow Up Requested (Unclaimed Leads)": patchFollowUpRequested,
  "Clever - Spoke Check & Weekly Call Follow-Up": patchSpokeCheck,
  "Clever Lead - Group Reply Connected": patchGroupReplyConnected,
  "Needs Follow Up (AI cadence)": patchCadence
};

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (isRevert) {
    const { data: rows, error } = await db
      .from("applied_oneshots")
      .select("details,applied_at")
      .eq("business_id", businessId)
      .eq("script", basename(SCRIPT))
      .order("applied_at", { ascending: false });
    if (error) {
      console.error(`Ledger read failed: ${error.message}`);
      process.exit(1);
    }
    const newest = new Map<string, Record<string, unknown>>();
    for (const row of (rows ?? []) as Array<{ details: Record<string, unknown> | null }>) {
      const d = row.details;
      const name = String(d?.flow_name ?? "");
      if (!name || d?.reverted === true || !d?.previous_definition) continue;
      if (!newest.has(name)) newest.set(name, d!);
    }
    if (newest.size === 0) {
      console.error("No applied ledger rows with a previous_definition to revert to.");
      process.exit(2);
    }
    for (const [name, d] of newest) {
      console.log(`revert ${name} (${d.flow_id})`);
      if (!apply) continue;
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: d.previous_definition })
        .eq("id", String(d.flow_id))
        .eq("business_id", businessId);
      if (upErr) {
        console.error(`Revert failed for ${name}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> reverted.");
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? SCRIPT,
        businessId,
        details: { flow_id: d.flow_id, flow_name: name, reverted: true }
      });
    }
    if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }

  const names = Object.keys(PATCHERS);
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .in("name", names);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flows not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let result: PatchResult;
    try {
      result = PATCHERS[row.name]!(def);
    } catch (e) {
      console.error(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: already correct, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      if (e instanceof AiFlowValidationError) {
        console.error(`${row.name}: patched definition INVALID, refusing to write:`);
        for (const issue of e.issues) console.error(`  - ${issue}`);
        process.exit(2);
      }
      throw e;
    }
    console.log(`${row.name}:`);
    for (const note of result.notes) console.log(`  ${note}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: def })
      .eq("id", row.id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Write failed for ${row.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: {
        flow_id: row.id,
        flow_name: row.name,
        notes: result.notes,
        previous_definition: previous
      }
    });
  }
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
