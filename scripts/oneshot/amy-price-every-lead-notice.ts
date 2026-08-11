#!/usr/bin/env tsx
/**
 * One-shot: finish the job `amy-lead-price-in-notices.ts` started, so EVERY
 * team-facing text about one of Amy Laidlaw's leads carries the price.
 *
 * Amy, 2026-08-06: "Can you please make sure the price shows for each lead?"
 * The Aug 7 script read that as the two flows she had a notice from in her
 * hand (Clever and Realtor.com) and patched those. A full audit of the live
 * definitions on 2026-08-11 found the same partial-coverage shape #1202 found
 * for the address, still spread across the rest of the account:
 *
 *   - 15 `claimedNotifyTemplate` / `ownerFallbackTemplate` on ReferralExchange,
 *     HomeLight and New Lead Intake: the offer said the price, the "you got it"
 *     and "nobody took it" follow-ups did not,
 *   - all 13 `unclaimedReminders.detailsTemplate` (the nudge rounds added
 *     Aug 10) carried the address and never the figure,
 *   - the AI-call gap/failure alerts, the late-contact notices, and every
 *     `bp_forward` relay named a lead with no price at all.
 *
 * Two flows had no price to template, so this adds the extraction first:
 *
 *   - Clever Spoke Check reads the SAME Clever lead page Clever Lead - Accept
 *     does (its `read_page` step already pulls the address and cash offers),
 *     so it gets the identical `price` field, worded identically.
 *   - Follow Up Requested is fed a contact-event or Amy's own Run-now text,
 *     which usually carries no figure. Its field therefore answers "none" far
 *     more often than not; that is honest, and better than a flow about a lead
 *     that structurally cannot show one. Getting a real figure there would mean
 *     recalling the lead page and browsing it mid-flow, which is a network round
 *     trip on a same-day urgent path: deliberately out of scope here.
 *
 * MECHANICAL CONSTRAINT, inherited from #1202 and the Aug 7 script: route_to_team
 * renders offer / fallback / claimed / reminder templates with plain
 * renderTemplate and NO collapseEmpty, so a var that comes back empty texts a
 * bare "Price:" label to a teammate. Both new fields extract with an explicit
 * "answer exactly: none" fallback, so the worst case reads "Price: none".
 *
 * The per-flow target lists below are exhaustive on purpose: they name EVERY
 * team-facing template the flow has, including the ones that already carry the
 * price. `withPriceLine` no-ops on those, so the list doubles as a standing
 * assertion of full coverage, and a step or key that disappears aborts the run
 * instead of silently patching three quarters of the account again.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 * `--revert` restores the exact definition each apply replaced, from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-price-every-lead-notice.ts                  # dry run
 *   npx tsx scripts/oneshot/amy-price-every-lead-notice.ts --apply
 *   npx tsx scripts/oneshot/amy-price-every-lead-notice.ts --only "HomeLight Referral"
 *   npx tsx scripts/oneshot/amy-price-every-lead-notice.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStep, withPriceLine } from "./amy-lead-price-in-notices";
import { recordOneshotApplied } from "./_ledger";

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const SCRIPT_BASENAME = "amy-price-every-lead-notice.ts";

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

/**
 * The Clever lead page's price, for the Spoke Check flow. Worded VERBATIM from
 * `CLEVER_PRICE_FIELD` in amy-lead-price-in-notices.ts: it is literally the
 * same page, and two descriptions of one number is how they drift apart.
 */
export const SPOKE_CHECK_PRICE_FIELD = {
  name: "price",
  description:
    "The estimated home value or price shown on the lead page (e.g. $425,000). " +
    "This is the same figure price_band is judged from. If no value is shown, " +
    "answer exactly: none"
};

/**
 * Follow Up Requested reads a contact-event notice or Amy's Run-now text, not a
 * lead page, so this one asks only for what the text itself gives. The "none"
 * fallback is load-bearing: see the collapseEmpty note above.
 */
export const FOLLOWUP_PRICE_FIELD = {
  name: "price",
  description:
    "The lead's home value, asking price, or budget if the text gives one " +
    "(e.g. $425,000). Do not guess or estimate. If the text gives no figure, " +
    "answer exactly: none"
};

export const PRICE_LINE = "Price: {{vars.price}}";
/** Realtor.com stores the figure (with bed/bath) under its own var. */
export const REALTOR_PRICE_LINE = "Price: {{vars.lead_price_details}}";

/** A template location: a step id plus a dotted key path within that step. */
export type Target = readonly [stepId: string, keyPath: string];

export type FlowPlan = {
  line: string;
  /** Add this extraction field to `fieldStep` before patching templates. */
  field?: { step: string; field: { name: string; description: string }; before?: string };
  /** EVERY team-facing template on the flow; already-priced ones no-op. */
  targets: readonly Target[];
};

/**
 * Every team-facing text on each of Amy's seven lead flows.
 *
 * Deliberately NOT here:
 *   - lead-facing copy (send_sms/send_email addressed to the lead). Quoting a
 *     referral network's estimated home value back at a seller is a valuation
 *     claim, and it sits badly beside Amy's own "I have an appraiser to price
 *     your listing with precision" pitch. Her ask was the team's texts.
 *   - "Realtor.com Reply - forward to lead owner" and "Clever Lead - Group
 *     Reply Connected": neither extracts a price, and neither reads a page that
 *     is known to show one, so a line there would need a guessed extraction.
 *   - "Clever Homeward Offers": a coaching note about a cash offer, not a
 *     notice about a lead.
 */
export const PATCH_PLAN: Record<string, FlowPlan> = {
  "Clever Lead - Accept": {
    line: PRICE_LINE,
    targets: [
      ["route", "offerTemplate"],
      ["route", "ownerDirectTemplate"],
      ["route", "claimedNotifyTemplate"],
      ["route", "ownerFallbackTemplate"],
      ["route", "unclaimedReminders.detailsTemplate"],
      ["call_gap_alert", "message"],
      ["call_fail_alert", "message"],
      ["notify", "message"],
      ["bp_forward", "message"]
    ]
  },
  "ReferralExchange Lead": {
    line: PRICE_LINE,
    targets: [
      ["route_buyer", "offerTemplate"],
      ["route_buyer", "ownerDirectTemplate"],
      ["route_buyer", "claimedNotifyTemplate"],
      ["route_buyer", "ownerFallbackTemplate"],
      ["route_buyer", "unclaimedReminders.detailsTemplate"],
      ["route_seller", "offerTemplate"],
      ["route_seller", "ownerDirectTemplate"],
      ["route_seller", "claimedNotifyTemplate"],
      ["route_seller", "ownerFallbackTemplate"],
      ["route_seller", "unclaimedReminders.detailsTemplate"],
      ["route_both", "offerTemplate"],
      ["route_both", "ownerDirectTemplate"],
      ["route_both", "claimedNotifyTemplate"],
      ["route_both", "ownerFallbackTemplate"],
      ["route_both", "unclaimedReminders.detailsTemplate"],
      ["notify", "message"],
      ["notify_both", "message"],
      ["notify_buyer", "message"],
      ["notify_no_phone", "message"],
      ["bp_forward", "message"]
    ]
  },
  "HomeLight Referral": {
    line: PRICE_LINE,
    targets: [
      ["route", "offerTemplate"],
      ["route", "ownerDirectTemplate"],
      ["route", "claimedNotifyTemplate"],
      ["route", "ownerFallbackTemplate"],
      ["route", "unclaimedReminders.detailsTemplate"],
      ["notify", "message"],
      ["notify_unclaimed", "message"],
      ["lost_notify", "message"],
      ["late_notify", "message"],
      ["late2_notify", "message"],
      ["late2_never_notify", "message"],
      ["bp_eta_notify", "message"],
      ["bp_forward", "message"]
    ]
  },
  "Realtor.com Lead": {
    line: REALTOR_PRICE_LINE,
    targets: [
      ["s4", "offerTemplate"],
      ["s4", "ownerDirectTemplate"],
      ["s4", "claimedNotifyTemplate"],
      ["s4", "ownerFallbackTemplate"],
      ["s4", "unclaimedReminders.detailsTemplate"],
      ["s5", "message"],
      ["bp_forward", "message"]
    ]
  },
  "New Lead Intake": {
    line: PRICE_LINE,
    targets: [
      ["route_assigned", "offerTemplate"],
      ["route_assigned", "claimedNotifyTemplate"],
      ["route_assigned", "ownerFallbackTemplate"],
      ["route_assigned", "unclaimedReminders.detailsTemplate"],
      ["route_buyer", "offerTemplate"],
      ["route_buyer", "ownerDirectTemplate"],
      ["route_buyer", "claimedNotifyTemplate"],
      ["route_buyer", "ownerFallbackTemplate"],
      ["route_buyer", "unclaimedReminders.detailsTemplate"],
      ["route_seller", "offerTemplate"],
      ["route_seller", "ownerDirectTemplate"],
      ["route_seller", "claimedNotifyTemplate"],
      ["route_seller", "ownerFallbackTemplate"],
      ["route_seller", "unclaimedReminders.detailsTemplate"],
      ["route_both", "offerTemplate"],
      ["route_both", "ownerDirectTemplate"],
      ["route_both", "claimedNotifyTemplate"],
      ["route_both", "ownerFallbackTemplate"],
      ["route_both", "unclaimedReminders.detailsTemplate"],
      ["notify", "message"],
      ["notify_no_phone", "message"]
    ]
  },
  "Clever - Spoke Check & Weekly Call Follow-Up": {
    line: PRICE_LINE,
    // read_page already browses the Clever lead page for the address and the
    // cash offers; the figure sits on the same page, above both.
    field: { step: "read_page", field: SPOKE_CHECK_PRICE_FIELD, before: "cash_offers" },
    targets: [
      ["spoke_check", "offerTemplate"],
      ["spoke_check", "claimedNotifyTemplate"],
      ["spoke_check", "ownerFallbackTemplate"],
      ["spoke_check", "unclaimedReminders.detailsTemplate"],
      ["wrap_up", "message"]
    ]
  },
  "Follow Up Requested (Unclaimed Leads)": {
    line: PRICE_LINE,
    field: { step: "read_request", field: FOLLOWUP_PRICE_FIELD, before: "followup_note" },
    targets: [
      ["route_buyer", "offerTemplate"],
      ["route_buyer", "claimedNotifyTemplate"],
      ["route_buyer", "ownerFallbackTemplate"],
      ["route_buyer", "unclaimedReminders.detailsTemplate"],
      ["route_seller", "offerTemplate"],
      ["route_seller", "claimedNotifyTemplate"],
      ["route_seller", "ownerFallbackTemplate"],
      ["route_seller", "unclaimedReminders.detailsTemplate"]
    ]
  }
};

/**
 * Add the price line unless the template ALREADY shows the price.
 *
 * `withPriceLine` alone tests for the exact "Price: {{vars.x}}" line, which was
 * right for the Aug 7 script (its two flows had no figure at all) and wrong
 * here: most of these notices state it in prose instead, as "(~{{vars.price}})"
 * or "in {{vars.location}}, around {{vars.price}}". Testing the LINE would have
 * texted teammates the figure twice, once in the sentence and once in a label
 * underneath it. Amy's rule is that the price must be there, not that it must
 * be there in one particular shape, so the presence test is the var reference.
 */
export function withPriceShown(template: string, line: string): string {
  const varRef = /\{\{vars\.[\w.]+\}\}/.exec(line)?.[0];
  if (varRef && template.includes(varRef)) return template;
  return withPriceLine(template, line);
}

/** Read a dotted key path off a step ("unclaimedReminders.detailsTemplate"). */
export function readTemplate(step: AnyStep, keyPath: string): unknown {
  let cur: unknown = step;
  for (const part of keyPath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Write a dotted key path on a step. The parent object must already exist. */
export function writeTemplate(step: AnyStep, keyPath: string, value: string): void {
  const parts = keyPath.split(".");
  const leaf = parts.pop() as string;
  let cur: Record<string, unknown> = step;
  for (const part of parts) {
    const next = cur[part];
    if (next === null || typeof next !== "object") {
      throw new Error(`cannot write "${keyPath}": "${part}" is not an object`);
    }
    cur = next as Record<string, unknown>;
  }
  cur[leaf] = value;
}

/**
 * Add an extraction field to a step's `fields`, before `before` when given so
 * related figures read together. Returns false when it is already there, which
 * is half of what makes this script idempotent.
 */
export function withExtractField(
  step: AnyStep,
  field: { name: string; description: string },
  before?: string
): boolean {
  const fields = (step.fields as Array<{ name?: string }> | undefined) ?? [];
  if (fields.some((f) => f.name === field.name)) return false;
  const anchor = before ? fields.findIndex((f) => f.name === before) : -1;
  if (anchor === -1) fields.push({ ...field });
  else fields.splice(anchor, 0, { ...field });
  step.fields = fields;
  return true;
}

export type PatchResult = { changed: boolean; touched: string[] };

/**
 * Apply a flow's plan to its definition in place. Throws rather than guessing
 * when a step or template key it expects is gone: that means the live flow moved
 * and the plan needs re-checking, not a silent partial patch.
 */
export function patchDefinition(name: string, def: Definition): PatchResult {
  const plan = PATCH_PLAN[name];
  if (!plan) throw new Error(`no patch plan for flow "${name}"`);
  const steps = def.steps ?? [];
  const touched: string[] = [];

  if (plan.field) {
    const step = findStep(steps, plan.field.step);
    if (!step) throw new Error(`${name}: step "${plan.field.step}" is missing`);
    if (withExtractField(step, plan.field.field, plan.field.before)) {
      touched.push(`${plan.field.step}.fields`);
    }
  }

  for (const [stepId, keyPath] of plan.targets) {
    const step = findStep(steps, stepId);
    if (!step) throw new Error(`${name}: step "${stepId}" is missing`);
    const current = readTemplate(step, keyPath);
    if (typeof current !== "string") {
      throw new Error(`${name}: step "${stepId}" has no ${keyPath} to patch`);
    }
    const next = withPriceShown(current, plan.line);
    if (next !== current) {
      writeTemplate(step, keyPath, next);
      touched.push(`${stepId}.${keyPath}`);
    }
  }
  return { changed: touched.length > 0, touched };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

export type RevertTarget = { flow_id: string; previous_definition: Definition };

/**
 * Narrow the revertable flows by `--only`. Split out and exported so the
 * "matched nothing" case is a value the caller must handle rather than an
 * empty loop that falls through to exit 0.
 */
export function selectRevertTargets(
  newestPerFlow: ReadonlyMap<string, RevertTarget>,
  only: string | null
): Array<[string, RevertTarget]> {
  return [...newestPerFlow].filter(([name]) => !only || name === only);
}

/**
 * Reject an `--only` that names no flow this script knows about, on EVERY path.
 * The apply path always did this by construction; the revert path read the
 * ledger instead, so a typo there skipped every entry and still exited 0, which
 * reads as a clean rollback while the live definitions stay patched.
 */
export function assertKnownFlowName(only: string | null): void {
  if (only === null || only in PATCH_PLAN) return;
  throw new Error(
    `--only "${only}" is not one of this script's flows: ${Object.keys(PATCH_PLAN).join(", ")}`
  );
}

/** Restore the definition each apply replaced, newest ledger row per flow. */
async function revert(db: SupabaseClient, businessId: string, apply: boolean, only: string | null) {
  const { data, error } = await db
    .from("applied_oneshots")
    .select("details,applied_at")
    .eq("business_id", businessId)
    .eq("script", SCRIPT_BASENAME)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const newestPerFlow = new Map<string, { flow_id: string; previous_definition: Definition }>();
  for (const row of (data ?? []) as Array<{ details: Record<string, unknown> | null }>) {
    for (const entry of (row.details?.flows as Array<Record<string, unknown>>) ?? []) {
      const flowName = String(entry.flow_name ?? "");
      if (!flowName || entry.reverted === true || !entry.previous_definition) continue;
      if (!newestPerFlow.has(flowName)) {
        newestPerFlow.set(flowName, {
          flow_id: String(entry.flow_id),
          previous_definition: entry.previous_definition as Definition
        });
      }
    }
  }
  if (newestPerFlow.size === 0) {
    console.error("No applied ledger rows with a previous_definition to revert to.");
    process.exit(2);
  }
  const selected = selectRevertTargets(newestPerFlow, only);
  if (selected.length === 0) {
    // Silently reverting nothing is the worst outcome here: the operator reads
    // exit 0 as "rolled back" and the live definitions stay patched.
    console.error(
      `--only "${only}" matched no applied ledger row. Flows this script has patched: ` +
        `${[...newestPerFlow.keys()].join(", ")}`
    );
    process.exit(2);
  }
  const reverted: Array<Record<string, unknown>> = [];
  for (const [flowName, entry] of selected) {
    console.log(`revert ${flowName} (${entry.flow_id}) to ${entry.previous_definition.steps?.length} steps`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: entry.previous_definition })
      .eq("id", entry.flow_id)
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Revert failed for ${flowName}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    reverted.push({ flow_id: entry.flow_id, flow_name: flowName, reverted: true });
  }
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
    return;
  }
  if (reverted.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT_BASENAME,
      businessId,
      details: { flows: reverted }
    });
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const isRevert = process.argv.includes("--revert");
  const only = argValue("--only");
  const businessId = argValue("--business-id") ?? DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  try {
    assertKnownFlowName(only);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  if (isRevert) return revert(db, businessId, apply, only);

  const names = Object.keys(PATCH_PLAN).filter((n) => !only || n === only);
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

  const patched: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    let result: PatchResult;
    try {
      result = patchDefinition(row.name, def);
    } catch (e) {
      console.error(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: already carries the price everywhere, nothing to do.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      console.error(`${row.name} would become INVALID, aborting before any write:`);
      if (e instanceof AiFlowValidationError) for (const i of e.issues) console.error(`  - ${i}`);
      else console.error(e);
      process.exit(2);
    }
    console.log(`${row.name}: ${result.touched.length} change(s)`);
    for (const t of result.touched) console.log(`  - ${t}`);
    if (apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.name}: ${upErr.message}`);
        process.exit(1);
      }
      // No flow-version table exists, so the ledger row carries the exact
      // definition this write replaced. That is the whole rollback story.
      patched.push({
        flow_id: row.id,
        flow_name: row.name,
        touched: result.touched,
        previous_definition: previous
      });
      console.log("  -> updated.");
    }
  }

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  if (patched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT_BASENAME,
      businessId,
      details: { flows: patched, price_line: PRICE_LINE, realtor_line: REALTOR_PRICE_LINE }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
