#!/usr/bin/env tsx
/**
 * One-shot: make every lead flow's owner notification carry the FULL lead
 * details (audit Jul 2026). Amy's notify_owner steps had drifted: HomeLight's
 * said "Duane (seller in Mesa, ~$785K)" with no phone/email/address, and
 * Realtor.com's was just "Routing Update: {{vars.actions_taken}}" — the owner
 * had to dig through the QT email or the portal for the lead's contact info.
 *
 * Three idempotent edits, in place (manual template tweaks elsewhere survive):
 *   1. Rewrite the notify_owner message of known lead flows (keyed by flow
 *      name) to a standard block: personal info (name, phone, email), full
 *      address, price, source, and the run outcome.
 *   2. Add a trailing notify_owner step to "Clever Lead - Accept", which had
 *      NONE (the owner only heard about claims via the route templates).
 *   3. Upgrade every `lead_address` extraction field description to demand
 *      the FULL address — street, city, state, and ZIP — so the address the
 *      notify shows isn't just a street line.
 *
 * ReferralExchange's notify steps already carry name/phone/email/location/
 * price/source; RE alerts expose no street address, so they're left alone.
 *
 * Validates each patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/enrich-owner-notify.ts            # dry run
 *   npx tsx scripts/oneshot/enrich-owner-notify.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";
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
  message?: string;
  fields?: Field[];
};
type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Per-flow notify_owner rewrites, keyed by flow name and step id. The message
 * doubles as the idempotency marker (exact-match compare before writing).
 */
export const NOTIFY_MESSAGES: Record<string, Record<string, string>> = {
  "HomeLight Referral": {
    notify:
      "HomeLight referral: {{vars.lead_first_name}} ({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}).\n" +
      "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
      "Address: {{vars.lead_address}}\n" +
      "Outcome: {{vars.actions_taken}}."
  },
  "Realtor.com Lead": {
    s5:
      "Realtor.com Lead Routing Update:\n" +
      "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
      "Address: {{vars.lead_address}}\n" +
      "Price: {{vars.lead_price_details}}\n" +
      "Outcome: {{vars.actions_taken}}"
  }
};

/** The notify_owner step appended to Clever Lead - Accept (which had none). */
export const CLEVER_NOTIFY_STEP: Step = {
  id: "notify",
  type: "notify_owner",
  message:
    "Clever lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
    "Address: {{vars.lead_address}}\n" +
    "Lead source: Clever (listwithclever.com)\n" +
    "Outcome: {{vars.actions_taken}}."
};

/** Suffix demanding the full address; also the idempotency marker ("ZIP"). */
const FULL_ADDRESS_SUFFIX = " — the FULL address including street, city, state, and ZIP code";

/**
 * Apply all three edits to one flow definition. Returns whether anything
 * changed. Pure and idempotent (second run returns false).
 */
export function enrichOwnerNotify(def: Definition, flowName: string): boolean {
  let changed = false;
  const steps = def.steps ?? [];

  // 1. Rewrite known notify_owner messages.
  const wanted = NOTIFY_MESSAGES[flowName];
  if (wanted) {
    for (const step of steps) {
      if (step.type !== "notify_owner" || !step.id) continue;
      const next = wanted[step.id];
      if (next && step.message !== next) {
        step.message = next;
        changed = true;
      }
    }
  }

  // 2. Clever Lead - Accept: append the missing notify_owner step.
  if (
    flowName === "Clever Lead - Accept" &&
    !steps.some((s) => s.type === "notify_owner")
  ) {
    steps.push(JSON.parse(JSON.stringify(CLEVER_NOTIFY_STEP)) as Step);
    def.steps = steps;
    changed = true;
  }

  // 3. Every lead_address extraction demands the full address (street, city,
  //    state, ZIP) so the notify's Address line isn't just a street.
  for (const step of steps) {
    for (const field of step.fields ?? []) {
      if (field.name !== "lead_address") continue;
      const desc = field.description ?? "";
      if (desc.includes("ZIP")) continue;
      field.description = `${desc}${FULL_ADDRESS_SUFFIX}`;
      changed = true;
    }
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

  let changedCount = 0;
  const patched: Array<{ id: string; name: string }> = [];
  for (const row of (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const before = JSON.stringify(row.definition);
    if (!enrichOwnerNotify(def, row.name)) continue;

    // Re-validate the patched definition exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`\nFlow "${row.name}" (${row.id}) would become INVALID — skipping:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    changedCount += 1;
    console.log(`\n=== ${row.name} (${row.id}) ===`);
    console.log(`  BEFORE: ${before}`);
    console.log(`  AFTER : ${JSON.stringify(def)}`);

    if (args.apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.id}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> updated.");
      patched.push({ id: row.id, name: row.name });
    }
  }

  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already enriched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
  if (args.apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "enrich-owner-notify.ts",
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
