#!/usr/bin/env tsx
/**
 * One-shot: put the lead's PRICE in Amy Laidlaw's lead notices.
 *
 * Amy, 2026-08-06: "Can you please make sure the price shows for each lead?"
 * She sent it alongside a Clever notice carrying name, phone, email, address,
 * source and outcome, and no figure anywhere.
 *
 * Two different problems behind the one request, and only one of them is a
 * missing template line:
 *
 *   1. Clever Lead - Accept never EXTRACTS a price at all. `read_details`
 *      pulls a `price_band` token (over_1m / under_1m) because routing needs
 *      to know whether to keep a $1M+ lead for the owner, and nothing ever
 *      read the figure that judgement is made from. The invitation page shows
 *      it plainly: saved page artifacts from failed runs this month read
 *      "Home value $425,000" and "$225,000 est. value". So this adds the field
 *      first, then the line.
 *
 *   2. Realtor.com Lead DOES extract `lead_price_details` and already shows it
 *      on the team offer, the owner-direct notice, and the routing recap. It
 *      is missing only from the claimed and no-claim notices, which is the
 *      same partial coverage PR #1202 found for the address: the fact was on
 *      the notice somebody wrote most recently and absent from the others.
 *
 * ReferralExchange and HomeLight already carry a price on their notices and
 * are deliberately untouched.
 *
 * MECHANICAL CONSTRAINT, inherited from #1202 and the reason this is not a
 * blind find-and-replace: route_to_team's offer / fallback / claimed templates
 * are rendered by plain renderTemplate with NO collapseEmpty, so a var that
 * comes back empty texts a bare "Price:" label to a teammate. Every price var
 * touched here is extracted with an explicit "answer exactly: none" fallback,
 * so the worst case reads "Price: none" rather than a dangling label.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent (a re-run finds every
 * line present and reports no change), and it aborts rather than guessing when
 * a step or template key it expects is missing. Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-lead-price-in-notices.ts          # dry run
 *   npx tsx scripts/oneshot/amy-lead-price-in-notices.ts --apply
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/**
 * The Clever price field. Worded off the neighbouring price_band description,
 * which already tells the model where the figure lives ("the estimated home
 * value / price shown on the lead page"), so the two cannot disagree about
 * which number they mean.
 *
 * The "none" fallback is load-bearing: see the collapseEmpty note above.
 */
export const CLEVER_PRICE_FIELD = {
  name: "price",
  description:
    "The estimated home value or price shown on the lead page (e.g. $425,000). " +
    "This is the same figure price_band is judged from. If no value is shown, " +
    "answer exactly: none"
};

export const CLEVER_PRICE_LINE = "Price: {{vars.price}}";
export const REALTOR_PRICE_LINE = "Price: {{vars.lead_price_details}}";

type AnyStep = Record<string, unknown> & { id?: string; type?: string };

/** Depth-first lookup, so a step inside a branch arm is reachable. */
export function findStep(list: AnyStep[], id: string): AnyStep | null {
  for (const s of list) {
    if (s.id === id) return s;
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps?: AnyStep[] }> | undefined) ?? []) {
        const hit = findStep(arm.steps ?? [], id);
        if (hit) return hit;
      }
      const hit = findStep((s.else as AnyStep[] | undefined) ?? [], id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Insert the price line using the same placement rule #1202 established for
 * the address: immediately BEFORE the "Lead source:" line when the notice has
 * one, else right after the opening line, else appended. Keeping the two rules
 * identical is what stops these notices drifting into different shapes.
 *
 * Returns the template unchanged when the line is already there, which is what
 * makes the script idempotent.
 */
export function withPriceLine(template: string, line: string): string {
  if (template.includes(line)) return template;
  const lines = template.split("\n");
  const sourceIdx = lines.findIndex((l) => l.startsWith("Lead source:"));
  if (sourceIdx !== -1) {
    lines.splice(sourceIdx, 0, line);
    return lines.join("\n");
  }
  if (lines.length > 1) {
    lines.splice(1, 0, line);
    return lines.join("\n");
  }
  return `${template}\n${line}`;
}

/** Add the price field to a browse_extract, before price_band so they read together. */
export function withPriceField(step: AnyStep): boolean {
  const fields = (step.fields as Array<{ name?: string }> | undefined) ?? [];
  if (fields.some((f) => f.name === CLEVER_PRICE_FIELD.name)) return false;
  const bandIdx = fields.findIndex((f) => f.name === "price_band");
  if (bandIdx === -1) fields.push({ ...CLEVER_PRICE_FIELD });
  else fields.splice(bandIdx, 0, { ...CLEVER_PRICE_FIELD });
  step.fields = fields;
  return true;
}

/** Which template keys on which steps get a price line, per flow. */
export const PATCH_PLAN: Record<string, { line: string; targets: Array<[string, string]> }> = {
  "Clever Lead - Accept": {
    line: CLEVER_PRICE_LINE,
    targets: [
      ["qt_email", "body"],
      ["route", "offerTemplate"],
      ["route", "ownerDirectTemplate"],
      ["route", "claimedNotifyTemplate"],
      ["route", "ownerFallbackTemplate"],
      ["notify", "message"]
    ]
  },
  // Only the two notices that lack it. The offer, owner-direct, and routing
  // recap already carry lead_price_details and are left exactly as they are.
  "Realtor.com Lead": {
    line: REALTOR_PRICE_LINE,
    targets: [
      ["s4", "claimedNotifyTemplate"],
      ["s4", "ownerFallbackTemplate"]
    ]
  }
};

export type PatchResult = { changed: boolean; touched: string[] };

/** Apply a flow's plan to its definition in place. Throws on a missing shape. */
export function patchDefinition(name: string, def: { steps?: AnyStep[] }): PatchResult {
  const plan = PATCH_PLAN[name];
  if (!plan) throw new Error(`no patch plan for flow "${name}"`);
  const steps = def.steps ?? [];
  const touched: string[] = [];

  if (name === "Clever Lead - Accept") {
    const read = findStep(steps, "read_details");
    if (!read) throw new Error('Clever: step "read_details" is missing');
    if (withPriceField(read)) touched.push("read_details.fields");
  }

  for (const [stepId, key] of plan.targets) {
    const step = findStep(steps, stepId);
    if (!step) throw new Error(`${name}: step "${stepId}" is missing`);
    const current = step[key];
    if (typeof current !== "string") {
      throw new Error(`${name}: step "${stepId}" has no ${key} to patch`);
    }
    const next = withPriceLine(current, plan.line);
    if (next !== current) {
      step[key] = next;
      touched.push(`${stepId}.${key}`);
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const businessId =
    process.argv.includes("--business-id")
      ? (process.argv[process.argv.indexOf("--business-id") + 1] ?? DEFAULT_BUSINESS_ID)
      : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const names = Object.keys(PATCH_PLAN);
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .in("name", names);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: { steps?: AnyStep[] } }>;
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Flows not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  const patched: string[] = [];
  for (const row of rows) {
    const def = JSON.parse(JSON.stringify(row.definition)) as { steps?: AnyStep[] };
    let result: PatchResult;
    try {
      result = patchDefinition(row.name, def);
    } catch (e) {
      console.error(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    if (!result.changed) {
      console.log(`${row.name}: already carries the price, nothing to do.`);
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
    console.log(`${row.name}: ${result.touched.join(", ")}`);
    if (apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.name}: ${upErr.message}`);
        process.exit(1);
      }
      patched.push(row.id);
      console.log("  -> updated.");
    }
  }

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  if (patched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "amy-lead-price-in-notices.ts",
      businessId,
      details: { flow_ids: patched, clever_line: CLEVER_PRICE_LINE, realtor_line: REALTOR_PRICE_LINE }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
