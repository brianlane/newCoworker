#!/usr/bin/env tsx
/**
 * One-shot: sellers under $500K (or with no price at all) are AI-owned.
 *
 * Amy, 2026-08-12: "if the lead price is unknown or below $500,000 then the
 * AI worker will own this follow up (unclaimed) until they are ready and
 * serious to speak with Amy's team. Meaning it will not route or broadcast
 * until that point. This is to help Amy because her employees are overwhelmed."
 *
 * Decisions confirmed with Brian the same day:
 *  - SELLERS ONLY. Buyers almost never carry a price, so "unknown" would have
 *    swallowed every buyer lead; buyer routing is untouched.
 *  - Promotion on EITHER signal: the lead asks for a human, or the AI hears
 *    real intent. On a live call that is the live-transfer attempt the call
 *    scripts already make; on SMS it is the cadence's new reply
 *    classification (see amy-needs-follow-up-definition.ts).
 *  - Emails to amy@amylaidlaw.com keep flowing exactly as today; the owner
 *    line now spells out "Unassigned when blank". The SECOND email, when
 *    someone claims after the AI promotes, rides the claimedNotifyEmail
 *    every route step (including the new promotion routes) already carries.
 *  - HOMELIGHT IS EXEMPT. It reveals the lead's contact info only after a
 *    connected call, and its connect call needs a human to take it: gating
 *    its broadcast would lose the lead outright.
 *
 * MECHANISM, uniform across the four flows:
 *
 *  1. The lead-reading step gains a `price_gate` extraction: "ai" only for a
 *     seller (or both) lead under $500K or with no price, "team" otherwise.
 *     Every guard is written so a MISSING var keeps today's behavior: routes
 *     gate on `notEquals "ai"` (miss → route runs), gated extras gate on
 *     `equals "ai"` (miss → skipped). An extraction miss can only fail OPEN
 *     toward the team, never silence a lead.
 *  2. The seller claim offer is suppressed for gated leads. $1M+ leads are
 *     unreachable by the gate (they always read "team"), so the existing
 *     ownerDirectWhen behavior is preserved by construction.
 *  3. The AI keeps (or gains) the first contact, and a gated lead that was
 *     not connected live falls into the "Needs Follow Up" cadence BY TAG,
 *     the account's one chokepoint for follow-up. Where a call just
 *     happened, the tag carries AUTO_TAG_NOTE so the cadence's round 1
 *     skips its immediate call (the Jessica Gutierrez double-call fix);
 *     where no call happened, the tag is plain and the cadence's immediate
 *     round-1 call IS the first contact.
 *  4. A gated lead the AI connected live (call_outcome "transferred") is
 *     promoted on the spot: a claim OFFER goes out so the moment of
 *     seriousness is also the moment of ownership.
 *
 * PER FLOW:
 *  - Clever Lead - Accept: gate on `route`; a top-level branch after the
 *    lead_reached goal (post-goal, so a reply's goal-jump path still passes
 *    through it) promotes transferred calls and tags everything else.
 *  - Realtor.com Lead: gate on `s4`; no AI call exists here, so gated
 *    sellers get a plain tag and the cadence makes the first call.
 *  - New Lead Intake: `route_seller`/`route_both` move into the else of a
 *    gating branch; buyers (`route_buyer`, `route_assigned`) stay top-level
 *    and untouched.
 *  - ReferralExchange Lead: same wrap for its seller/both routes, plus the
 *    transferred-promotion branch; its existing no-answer tag step gains
 *    AUTO_TAG_NOTE (the live half of PR #1338's builder change).
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-under-500k-ai-owned.ts            # dry run
 *   npx tsx scripts/oneshot/amy-under-500k-ai-owned.ts --apply
 *   npx tsx scripts/oneshot/amy-under-500k-ai-owned.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { AUTO_TAG_NOTE, FOLLOW_UP_TAG } from "./amy-needs-follow-up-definition";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-under-500k-ai-owned.ts";

export const PRICE_GATE_VAR = "price_gate";

type Step = Record<string, unknown>;
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Clever's reader looks at the lead PAGE, and the flow is seller-only, so the
 * question is just the price.
 */
export const PRICE_GATE_FIELD_PORTAL = {
  name: PRICE_GATE_VAR,
  description:
    "Answer exactly one lowercase word: team or ai. Answer team when the estimated home value " +
    "or price shown is $500,000 or more. Answer ai when it is under $500,000 or when no value " +
    "or price is shown anywhere."
};

/**
 * The other three flows carry buyers too, so the seller-only scope lives in
 * the extraction itself: a buyer can never read "ai", which keeps every buyer
 * route untouched even before the structural guards.
 */
export const PRICE_GATE_FIELD_TYPED = {
  name: PRICE_GATE_VAR,
  description:
    "Answer exactly one lowercase word: ai or team. Answer ai ONLY when this lead is selling " +
    "a home (seller or both) AND the price or home value is under $500,000 or not given. " +
    "Answer team in every other case, including every pure buyer lead and any price of " +
    "$500,000 or more."
};

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

/** Add the price_gate field to an extraction step, idempotently. */
export function addPriceGateField(
  def: Definition,
  stepId: string,
  field: { name: string; description: string }
): boolean {
  const step = findStepDeep(def.steps, stepId);
  if (!step) throw new Error(`step ${stepId} not found; aborting rather than guessing`);
  const fields = step.fields as Array<{ name: string; description?: string }> | undefined;
  if (!Array.isArray(fields)) throw new Error(`step ${stepId} has no fields array`);
  const existing = fields.find((f) => f.name === field.name);
  if (existing) {
    if (existing.description === field.description) return false;
    existing.description = field.description;
    return true;
  }
  fields.push({ ...field });
  return true;
}

/**
 * Gate a route step so it skips for AI-owned leads. `notEquals "ai"` on
 * purpose: a missing/misread var routes to the team, which is today's
 * behavior. Refuses a step that already carries a different when: that would
 * silently overwrite a guard doing other work, so abort and look instead.
 */
export function gateRouteStep(def: Definition, stepId: string): boolean {
  const step = findStepDeep(def.steps, stepId);
  if (!step || step.type !== "route_to_team") {
    throw new Error(`route step ${stepId} not found; aborting rather than guessing`);
  }
  const want = { var: PRICE_GATE_VAR, notEquals: "ai" };
  const cur = step.when as { var?: string; notEquals?: string } | undefined;
  if (cur) {
    if (cur.var === want.var && cur.notEquals === want.notEquals) return false;
    throw new Error(`route step ${stepId} already has a when guard; expected none`);
  }
  step.when = want;
  return true;
}

/** A "Needs Follow Up" tag step; `note` decides the cadence's round 1. */
function tagStep(id: string, withAutoNote: boolean, when?: Step["when"]): Step {
  return {
    id,
    type: "update_contact",
    phoneVar: "lead_phone",
    addTags: [FOLLOW_UP_TAG],
    ...(withAutoNote ? { noteTemplate: AUTO_TAG_NOTE } : {}),
    ...(when ? { when } : {})
  };
}

/**
 * Clone a flow's own seller route into a promotion offer: same recipients,
 * window, reminders and claimed-email wiring, new id and copy, no when (the
 * surrounding branch is the guard). ownerDirect* is dropped: a gated lead is
 * under $500K by definition, so the $1M+ owner-direct path cannot apply, and
 * carrying dead config invites someone to "fix" it later.
 */
export function promoteRouteFromSource(source: Step, id: string, offerTemplate: string): Step {
  const clone = JSON.parse(JSON.stringify(source)) as Step;
  clone.id = id;
  clone.offerTemplate = offerTemplate;
  delete clone.when;
  delete clone.ownerDirectWhen;
  delete clone.ownerDirectTemplate;
  delete clone.ownerDirectNudges;
  return clone;
}

/**
 * The post-call reaction for a gated lead: promote a live transfer, hand
 * everything else to the cadence. First-match arms; the else catches calls
 * that never went out (not_placed, failed, or a skipped call step), whose
 * plain tag makes the cadence's immediate round-1 call the first contact.
 */
function gatedAfterCallBranch(
  idPrefix: string,
  promoteRoute: Step,
  opts: { noAnswerAlreadyTagged: boolean; when?: Step["when"] }
): Step {
  return {
    id: `${idPrefix}_gated_after_call`,
    type: "branch",
    question: "AI-owned seller: did the call connect them, and what follows?",
    ...(opts.when ? { when: opts.when } : {}),
    branches: [
      {
        id: `${idPrefix}_g_transferred`,
        label: "Connected live: promote with a claim offer",
        condition: { var: "call_outcome", equals: "transferred" },
        steps: [promoteRoute]
      },
      {
        id: `${idPrefix}_g_no_answer`,
        label: "No answer: the cadence takes it (voicemail and text already sent)",
        condition: { var: "call_outcome", equals: "no_answer" },
        // ReferralExchange already tags no-answer leads (any price) with the
        // auto note one step earlier; re-tagging would be a no-op write.
        steps: opts.noAnswerAlreadyTagged ? [] : [tagStep(`${idPrefix}_g_tag_na`, true)]
      },
      {
        id: `${idPrefix}_g_answered`,
        label: "Spoke to the AI but not ready: cadence, starting at the 3-day wait",
        condition: { var: "call_outcome", equals: "answered" },
        steps: [tagStep(`${idPrefix}_g_tag_ans`, true)]
      }
    ],
    else: [tagStep(`${idPrefix}_g_tag_uncalled`, false)]
  };
}

export type PatchResult = { changed: boolean; notes: string[] };

/** Reword the owner line so "blank" is spelled out as Unassigned. */
export const OWNER_LINE_OLD = "Lead owner (blank if nobody has claimed it yet):";
export const OWNER_LINE_NEW = "Lead owner (Unassigned when blank):";

export function rewordOwnerLine(def: Definition, stepIds: string[], notes: string[]): boolean {
  let changed = false;
  for (const id of stepIds) {
    const step = findStepDeep(def.steps, id);
    if (!step) throw new Error(`email step ${id} not found; aborting rather than guessing`);
    const body = String(step.body ?? "");
    if (body.includes(OWNER_LINE_NEW)) continue;
    if (!body.includes(OWNER_LINE_OLD)) {
      throw new Error(`email step ${id} does not carry the expected owner line`);
    }
    step.body = body.replace(OWNER_LINE_OLD, OWNER_LINE_NEW);
    notes.push(`${id}: owner line now says Unassigned`);
    changed = true;
  }
  return changed;
}

const CLEVER_PROMOTE_OFFER =
  "AI HANDOFF, serious Clever seller: {{vars.lead_name}} ({{vars.lead_phone}}) " +
  "{{vars.lead_email}}\n" +
  "Address: {{vars.lead_address}}\n" +
  "Price: {{vars.price}} (under $500K, so the AI was working it unclaimed)\n" +
  "The AI connected them LIVE to a teammate just now, so someone has the full story. " +
  "Claim it so this lead has an owner.\n\n" +
  "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
  '(e.g. "1, 20 min").\n' +
  "First to reply 1 gets it.";

const RE_PROMOTE_OFFER =
  "AI HANDOFF, serious {{vars.lead_type}} lead: {{vars.lead_name}} ({{vars.lead_phone}}, " +
  "email: {{vars.lead_email}}) in {{vars.location}}, around {{vars.price}} (under $500K, so " +
  "the AI was working it unclaimed).\n" +
  "The AI connected them LIVE to a teammate just now, so someone has the full story. " +
  "Claim it so this lead has an owner.\n\n" +
  "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out ' +
  '(e.g. "1, 20 min").\n' +
  "First to reply 1 gets it.";

export function patchClever(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = addPriceGateField(def, "read_details", PRICE_GATE_FIELD_PORTAL);
  if (changed) notes.push("read_details: price_gate field");
  if (gateRouteStep(def, "route")) {
    notes.push("route: skips when price_gate is ai");
    changed = true;
  }
  if (!findStepDeep(def.steps, "clever_gated_after_call")) {
    const steps = def.steps ?? [];
    const goalIdx = steps.findIndex((s) => s.id === "lead_reached");
    if (goalIdx < 0) throw new Error("lead_reached goal not found; aborting");
    const source = findStepDeep(steps, "route");
    if (!source) throw new Error("route step not found; aborting");
    // AFTER the goal on purpose: steps after a goal run on BOTH paths, so a
    // lead whose reply goal-jumped out of the retry ladder still gets tagged
    // into the cadence instead of falling into silence.
    steps.splice(
      goalIdx + 1,
      0,
      gatedAfterCallBranch(
        "clever",
        promoteRouteFromSource(source, "clever_route_promote", CLEVER_PROMOTE_OFFER),
        { noAnswerAlreadyTagged: false, when: { var: PRICE_GATE_VAR, equals: "ai" } }
      )
    );
    notes.push("clever_gated_after_call: promote transferred, tag the rest");
    changed = true;
  }
  if (rewordOwnerLine(def, ["qt_email"], notes)) changed = true;
  return { changed, notes };
}

export function patchRealtor(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = addPriceGateField(def, "s1", PRICE_GATE_FIELD_TYPED);
  if (changed) notes.push("s1: price_gate field");
  if (gateRouteStep(def, "s4")) {
    notes.push("s4: skips when price_gate is ai");
    changed = true;
  }
  if (!findStepDeep(def.steps, "rt_gated_tag")) {
    const steps = def.steps ?? [];
    const routeIdx = steps.findIndex((s) => s.id === "s4");
    if (routeIdx < 0) throw new Error("s4 not found; aborting");
    // No AI call exists on this flow, so the tag is PLAIN: the cadence's
    // immediate round-1 call is the first contact for a gated seller.
    steps.splice(
      routeIdx + 1,
      0,
      tagStep("rt_gated_tag", false, { var: PRICE_GATE_VAR, equals: "ai" })
    );
    notes.push("rt_gated_tag: gated sellers join the cadence");
    changed = true;
  }
  if (rewordOwnerLine(def, ["s2"], notes)) changed = true;
  return { changed, notes };
}

/**
 * Wrap a flow's seller/both routes in the gate: the AI-owned arm runs the
 * gated steps, the else keeps the ORIGINAL route steps (their own when
 * guards intact). Idempotent by wrapper id.
 */
export function wrapSellerRoutes(
  def: Definition,
  wrapperId: string,
  routeIds: string[],
  gatedSteps: Step[]
): boolean {
  if (findStepDeep(def.steps, wrapperId)) return false;
  const steps = def.steps ?? [];
  const indices = routeIds.map((id) => steps.findIndex((s) => s.id === id));
  if (indices.some((i) => i < 0)) {
    throw new Error(`route steps ${routeIds.join(", ")} not all top-level; aborting`);
  }
  const first = Math.min(...indices);
  const originals = routeIds.map((id) => steps.find((s) => s.id === id)!);
  const wrapper: Step = {
    id: wrapperId,
    type: "branch",
    question: "Under-$500K (or unknown-price) seller? The AI owns it until they are ready.",
    branches: [
      {
        id: `${wrapperId}_ai`,
        label: "AI-owned: no claim offer now",
        condition: { var: PRICE_GATE_VAR, equals: "ai" },
        steps: gatedSteps
      }
    ],
    else: originals
  };
  const kept = steps.filter((s) => !routeIds.includes(String(s.id)));
  kept.splice(first, 0, wrapper);
  def.steps = kept;
  return true;
}

export function patchNewLeadIntake(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = addPriceGateField(def, "parse", PRICE_GATE_FIELD_TYPED);
  if (changed) notes.push("parse: price_gate field");
  // No promotion route here: New Lead Intake's optional call carries no
  // transfer ladder, so "transferred" cannot occur; the arms that matter are
  // the tag ones. The nested branch still keys the note on call_outcome so a
  // call-gated lead that WAS just called is not called again two minutes
  // later by the cadence.
  const gated: Step[] = [
    {
      id: "nli_gated_after_call",
      type: "branch",
      question: "Did an AI call just happen for this AI-owned seller?",
      branches: [
        {
          id: "nli_g_no_answer",
          label: "Called, no answer: cadence starts at the 3-day wait",
          condition: { var: "call_outcome", equals: "no_answer" },
          steps: [
            tagStep("nli_g_tag_na_s", true, { var: "route_variant", equals: "seller" }),
            tagStep("nli_g_tag_na_b", true, { var: "route_variant", equals: "both" })
          ]
        },
        {
          id: "nli_g_answered",
          label: "Spoke to the AI: cadence starts at the 3-day wait",
          condition: { var: "call_outcome", equals: "answered" },
          steps: [
            tagStep("nli_g_tag_ans_s", true, { var: "route_variant", equals: "seller" }),
            tagStep("nli_g_tag_ans_b", true, { var: "route_variant", equals: "both" })
          ]
        }
      ],
      // No call happened (call_gate was off, or the dial never went out):
      // the cadence's immediate round-1 call is the first contact. The
      // route_variant guards keep a misread buyer out of the cadence: their
      // buyer route already ran normally above.
      else: [
        tagStep("nli_g_tag_s", false, { var: "route_variant", equals: "seller" }),
        tagStep("nli_g_tag_b", false, { var: "route_variant", equals: "both" })
      ]
    }
  ];
  if (wrapSellerRoutes(def, "nli_seller_gate", ["route_seller", "route_both"], gated)) {
    notes.push("nli_seller_gate: seller/both routes gated, buyers untouched");
    changed = true;
  }
  return { changed, notes };
}

export function patchReferralExchange(def: Definition): PatchResult {
  const notes: string[] = [];
  let changed = addPriceGateField(def, "browse", PRICE_GATE_FIELD_TYPED);
  if (changed) notes.push("browse: price_gate field");
  // The live half of PR #1338: the existing no-answer tag now explains
  // itself, so the cadence stops double-calling (any price, not just gated).
  const tag = findStepDeep(def.steps, "ai_no_answer_followup");
  if (!tag) throw new Error("ai_no_answer_followup not found; aborting");
  if (tag.noteTemplate !== AUTO_TAG_NOTE) {
    tag.noteTemplate = AUTO_TAG_NOTE;
    notes.push("ai_no_answer_followup: carries AUTO_TAG_NOTE");
    changed = true;
  }
  const source = findStepDeep(def.steps, "route_seller");
  if (!source) throw new Error("route_seller not found; aborting");
  const gated: Step[] = [
    gatedAfterCallBranch(
      "re",
      promoteRouteFromSource(source, "re_route_promote", RE_PROMOTE_OFFER),
      // The top-level tag step above already handled no_answer.
      { noAnswerAlreadyTagged: true }
    )
  ];
  if (wrapSellerRoutes(def, "re_seller_gate", ["route_seller", "route_both"], gated)) {
    notes.push("re_seller_gate: seller/both routes gated, buyers untouched");
    changed = true;
  }
  if (rewordOwnerLine(def, ["email_buyer", "email_seller", "email_both"], notes)) changed = true;
  return { changed, notes };
}

export const PATCHERS: Record<string, (def: Definition) => PatchResult> = {
  "Clever Lead - Accept": patchClever,
  "Realtor.com Lead": patchRealtor,
  "New Lead Intake": patchNewLeadIntake,
  "ReferralExchange Lead": patchReferralExchange
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
      console.error(e instanceof Error ? e.message : String(e));
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
