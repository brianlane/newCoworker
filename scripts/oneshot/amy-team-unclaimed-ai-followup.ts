#!/usr/bin/env tsx
/**
 * One-shot: a $500K+ seller nobody claims becomes AI-owned too.
 *
 * Amy (via Brian, 2026-08-13): "When the lead comes in above $500K and no
 * employee claims it then ai will own the follow up process."
 *
 * The other half of `amy-under-500k-ai-owned.ts`. Under-$500K sellers skip
 * the claim offer and are AI-owned from arrival. A $500K+ seller still gets
 * the offer, but when it runs its whole course unclaimed (offer, three
 * reminders, owner fallback), the flow used to end at "It's back to you" and
 * nothing followed up. Now the AI takes it: the lead is tagged into the
 * "Needs Follow Up" cadence, which calls every three days and hands the lead
 * back with a claim offer the moment they read as ready (the same promotion
 * the gated path uses).
 *
 * SHAPE, appended at the END of each flow so it never delays the emails or
 * the bad-phone report chain, and evaluated well after the offer resolved.
 * EVERY filter sits in front of the sleep, so a run this rule does not apply
 * to (a buyer, a $1M+ owner-direct lead, an already-claimed lead) ends
 * instantly instead of parking for two hours (Bugbot, this PR):
 *
 *   {p}_team_unclaimed (branch, when price_gate != "ai", the under-$500K
 *   path has its own tagging and must not double-tag)
 *     arm: price_band == "under_1m" ($1M+ was never offered: Amy's own)
 *       per seller variant (flows with buyer traffic get a branch per
 *       seller-ish lead type; Clever is seller-only and skips the wrapper):
 *         {p}_tu{v}_wait  sleep 120min, when claimed_agent == "none" (the
 *                         offer + reminders span ~70min; 120 clears it with
 *                         margin, and a claimed lead skips the sleep)
 *         {p}_tu{v}_check branch: claimed_agent STILL "none"
 *           tag "Needs Follow Up"
 *
 * DECISIONS baked in, called out for review:
 *  - SELLERS ONLY, same as the gate ("Do not change buyer leads" stands).
 *    Realtor.com's reader gains a `lead_type` extraction that answers seller
 *    only when the message CLEARLY says selling, so an ambiguous inquiry
 *    (most Realtor.com traffic is buyers) fails safe to buyer and no tag.
 *  - $1M+ LEADS ARE EXCLUDED (the price_band gate). They are never offered
 *    to the team at all: ownerDirectWhen sends them straight to Amy, so
 *    "no employee claims" never describes them, and Amy keeps them personal.
 *  - THE NOTE ON THE TAG mirrors the gate's rule. Clever and
 *    ReferralExchange leads reaching this point were already called by the
 *    AI (their call steps run for every under-$1M lead), so the tag carries
 *    AUTO_TAG_NOTE and the cadence starts at the 3-day wait. New Lead Intake
 *    and Realtor.com tag PLAIN: most of their leads were never called, and
 *    the cadence's immediate round-1 call is the AI actually taking over.
 *    (An NLI lead that WAS call-gated gets re-called ~3h later; acceptable,
 *    and the alternative delays the majority three days.)
 *  - The seller offers' ownerFallbackTemplate now SAYS the AI keeps working
 *    unclaimed leads, because copy must match behavior. Realtor.com's s4 is
 *    skipped (it offers buyers too, and the line would be false for them).
 *
 * claimed_agent is safe to gate on: the worker seeds it to "none" for every
 * run at scope construction, and a route_to_team claim overwrites it in the
 * run's own vars (the same contract Clever's retry ladder already rides).
 *
 * Read-modify-write against the LIVE definitions, validated through
 * parseAiFlowDefinition, idempotent, dry-run by default, `--revert` restores
 * from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-team-unclaimed-ai-followup.ts            # dry run
 *   npx tsx scripts/oneshot/amy-team-unclaimed-ai-followup.ts --apply
 *   npx tsx scripts/oneshot/amy-team-unclaimed-ai-followup.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { AUTO_TAG_NOTE, FOLLOW_UP_TAG } from "./amy-needs-follow-up-definition";
import {
  PRICE_GATE_VAR,
  findStepDeep,
  type Definition
} from "./amy-under-500k-ai-owned";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-team-unclaimed-ai-followup.ts";

type Step = Record<string, unknown>;

/**
 * Realtor.com has no lead-type variable at all, and most of its traffic is
 * buyers asking about a listing. Seller ONLY when the message clearly says
 * so; anything ambiguous fails safe to buyer, which means no tag and
 * today's behavior.
 */
export const REALTOR_LEAD_TYPE_FIELD = {
  name: "lead_type",
  description:
    "Answer exactly one lowercase word: seller when the message clearly says this person wants " +
    "to SELL a home they own, buyer in every other case, including when it is unclear or they " +
    "are asking about a listing"
};

/** The line the seller offers' owner fallback gains, so copy matches behavior. */
export const FALLBACK_TAKEOVER_LINE =
  "\nThe AI keeps working it: a follow-up every 3 days, and a claim offer the moment they are ready.";

export function takeoverTag(id: string, withAutoNote: boolean, when?: Step["when"]): Step {
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
 * One seller variant of the takeover: on flows with buyer traffic the
 * variant is wrapped in a branch on its lead-type condition, so a lead the
 * rule does not cover skips the whole block (including the sleep) instantly.
 */
export type TakeoverVariant = {
  /** Suffix for step ids, e.g. "_s" / "_b"; "" for a seller-only flow. */
  suffix: string;
  /**
   * Lead-type condition; omitted on a seller-only flow (Clever). notEquals
   * fits a flow whose seller route is itself a notEquals (Follow Up
   * Requested routes everything non-buyer through its seller route).
   */
  condition?: { var: string; equals?: string; notEquals?: string };
  /** What runs once the lead is confirmed unclaimed past the offer's course. */
  tagSteps: Step[];
  /** Label for the wrapper arm, when a condition is present. */
  label?: string;
};

function variantSteps(prefix: string, v: TakeoverVariant): Step[] {
  const inner: Step[] = [
    {
      id: `${prefix}_tu${v.suffix}_wait`,
      type: "sleep",
      minutes: 120,
      // A lead claimed before flow end skips the wait outright.
      when: { var: "claimed_agent", equals: "none" }
    },
    {
      id: `${prefix}_tu${v.suffix}_check`,
      type: "branch",
      question: "Still unclaimed after the offer ran its course?",
      branches: [
        {
          id: `${prefix}_tu${v.suffix}_still`,
          label: "Still unclaimed: the AI owns the follow-up now",
          condition: { var: "claimed_agent", equals: "none" },
          steps: v.tagSteps
        }
      ],
      else: []
    }
  ];
  if (!v.condition) return inner;
  return [
    {
      id: `${prefix}_tu${v.suffix}_type`,
      type: "branch",
      question: "Is this a lead type the takeover covers?",
      branches: [
        {
          id: `${prefix}_tu${v.suffix}_match`,
          label: v.label ?? "Covered lead type",
          condition: v.condition,
          steps: inner
        }
      ],
      else: []
    }
  ];
}

/**
 * The whole takeover branch. Nesting stays within the 3-level cap: the outer
 * branch (1), the per-variant type wrapper (2), and the re-check (3); on
 * Clever, which needs no type wrapper, it is one level shallower.
 */
export function teamUnclaimedBranch(
  prefix: string,
  variants: TakeoverVariant[],
  opts: {
    /**
     * The four arrival flows gate the branch on `price_gate != "ai"` so the
     * AI-owned path (which tags itself) is never double-tagged. A flow with
     * no gated arrival path (Follow Up Requested) has no `price_gate`
     * producer at all, and the validator rightly rejects a when on a var
     * nothing produces, so it opts out.
     */
    gateOnPriceGate?: boolean;
  } = {}
): Step {
  return {
    id: `${prefix}_team_unclaimed`,
    type: "branch",
    question: "Team-offered seller: did anyone claim it, or does the AI take over?",
    ...(opts.gateOnPriceGate === false
      ? {}
      : { when: { var: PRICE_GATE_VAR, notEquals: "ai" } }),
    branches: [
      {
        id: `${prefix}_tu_open`,
        label: "Under $1M: the takeover can apply ($1M+ was never offered, it is Amy's own)",
        // The COMPUTED band (math less_than on price_digits), not the
        // extracted price_band: a $613K lead was extracted with band
        // "over_1m" in the same call that read its price correctly, and this
        // arm was one of the three gates that misread silenced. notEquals
        // "no" so an unknown or unparseable price stays covered; only a
        // PROVEN $1M+ is excluded.
        condition: { var: "price_under_1m", notEquals: "no" },
        steps: variants.flatMap((v) => variantSteps(prefix, v))
      }
    ],
    else: []
  };
}

/** Append the takeover line to a route step's ownerFallbackTemplate. */
export function appendFallbackLine(
  def: Definition,
  routeIds: string[],
  notes: string[]
): boolean {
  let changed = false;
  for (const id of routeIds) {
    const step = findStepDeep(def.steps, id);
    if (!step || step.type !== "route_to_team") {
      throw new Error(`route step ${id} not found; aborting rather than guessing`);
    }
    const cur = String(step.ownerFallbackTemplate ?? "");
    if (!cur) throw new Error(`route step ${id} has no ownerFallbackTemplate`);
    if (cur.includes(FALLBACK_TAKEOVER_LINE.trim())) continue;
    step.ownerFallbackTemplate = cur.trimEnd() + FALLBACK_TAKEOVER_LINE;
    notes.push(`${id}: fallback copy says the AI keeps working it`);
    changed = true;
  }
  return changed;
}

/** Append the takeover branch at the very end of the flow, idempotently. */
function appendBranch(def: Definition, branch: Step, notes: string[]): boolean {
  if (findStepDeep(def.steps, String(branch.id))) return false;
  (def.steps ?? []).push(branch);
  notes.push(`${branch.id}: unclaimed $500K-$1M sellers join the cadence`);
  return true;
}

export type PatchResult = { changed: boolean; notes: string[] };

export function patchClever(def: Definition): PatchResult {
  const notes: string[] = [];
  // Seller-only flow, so no lead-type wrapper. Every under-$1M Clever lead
  // was called (ai_call_1 gates on under_1m), so the cadence starts at the
  // 3-day wait.
  const variants = [{ suffix: "", tagSteps: [takeoverTag("clever_tu_tag", true)] }];
  let changed = appendBranch(def, teamUnclaimedBranch("clever", variants), notes);
  if (appendFallbackLine(def, ["route"], notes)) changed = true;
  return { changed, notes };
}

export function patchReferralExchange(def: Definition): PatchResult {
  const notes: string[] = [];
  // A no-answer already tagged itself at any price (ai_no_answer_followup);
  // update_contact re-adding an existing tag is a no-op, so these steps are
  // safe on that path and REACH the answered / not_placed leads that had no
  // tag at all. Called leads get the auto note.
  const variants: TakeoverVariant[] = [
    {
      suffix: "_s",
      condition: { var: "route_lead_type", equals: "seller" },
      label: "Seller",
      tagSteps: [takeoverTag("re_tu_tag_s", true)]
    },
    {
      suffix: "_b",
      condition: { var: "route_lead_type", equals: "both" },
      label: "Buying and selling",
      tagSteps: [takeoverTag("re_tu_tag_b", true)]
    }
  ];
  let changed = appendBranch(def, teamUnclaimedBranch("re", variants), notes);
  if (appendFallbackLine(def, ["route_seller", "route_both"], notes)) changed = true;
  return { changed, notes };
}

export function patchRealtor(def: Definition): PatchResult {
  const notes: string[] = [];
  const s1 = findStepDeep(def.steps, "s1");
  if (!s1) throw new Error("s1 not found; aborting rather than guessing");
  const fields = s1.fields as Array<{ name: string; description?: string }> | undefined;
  if (!Array.isArray(fields)) throw new Error("s1 has no fields array");
  let changed = false;
  const existing = fields.find((f) => f.name === REALTOR_LEAD_TYPE_FIELD.name);
  if (!existing) {
    fields.push({ ...REALTOR_LEAD_TYPE_FIELD });
    notes.push("s1: lead_type field (seller only when the message clearly says so)");
    changed = true;
  } else if (existing.description !== REALTOR_LEAD_TYPE_FIELD.description) {
    existing.description = REALTOR_LEAD_TYPE_FIELD.description;
    notes.push("s1: lead_type description updated");
    changed = true;
  }
  // No AI call exists on this flow, so the tag is plain and the cadence's
  // immediate round-1 call is the AI actually taking over.
  const variants: TakeoverVariant[] = [
    {
      suffix: "_s",
      condition: { var: "lead_type", equals: "seller" },
      label: "Clearly a seller",
      tagSteps: [takeoverTag("rt_tu_tag", false)]
    }
  ];
  if (appendBranch(def, teamUnclaimedBranch("rt", variants), notes)) changed = true;
  // s4 offers buyers too; a takeover line there would be false for them, so
  // its fallback copy is deliberately untouched.
  return { changed, notes };
}

export function patchNewLeadIntake(def: Definition): PatchResult {
  const notes: string[] = [];
  // Plain tag: most NLI leads were never called (call_gate is rare), and
  // the cadence's immediate call is the takeover. The rare call-gated lead
  // gets re-called ~3h after its first call, which beats delaying the
  // majority by three days.
  const variants: TakeoverVariant[] = [
    {
      suffix: "_s",
      condition: { var: "route_variant", equals: "seller" },
      label: "Seller",
      tagSteps: [takeoverTag("nli_tu_tag_s", false)]
    },
    {
      suffix: "_b",
      condition: { var: "route_variant", equals: "both" },
      label: "Buying and selling",
      tagSteps: [takeoverTag("nli_tu_tag_b", false)]
    }
  ];
  let changed = appendBranch(def, teamUnclaimedBranch("nli", variants), notes);
  if (appendFallbackLine(def, ["route_seller", "route_both"], notes)) changed = true;
  return { changed, notes };
}

export const PATCHERS: Record<string, (def: Definition) => PatchResult> = {
  "Clever Lead - Accept": patchClever,
  "ReferralExchange Lead": patchReferralExchange,
  "Realtor.com Lead": patchRealtor,
  "New Lead Intake": patchNewLeadIntake
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
