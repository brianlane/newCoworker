#!/usr/bin/env tsx
/**
 * One-shot: stop the HomeLight post-claim extraction from grabbing Amy's own
 * contact info (Jul 7 incident — the run re-opened the hmlt.co claim landing
 * page, which has NO lead contact card, and the extractor answered with the
 * agent's own name and Coworker DID; the lead_sms then tried to text our own
 * number and burned every retry).
 *
 * Two idempotent edits to the "HomeLight Referral" flow, in place:
 *   1. The post-claim `card` browse_extract field descriptions now tell the
 *      extractor explicitly: NEVER the agent's own info, and answer 'none'
 *      when the page shows no lead contact card — so a landing/list page
 *      yields empty fields (which email_extract's backfill can then fill)
 *      instead of confident garbage.
 *   2. The `email_card` email_extract match loosens to the lead's FIRST NAME
 *      only. It previously also required {{vars.price_digits}}, but the alert
 *      rounds ($785K → "785") while the email spells the price in full
 *      ($784,663) — the "785" token never appears, so the backfill could
 *      never find the email exactly when it was needed.
 *
 * The engine-side guards (self-number scrub, send_sms self/skip handling)
 * ship in the same PR; this one-shot is the flow-data half.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/fix-homelight-extraction.ts            # dry run
 *   npx tsx scripts/oneshot/fix-homelight-extraction.ts --apply    # write
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
  fields?: Field[];
  matchTemplates?: string[];
};
type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * New post-claim contact-card field descriptions. Each one names the failure
 * mode ("never the agent's own info") and gives the extractor a safe out
 * ('none') for pages without a lead contact card.
 */
export const CARD_FIELD_DESCRIPTIONS: Record<string, string> = {
  lead_name:
    "The lead's (client's) full name from the portal contact card. NEVER the " +
    "agent's own name shown in the page header, account menu, or a 'New " +
    "Referral for <agent>' banner. If the page shows no lead contact card " +
    "(e.g. it's a claim landing page or a referral list), answer 'none'.",
  lead_phone:
    "The lead's mobile phone from the portal contact card, in E.164 if " +
    "possible. NEVER the agent's own phone number and NEVER a HomeLight " +
    "claim/support number. If the page shows no lead contact card with a " +
    "phone, answer 'none'.",
  lead_email:
    "The lead's email from the portal contact card. NEVER the agent's own " +
    "email. If the page shows no lead contact card with an email, answer 'none'.",
  lead_address:
    "The property address from the portal contact card — the FULL address " +
    "including street, city, state, and ZIP code. If the page shows no lead " +
    "contact card, answer 'none'."
};

/** email_card match: first name only (price formatting differs alert vs email). */
export const EMAIL_MATCH_TEMPLATES = ["{{vars.lead_first_name}}"];

/**
 * Apply both edits to the HomeLight flow definition. Pure and idempotent;
 * returns whether anything changed. Non-HomeLight flows are never touched.
 */
export function fixHomelightExtraction(def: Definition, flowName: string): boolean {
  if (flowName !== "HomeLight Referral") return false;
  let changed = false;

  for (const step of def.steps ?? []) {
    if (step.id === "card" && step.type === "browse_extract") {
      for (const field of step.fields ?? []) {
        const next = field.name ? CARD_FIELD_DESCRIPTIONS[field.name] : undefined;
        if (next && field.description !== next) {
          field.description = next;
          changed = true;
        }
      }
    }
    if (step.id === "email_card" && step.type === "email_extract") {
      if (JSON.stringify(step.matchTemplates) !== JSON.stringify(EMAIL_MATCH_TEMPLATES)) {
        step.matchTemplates = [...EMAIL_MATCH_TEMPLATES];
        changed = true;
      }
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
    if (!fixHomelightExtraction(def, row.name)) continue;

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
    console.log("\nNo flows needed changes (already fixed).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
  if (args.apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "fix-homelight-extraction.ts",
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
