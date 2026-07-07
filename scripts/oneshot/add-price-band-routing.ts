#!/usr/bin/env tsx
/**
 * One-shot: $1M+ leads go straight to the owner — never offered to the team.
 *
 * Two idempotent edits per lead flow (keyed by flow name):
 *   1. Add a `price_band` field to the flow's existing lead-extraction step:
 *      the extractor answers exactly "over_1m" or "under_1m" (no price shown
 *      → "under_1m", so the team offer remains the fail-safe default).
 *   2. Add the keep-for-owner rule to every route_to_team step:
 *      `ownerDirectWhen: { var: "price_band", equals: "over_1m" }` plus a
 *      flow-specific `ownerDirectTemplate` (the owner SMS with the lead's
 *      details). When it matches, the worker skips ALL team offers, texts the
 *      owner, and sets claimed_agent="none" so claim-gated steps skip — the
 *      flow's outcome notification still fires and says why.
 *
 * Requires the ownerDirectWhen engine support (same PR) deployed on the
 * ai-flow-worker BEFORE running with --apply: the schema validates the new
 * fields, and an old worker would ignore them (leads would still route to the
 * team — no breakage, just no $1M rule).
 *
 * Validates each patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/add-price-band-routing.ts            # dry run
 *   npx tsx scripts/oneshot/add-price-band-routing.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
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

type Field = { name?: string; description?: string };
type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Field[];
  ownerDirectWhen?: unknown;
  ownerDirectTemplate?: unknown;
};
type Definition = { steps?: Step[] } & Record<string, unknown>;

/** The over/under classification instruction, shared by every flow. */
const PRICE_BAND_BASE =
  "Answer exactly one lowercase token: over_1m or under_1m. Is the price/home " +
  "value ONE MILLION DOLLARS or more? $1M, $1,000,000, $1.2M and above are " +
  "over_1m; $999,999 and below are under_1m. If no price is shown, answer under_1m.";

export const OWNER_DIRECT_WHEN = { var: "price_band", equals: "over_1m" } as const;

/**
 * Per-flow wiring: which step grows the price_band field (its WHERE phrase
 * tells the extractor where to look), and the owner SMS each route step sends
 * instead of a team offer. Route steps are matched by id.
 */
export const PRICE_BAND_FLOWS: Record<
  string,
  {
    extractStepId: string;
    priceBandSource: string;
    ownerDirectTemplates: Record<string, string>;
  }
> = {
  "HomeLight Referral": {
    extractStepId: "alert",
    priceBandSource: "Based on the listing/asking price in the alert.",
    ownerDirectTemplates: {
      route:
        "HIGH-VALUE HomeLight referral ($1M+) kept for you — not offered to the team.\n" +
        "{{vars.lead_first_name}} — {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}).\n" +
        "Tap to claim: {{vars.leadUrl}}"
    }
  },
  "Realtor.com Lead": {
    extractStepId: "s1",
    priceBandSource: "Based on the property price in the message text.",
    ownerDirectTemplates: {
      s4:
        "HIGH-VALUE Realtor.com lead ($1M+) kept for you — not offered to the team.\n" +
        "{{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\n" +
        "{{vars.lead_address}} {{vars.lead_price_details}}\n" +
        "( {{vars.lead_url}} )"
    }
  },
  "ReferralExchange Lead": {
    extractStepId: "browse",
    priceBandSource: "Based on the asking/target price shown on the lead page.",
    // Amy's live flow branches into route_buyer/route_seller/route_both; a
    // freshly seeded flow has a single "route" step. The branch templates can
    // reference the richer live-flow vars (contact_note/web_source/lead_email);
    // the seed-shape "route" template sticks to the vars the seed extracts.
    ownerDirectTemplates: {
      ...Object.fromEntries(
        ["route_buyer", "route_seller", "route_both"].map((id) => [
          id,
          "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you — not offered to the team.\n" +
            "{{vars.lead_name}} ({{vars.lead_phone}}, email: {{vars.lead_email}}) in " +
            "{{vars.location}}, around {{vars.price}}. Contact: {{vars.contact_note}}.\n" +
            "Lead source: {{vars.web_source}}"
        ])
      ),
      route:
        "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you — not offered to the team.\n" +
        "{{vars.lead_name}} ({{vars.lead_phone}}) in {{vars.location}}, around {{vars.price}}.\n" +
        "Lead source: ReferralExchange (referralexchange.com)"
    }
  },
  "Clever Lead - Accept": {
    extractStepId: "read_details",
    priceBandSource:
      "Based on the estimated home value / price shown on the lead page.",
    ownerDirectTemplates: {
      route:
        "HIGH-VALUE Clever lead ($1M+) kept for you — not offered to the team.\n" +
        "{{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
        "Address: {{vars.lead_address}}\n" +
        "Lead source: Clever (listwithclever.com)"
    }
  }
};

/**
 * Apply both edits to one flow definition. Returns whether anything changed.
 * Pure and idempotent (second run returns false).
 */
export function addPriceBandRouting(def: Definition, flowName: string): boolean {
  // Case-insensitive flow-name match: the seed's default name is
  // "ReferralExchange lead" while Amy's live flow is "ReferralExchange Lead".
  const want = flowName.trim().toLowerCase();
  const wiring = Object.entries(PRICE_BAND_FLOWS).find(
    ([name]) => name.toLowerCase() === want
  )?.[1];
  if (!wiring) return false;
  let changed = false;
  const steps = def.steps ?? [];

  // 1. Grow the extraction step with price_band (skip when already present).
  const extract = steps.find((s) => s.id === wiring.extractStepId);
  if (extract && Array.isArray(extract.fields)) {
    const has = extract.fields.some((f) => f.name === "price_band");
    if (!has) {
      extract.fields.push({
        name: "price_band",
        description: `${PRICE_BAND_BASE} ${wiring.priceBandSource}`
      });
      changed = true;
    }
  }

  // 2. Stamp the keep-for-owner rule on each route step (skip when present so
  //    a later manual tweak to the template survives re-runs).
  for (const step of steps) {
    if (step.type !== "route_to_team" || !step.id) continue;
    const template = wiring.ownerDirectTemplates[step.id];
    if (!template || step.ownerDirectWhen !== undefined) continue;
    step.ownerDirectWhen = { ...OWNER_DIRECT_WHEN };
    step.ownerDirectTemplate = template;
    changed = true;
  }

  return changed;
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

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }

  // Pass 1: patch + validate EVERY flow in memory before writing ANY, so an
  // invalid later flow can never leave the tenant half-patched (some flows
  // with the $1M rule, others without).
  const pending: Array<{ id: string; name: string; def: Definition }> = [];
  for (const row of (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    if (!addPriceBandRouting(def, row.name)) continue;

    // Re-validate the patched definition exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`\nFlow "${row.name}" (${row.id}) would become INVALID — aborting before any write:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    console.log(`\n=== ${row.name} (${row.id}) ===`);
    console.log(`  AFTER: ${JSON.stringify(def)}`);
    pending.push({ id: row.id, name: row.name, def });
  }

  // Pass 2: write.
  const changedCount = pending.length;
  const patched: Array<{ id: string; name: string }> = [];
  if (args.apply) {
    for (const p of pending) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: p.def })
        .eq("id", p.id);
      if (upErr) {
        console.error(`Update failed for ${p.id}: ${upErr.message}`);
        console.error(
          patched.length > 0
            ? `Already written before the failure: ${patched.map((x) => x.name).join(", ")} — re-run after fixing; the patcher is idempotent.`
            : "Nothing had been written yet."
        );
        process.exit(1);
      }
      console.log(`  -> updated ${p.name}.`);
      patched.push({ id: p.id, name: p.name });
    }
  }

  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already patched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
  if (args.apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "add-price-band-routing.ts",
      businessId,
      details: { patched }
    });
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
