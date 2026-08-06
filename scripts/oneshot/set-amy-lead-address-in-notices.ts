#!/usr/bin/env tsx
/**
 * One-shot: put the lead's property address in EVERY team-facing notice on
 * Amy Laidlaw Real Estate's six lead flows.
 *
 * Why (Amy's Aug 2026 question): some of her flows text her and her team the
 * property address and some do not. There was no single bug. Each flow was
 * hand-authored per lead vendor at a different time and there is no shared
 * lead-summary block, so the address appears only where somebody typed it into
 * that one template. Three distinct causes:
 *
 *   1. Extraction gap. The ReferralExchange referral page shows the address
 *      outright ("Address 42810 West Mallard Road, Maricopa, AZ 85138"), but
 *      the flow's browse_extract never asked for it, only for `location`
 *      ("Maricopa, AZ"). Her highest-volume flow, so most of the complaint.
 *   2. Template gaps. Realtor.com and Clever DO capture a full street address
 *      and use it in some notices but not others: Realtor.com's claim offer
 *      has it while its no-claim and claimed texts do not; Clever Accept's
 *      offer and fallback have it while its claimed text does not.
 *   3. A vendor that does not publish it. HomeLight's portal shows only
 *      city/ZIP ("85205, AZ"), and the team offer goes out before the portal
 *      card is read at all. This script moves the address read AHEAD of
 *      route_to_team so the team gets whatever HomeLight does publish; the
 *      line will read coarse until HomeLight publishes more.
 *
 * Buyer leads get NO address line. A ReferralExchange buyer is shopping, not
 * selling, so there is no property. This matters mechanically: route_to_team's
 * offer/fallback/claim templates are rendered by plain renderTemplate with no
 * collapseEmpty (ai-flow-worker/index.ts), so an empty var would text a bare
 * "Address:" label. Branching by lead type is how these flows already split
 * buyer/seller/both, so no empty line can ever go out.
 *
 * Two seams checked before writing, both documented in the tenant dossier:
 *   - `lead_address` feeds the duplicate-lead gate (reentry.ts
 *     duplicateLeadRunExists). Only Realtor.com Lead sets options.dedupeLeadRuns,
 *     and that flow already extracted the address, so no dedupe behavior moves.
 *   - Deleting a step id KILLS a parked run whose resume marker names it
 *     (resolveResumeIndex returns null and the caller stops the run). So the
 *     ReferralExchange notify split REUSES the existing `notify` id for the
 *     seller variant and only adds ids; nothing is removed or renamed.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent
 * (a re-run finds every line already present and reports no change), and it
 * aborts rather than guessing when a step or template key it expects is
 * missing. Dry-run by default. Records to applied_oneshots on --apply. Does
 * NOT enqueue any runs and sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-amy-lead-address-in-notices.ts          # dry run
 *   npx tsx scripts/oneshot/set-amy-lead-address-in-notices.ts --apply
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
/** Print every patched template in full, for reviewing the wording. */
const SHOW = process.argv.includes("--show");
const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate

/** One wording everywhere, so these six flows stop drifting apart again. */
const ADDRESS_LINE = "Address: {{vars.lead_address}}";

type AnyStep = Record<string, unknown>;

/** A field to add to an extraction step, if it is not already there. */
type FieldAdd = { stepId: string; name: string; description: string };

/** Template keys on one step that should each carry the address line. */
type TemplateAdd = { stepId: string; keys: string[] };

type FlowSpec = {
  flow: string;
  fields?: FieldAdd[];
  templates?: TemplateAdd[];
  /** ReferralExchange only: fan `notify` out by lead type. */
  splitReferralExchangeNotify?: boolean;
};

const SPECS: FlowSpec[] = [
  {
    // The extraction gap. Seller and both-type paths only: a buyer referral
    // has no property, and its page carries no Address row to read.
    flow: "ReferralExchange Lead",
    fields: [
      {
        stepId: "browse",
        name: "lead_address",
        description:
          "The property street address from the referral page's Address row: full street, city, state, and ZIP. Return an empty string when the page shows no street address, which is normal for a buyer referral."
      }
    ],
    templates: [
      {
        stepId: "route_seller",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      {
        stepId: "route_both",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      { stepId: "email_seller", keys: ["body"] },
      { stepId: "email_both", keys: ["body"] }
    ],
    splitReferralExchangeNotify: true
  },
  {
    // The vendor that publishes only city/ZIP. Reading it at the PRE-CLAIM
    // portal step is what makes it exist before route_to_team parks; the later
    // card/recheck/final_read extracts still refine lead_address afterwards.
    flow: "HomeLight Referral",
    fields: [
      {
        stepId: "open",
        name: "lead_address",
        description:
          "The property address shown on the referral page: full street, city, state, and ZIP. HomeLight often publishes only the city and ZIP before a referral is claimed; return exactly what the page shows and never an empty string."
      }
    ],
    templates: [
      {
        stepId: "route",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      { stepId: "notify_unclaimed", keys: ["message"] }
    ]
  },
  {
    // Template gap only: the offer, the BS email and the owner recap already
    // carry the address the trigger text always supplies.
    flow: "Realtor.com Lead",
    templates: [{ stepId: "s4", keys: ["ownerFallbackTemplate", "claimedNotifyTemplate"] }]
  },
  {
    // Template gap only: offer, fallback, QT email and owner recap have it.
    flow: "Clever Lead - Accept",
    templates: [{ stepId: "route", keys: ["claimedNotifyTemplate"] }]
  },
  {
    // Template gap only: all three route templates already have it.
    flow: "Clever - Spoke Check & Weekly Call Follow-Up",
    templates: [{ stepId: "wrap_up", keys: ["message"] }]
  },
  {
    // Amy types these leads herself, so she is the source of the address. The
    // "not given" literal is deliberate HERE and nowhere else: it never
    // renders a broken label, and it tells Amy she left the address out.
    flow: "New Lead Intake",
    fields: [
      {
        stepId: "parse",
        name: "lead_address",
        description:
          "The full property address of the lead, including street, city, state, and ZIP, if the message gives one. If no address is mentioned anywhere in the message, return exactly: not given"
      }
    ],
    templates: [
      {
        stepId: "route_assigned",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      {
        stepId: "route_buyer",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      {
        stepId: "route_seller",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      {
        stepId: "route_both",
        keys: ["offerTemplate", "ownerFallbackTemplate", "claimedNotifyTemplate"]
      },
      { stepId: "notify", keys: ["message"] },
      { stepId: "notify_no_phone", keys: ["message"] }
    ]
  }
];

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

/**
 * Place the address line where a reader expects it, matching the shape the
 * already-correct templates (Clever Accept, Realtor.com's owner recap) use:
 * immediately BEFORE the "Lead source:" line when the notice has one, else
 * right after the opening line, else appended to a single-line notice.
 * Returns the template unchanged when the line is already present, which is
 * what makes the whole script idempotent.
 */
function withAddressLine(template: string): string {
  if (template.includes(ADDRESS_LINE)) return template;
  const lines = template.split("\n");
  const sourceIdx = lines.findIndex((l) => l.startsWith("Lead source:"));
  if (sourceIdx !== -1) {
    lines.splice(sourceIdx, 0, ADDRESS_LINE);
    return lines.join("\n");
  }
  if (lines.length > 1) {
    lines.splice(1, 0, ADDRESS_LINE);
    return lines.join("\n");
  }
  return `${template}\n${ADDRESS_LINE}`;
}

/** Depth-first step lookup by id, so a step inside a branch arm is reachable. */
function findStep(list: AnyStep[], id: string): AnyStep | null {
  for (const step of list) {
    if (step.id === id) return step;
    if (step.type === "branch") {
      for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) {
        const hit = findStep(arm.steps, id);
        if (hit) return hit;
      }
      if (Array.isArray(step.else)) {
        const hit = findStep(step.else as AnyStep[], id);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Fan ReferralExchange's single owner-recap step out by lead type: sellers and
 * both-type leads gain the address, buyers keep the search area alone. The
 * existing `notify` id is REUSED for the seller variant rather than replaced,
 * because a parked run whose resume marker names a deleted step is stopped
 * outright (resolveResumeIndex returns null). The three variants sit
 * consecutively, so a run resuming at `notify` still walks all of them and
 * exactly one gate fires.
 */
function splitNotify(
  steps: AnyStep[],
  changed: string[],
  problems: string[],
  previews: Array<{ label: string; text: string }>
): void {
  // Already split on an earlier run: the buyer variant is the tell.
  if (steps.some((s) => s.id === "notify_buyer")) return;
  const idx = steps.findIndex((s) => s.id === "notify");
  if (idx === -1) {
    problems.push('expected a trunk step with id "notify"');
    return;
  }
  const notify = steps[idx];
  if (notify.type !== "notify_owner" || typeof notify.message !== "string") {
    problems.push('"notify" is not a notify_owner step with a message');
    return;
  }
  const original = notify.message;
  notify.when = { var: "route_lead_type", equals: "seller" };
  notify.message = withAddressLine(original);
  changed.push("notify: now the seller variant, gated route_lead_type=seller, address added");

  const both: AnyStep = {
    id: "notify_both",
    type: "notify_owner",
    when: { var: "route_lead_type", equals: "both" },
    message: withAddressLine(original)
  };
  const buyer: AnyStep = {
    id: "notify_buyer",
    type: "notify_owner",
    when: { var: "route_lead_type", equals: "buyer" },
    message: original
  };
  steps.splice(idx + 1, 0, both, buyer);
  changed.push("notify_both: added (address)");
  changed.push("notify_buyer: added (search area only, a buyer has no property)");
  previews.push({ label: "notify (seller)", text: notify.message as string });
  previews.push({ label: "notify_both", text: both.message as string });
  previews.push({ label: "notify_buyer", text: buyer.message as string });
}

function patch(
  spec: FlowSpec,
  def: AiFlowDefinition
): {
  next: AiFlowDefinition;
  changed: string[];
  problems: string[];
  previews: Array<{ label: string; text: string }>;
} {
  const changed: string[] = [];
  const problems: string[] = [];
  const previews: Array<{ label: string; text: string }> = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  for (const add of spec.fields ?? []) {
    const step = findStep(steps, add.stepId);
    if (!step) {
      problems.push(`no step "${add.stepId}"`);
      continue;
    }
    const fields = step.fields as Array<{ name?: string; description?: string }> | undefined;
    if (!Array.isArray(fields)) {
      problems.push(`step "${add.stepId}" has no fields array`);
      continue;
    }
    if (fields.some((f) => f.name === add.name)) continue;
    fields.push({ name: add.name, description: add.description });
    changed.push(`${add.stepId}: +field ${add.name}`);
  }

  for (const target of spec.templates ?? []) {
    const step = findStep(steps, target.stepId);
    if (!step) {
      problems.push(`no step "${target.stepId}"`);
      continue;
    }
    for (const k of target.keys) {
      const current = step[k];
      if (typeof current !== "string") {
        problems.push(`step "${target.stepId}" has no string "${k}"`);
        continue;
      }
      const next = withAddressLine(current);
      if (next === current) continue;
      step[k] = next;
      changed.push(`${target.stepId}.${k}: +address line`);
      previews.push({ label: `${target.stepId}.${k}`, text: next });
    }
  }

  if (spec.splitReferralExchangeNotify) splitNotify(steps, changed, problems, previews);

  return { next: { ...def, steps: steps as unknown as FlowStep[] }, changed, problems, previews };
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

const targets: Array<{
  row: Row;
  next: AiFlowDefinition;
  changed: string[];
  previews: Array<{ label: string; text: string }>;
}> = [];
const blocking: string[] = [];
for (const spec of SPECS) {
  const row = await loadFlow(spec.flow);
  const { next, changed, problems, previews } = patch(spec, row.definition);
  for (const p of problems) blocking.push(`${spec.flow}: ${p}`);
  targets.push({ row, next: validate(spec.flow, next), changed, previews });
}

if (blocking.length > 0) {
  console.error("\nLive definitions do not match what this script expects, so nothing was written:");
  for (const b of blocking) console.error(`  - ${b}`);
  console.error("Re-read the live flows before editing this script.");
  process.exit(2);
}

for (const { row, next, changed, previews } of targets) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log("  already patched, no changes");
    continue;
  }
  for (const c of changed) console.log(`  - ${c}`);
  if (SHOW) {
    for (const p of previews) {
      console.log(`\n  --- ${p.label} ---`);
      for (const line of p.text.split("\n")) console.log(`  | ${line}`);
    }
    console.log("");
  }
  console.log(`  after: ${summarizeDefinition(next)}`);
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

const failures: string[] = [];
const patchedIds: string[] = [];
for (const { row, next, changed } of targets) {
  if (changed.length === 0) continue;
  const { error } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (error) {
    console.error(`update "${row.name}" (id=${row.id}) failed: ${error.message}`);
    failures.push(row.name);
    continue;
  }
  patchedIds.push(row.id);
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}
if (patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "set-amy-lead-address-in-notices.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds, address_line: ADDRESS_LINE }
  });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} flow(s) failed: ${failures.join(", ")}, re-run with --apply.`);
  process.exit(1);
}
console.log(
  "\nDone. No runs were enqueued; the next lead on each flow carries the address in its team notices."
);
