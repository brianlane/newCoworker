#!/usr/bin/env tsx
/**
 * One-shot: a lead that arrives with NO phone number alerts the tagged team,
 * instead of falling into a hole nobody is told about.
 *
 * The failure (Amy Laidlaw, 2026-08-14). A Clever seller's referral page came
 * back with an empty `lead_phone`. Everything downstream keys on that var, so
 * the run recorded, truthfully and silently:
 *
 *   skipped saving the contact (no usable phone);
 *   skipped a contact-tag update (no usable phone);
 *   AI call skipped (no_callee_phone);
 *   skipped a contact-tag update (no usable phone)
 *
 * The second of those tag steps is the under-$500K gate's cadence enrolment.
 * So the lead got NO team claim offer (correct, by the gate) and NO AI cadence
 * (an accident of the empty phone). It was in no pipeline at all, and the only
 * signal was an owner email whose subject line read `Clever lead: () none`.
 * The lead texted twice over two days before anyone noticed.
 *
 * What this adds, on each of the four ARRIVAL flows: a deterministic branch
 * right after the step that extracts the lead's details. When `lead_phone`
 * does not contain "+", the tagged team is alerted that a lead arrived that
 * the AI cannot contact.
 *
 * Deliberately PURELY ADDITIVE. `ReferralExchange Lead` and `New Lead Intake`
 * already carry a `notify_no_phone` step, and those are left exactly as they
 * are: they page the business OWNER, and replacing them would take away a
 * notice Amy gets today. This adds the team alert alongside.
 *
 * Why `contains "+"` and not an emptiness test: `whenSchema` requires a
 * non-empty needle, so there is no way to ask "is this var blank". Every
 * number the flows can actually use is E.164, so the "+" is the test. A
 * malformed non-E.164 phone also trips it, which errs toward telling a human,
 * the safe direction.
 *
 * Why an ALERT and not a claim offer: the lead cannot be worked from the flow
 * at all, so there is nothing to hand over on a deadline. It rides
 * `notify_lead_owner` + `unownedFallback: "team"`, whose selector excludes
 * anyone with `team_broadcast_enabled = false` (Amy, deliberately) and whose
 * tag filter falls back to the whole team when it matches nobody.
 *
 * Read-modify-write against the LIVE definition, validated through
 * parseAiFlowDefinition, idempotent, dry-run by default, `--revert` restores
 * the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-unreachable-lead-team-alert.ts                  # dry run
 *   npx tsx scripts/oneshot/amy-unreachable-lead-team-alert.ts --apply
 *   npx tsx scripts/oneshot/amy-unreachable-lead-team-alert.ts --only "Clever Lead - Accept"
 *   npx tsx scripts/oneshot/amy-unreachable-lead-team-alert.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStepDeep, type Definition } from "./amy-under-500k-ai-owned";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-unreachable-lead-team-alert.ts";

/**
 * One entry per arrival flow.
 *
 * `after` is the step that produces `lead_phone`; the guard is inserted
 * immediately behind it so a human hears about an uncontactable lead within
 * seconds rather than at the end of the run.
 *
 * `teamTag` is a TEMPLATE, so a flow that knows its lead type narrows the
 * alert to the teammates who cover it. Clever's accept flow has no lead-type
 * var at all (the whole flow is the Clever Offers seller path), so it carries
 * the literal instead.
 *
 * `details` lists only vars that flow actually defines: an unresolved
 * placeholder is a validation failure, not a blank line.
 */
type FlowPlan = {
  flow: string;
  prefix: string;
  after: string;
  teamTag: string;
  /** Human label for the lead source, used in the alert copy. */
  source: string;
  details: string[];
};

export const PLANS: FlowPlan[] = [
  {
    flow: "Clever Lead - Accept",
    prefix: "clever",
    after: "read_details",
    teamTag: "seller",
    source: "Clever",
    details: [
      "Name: {{vars.lead_name}}",
      "Address: {{vars.lead_address}}",
      "Price: {{vars.price}}",
      "Email: {{vars.lead_email}}",
      "Their referral page: {{vars.lead_url}}"
    ]
  },
  {
    flow: "ReferralExchange Lead",
    prefix: "re",
    after: "browse",
    // `lead_type`, NOT `route_lead_type`. The latter is a REACHABILITY gate:
    // its own field description says to answer "none" when the lead has no
    // phone option at all, which is exactly and only when this guard fires.
    // Using it would make the tag match nobody every single time, and the
    // fail-safe would widen the alert to the whole roster, quietly defeating
    // the seller/buyer narrowing this exists to provide. `lead_type` is the
    // plain question with no phone conditionality. (Bugbot, PR #1398.)
    teamTag: "{{vars.lead_type}}",
    source: "ReferralExchange",
    details: [
      "Name: {{vars.lead_name}}",
      "Location: {{vars.location}}",
      "Price: {{vars.price}}",
      "Email: {{vars.lead_email}}"
    ]
  },
  {
    flow: "Realtor.com Lead",
    prefix: "rt",
    after: "s1",
    teamTag: "{{vars.lead_type}}",
    source: "Realtor.com",
    details: [
      "Name: {{vars.lead_name}}",
      "Address: {{vars.lead_address}}",
      "Price: {{vars.lead_price_details}}",
      "Email: {{vars.lead_email}}",
      "Their listing link: {{vars.lead_url}}"
    ]
  },
  {
    flow: "New Lead Intake",
    prefix: "nli",
    after: "parse",
    teamTag: "{{vars.lead_type}}",
    source: "Amy (direct)",
    details: [
      "Name: {{vars.lead_name}}",
      "Address: {{vars.lead_address}}",
      "Price: {{vars.price}}",
      "Email: {{vars.lead_email}}",
      "Looking for: {{vars.lead_details}}"
    ]
  }
];

/** The alert copy. Says what is known, what the AI cannot do, and who acts. */
export function alertMessage(plan: FlowPlan): string {
  return [
    `A ${plan.source} lead just arrived with NO phone number, so the AI cannot`,
    "text or call them and nobody owns the lead.",
    ...plan.details,
    "Please open it and reach out by hand."
  ].join("\n");
}

/** The guard: a phone we can use, or the team hears about it. */
export function noPhoneGuard(plan: FlowPlan): Record<string, unknown> {
  return {
    id: `${plan.prefix}_no_phone_guard`,
    type: "branch",
    question: "Did this lead arrive with a phone number the AI can use?",
    branches: [
      {
        id: `${plan.prefix}_no_phone_ok`,
        label: "Yes: the flow works the lead normally",
        // Every usable number here is E.164. See the header for why this is a
        // "contains" and not an emptiness test.
        condition: { var: "lead_phone", contains: "+" },
        steps: []
      }
    ],
    else: [
      {
        id: `${plan.prefix}_no_phone_team`,
        type: "notify_lead_owner",
        message: alertMessage(plan),
        unownedFallback: "team",
        teamTagTemplate: plan.teamTag
      }
    ]
  };
}

export type PatchResult = { changed: boolean; notes: string[] };

export function patchFlow(def: Definition, plan: FlowPlan): PatchResult {
  const notes: string[] = [];
  const existing = findStepDeep(def.steps, `${plan.prefix}_no_phone_guard`) as
    | { else?: Array<{ id?: string; teamTagTemplate?: string; message?: string }> }
    | undefined;
  if (existing) {
    // Converge an already-installed guard onto the current plan instead of
    // declaring victory on the id alone. A guard whose tag or copy is stale
    // is exactly what a re-run should fix, and correcting it in place beats
    // reverting a live flow to reinstall it.
    const alert = (existing.else ?? []).find((s) => s.id === `${plan.prefix}_no_phone_team`);
    if (alert && alert.teamTagTemplate !== plan.teamTag) {
      notes.push(
        `${plan.prefix}_no_phone_team: team tag ${alert.teamTagTemplate} -> ${plan.teamTag}`
      );
      alert.teamTagTemplate = plan.teamTag;
    }
    const want = alertMessage(plan);
    if (alert && alert.message !== want) {
      notes.push(`${plan.prefix}_no_phone_team: alert copy refreshed`);
      alert.message = want;
    }
    return { changed: notes.length > 0, notes };
  }
  const steps = def.steps ?? [];
  const at = steps.findIndex((s) => (s as { id?: string }).id === plan.after);
  if (at < 0) {
    throw new Error(`${plan.flow}: expected a top-level step "${plan.after}", found none`);
  }
  steps.splice(at + 1, 0, noPhoneGuard(plan) as never);
  def.steps = steps;
  notes.push(
    `${plan.prefix}_no_phone_guard: inserted after ${plan.after}; a lead with no phone alerts the ${plan.teamTag} team`
  );
  return { changed: true, notes };
}

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
  const bi = process.argv.indexOf("--business-id");
  const businessId = bi >= 0 ? (process.argv[bi + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const oi = process.argv.indexOf("--only");
  const only = oi >= 0 ? (process.argv[oi + 1] ?? null) : null;
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
    const newest = (rows ?? [])
      .map((r) => (r as { details: Record<string, unknown> | null }).details)
      .find((d) => d && d.reverted !== true && d.previous);
    if (!newest) {
      console.error("No applied ledger rows with a previous definition to revert to.");
      process.exit(2);
    }
    const previous = newest.previous as Array<{ flow_id: string; flow: string; definition: unknown }>;
    for (const p of previous) {
      if (only && p.flow !== only) continue;
      console.log(`revert ${p.flow} (${p.flow_id})`);
      if (!apply) continue;
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: p.definition })
        .eq("id", p.flow_id)
        .eq("business_id", businessId);
      if (upErr) {
        console.error(`Revert failed for ${p.flow}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> reverted.");
    }
    if (apply) {
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? SCRIPT,
        businessId,
        details: { reverted: true, flows: previous.map((p) => p.flow) }
      });
    } else {
      console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    }
    return;
  }

  const plans = only ? PLANS.filter((p) => p.flow === only) : PLANS;
  if (plans.length === 0) {
    console.error(`--only "${only}" matches none of: ${PLANS.map((p) => p.flow).join(", ")}`);
    process.exit(2);
  }

  const previous: Array<{ flow_id: string; flow: string; definition: unknown }> = [];
  const patched: Array<{ id: string; flow: string; def: Definition; notes: string[] }> = [];
  for (const plan of plans) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id,name,definition")
      .eq("business_id", businessId)
      .eq("name", plan.flow)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for ${plan.flow}: ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`Flow not found on ${businessId}: ${plan.flow}`);
      process.exit(2);
    }
    const row = data as { id: string; name: string; definition: Definition };
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let res: PatchResult;
    try {
      res = patchFlow(def, plan);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    if (!res.changed) {
      console.log(`${plan.flow}: already has the guard, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      if (e instanceof AiFlowValidationError) {
        console.error(`${plan.flow}: patched definition INVALID, refusing to write:`);
        for (const issue of e.issues) console.error(`  - ${issue}`);
        process.exit(2);
      }
      throw e;
    }
    console.log(`${plan.flow}:`);
    for (const n of res.notes) console.log(`  ${n}`);
    previous.push({ flow_id: row.id, flow: plan.flow, definition: row.definition });
    patched.push({ id: row.id, flow: plan.flow, def, notes: res.notes });
  }

  if (patched.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!apply) {
    console.log(`\n[dry-run] Would patch ${patched.length} flow(s). Re-run with --apply.`);
    return;
  }
  for (const p of patched) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: p.def })
      .eq("id", p.id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Write failed for ${p.flow}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  -> updated ${p.flow}.`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? SCRIPT,
    businessId,
    details: { flows: patched.map((p) => p.flow), notes: patched.flatMap((p) => p.notes), previous }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
