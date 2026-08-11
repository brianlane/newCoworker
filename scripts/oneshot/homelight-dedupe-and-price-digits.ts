#!/usr/bin/env tsx
/**
 * One-shot: stop HomeLight Referral running twice for one referral, and make
 * its `price_digits` extraction answer the same thing every time.
 *
 * Both are Aug 11 2026 findings from the same pair of runs.
 *
 * 1. DUPLICATE RUNS. Two runs six seconds apart (15:43:54 and 15:44:00 UTC)
 *    processed referral hmlt.co/42a2915a for seller "Marla". Byte-identical
 *    windowText, same sender, different inbound event ids: HomeLight (or the
 *    carrier) delivered the same alert twice and each delivery spawned a run.
 *    Both routed to the team, both texted Gabrielle Mota, and both parked in a
 *    60-minute wait for her reply.
 *
 *    `options.dedupeLeadRuns` on its own is INERT here, which is why this sets
 *    the var too: that gate bails when the run has neither phone nor email, and
 *    HomeLight's first comm step (`route`) runs BEFORE `card` reads the contact
 *    details off the portal. At gate time the run knows a first name, a city, a
 *    price, and the referral link. The link is unique per referral and is
 *    extracted at step 0, so it is the only identity available in time.
 *
 *    The 15-minute correlation window cannot help (it gathers text into one
 *    window, it does not suppress a second run), and neither can sender-keyed
 *    re-entry (HomeLight legitimately sends many different referrals from that
 *    one number).
 *
 * 2. price_digits. The same alert produced "507" in one run and "507258" in
 *    the other. This is not cosmetic: `price_digits` is one of the two
 *    EMAIL_MATCH_TEMPLATES (see update-dave-routed-aiflows.ts) used to match
 *    HomeLight's portal email back to this lead, so a wrong value means the
 *    late-arriving contact details never reach the flow. The old wording asked
 *    for "the leading digits ONLY" and gave $429K -> 429 and $264,000 -> 264 as
 *    examples, neither of which says what to do with $507,258. The new wording
 *    answers that case directly.
 *
 * Read-modify-write against the LIVE definition, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent, dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-dedupe-and-price-digits.ts          # dry run
 *   npx tsx scripts/oneshot/homelight-dedupe-and-price-digits.ts --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { findStep } from "./amy-lead-price-in-notices";
import { recordOneshotApplied } from "./_ledger";

/** Amy Laidlaw Real Estate. */
const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
export const FLOW_NAME = "HomeLight Referral";

/**
 * The var HomeLight identifies a referral by. Set at step 0 (`extract_url`,
 * saveAs leadUrl), which is what makes it usable at the first comm step.
 */
export const DEDUPE_VAR = "leadUrl";

/**
 * Unambiguous for a full-precision figure, which is what the old wording was
 * missing. Keeps the two worked examples that were already right and adds the
 * case that broke, stated as a rule rather than a third example.
 */
export const PRICE_DIGITS_DESCRIPTION =
  "The price's first three digits, left to right, stopping after three: no $, " +
  "commas, K or M. For $429K answer 429; for $264,000 answer 264; for " +
  "$507,258 answer 507. Fewer than three digits before the comma or K/M: " +
  "answer just those. Used to match this lead against the portal alert email.";

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[]; options?: Record<string, unknown> };

export type PatchResult = { changed: boolean; touched: string[] };

/**
 * Apply both edits in place. Throws rather than guessing when the step or
 * field it expects is gone: a renamed step means the live flow moved and this
 * script's assumptions need re-checking.
 */
export function patchHomeLight(def: Definition): PatchResult {
  const touched: string[] = [];
  const options = (def.options ?? {}) as Record<string, unknown>;

  // The var key is only consulted when dedupeLeadRuns is on, so both go
  // together or neither does.
  if (options.dedupeLeadRuns !== true) {
    options.dedupeLeadRuns = true;
    touched.push("options.dedupeLeadRuns");
  }
  if (options.dedupeLeadRunsByVar !== DEDUPE_VAR) {
    options.dedupeLeadRunsByVar = DEDUPE_VAR;
    touched.push("options.dedupeLeadRunsByVar");
  }
  def.options = options;

  const alert = findStep(def.steps ?? [], "alert");
  if (!alert) throw new Error(`${FLOW_NAME}: step "alert" is missing`);
  const fields = (alert.fields as Array<{ name?: string; description?: string }> | undefined) ?? [];
  const digits = fields.find((f) => f.name === "price_digits");
  if (!digits) throw new Error(`${FLOW_NAME}: step "alert" has no price_digits field`);
  if (digits.description !== PRICE_DIGITS_DESCRIPTION) {
    digits.description = PRICE_DIGITS_DESCRIPTION;
    touched.push("alert.price_digits.description");
  }

  // The dedupe var must be produced before the first comm step or the gate has
  // nothing to read. Cheap to assert here, and it is the assumption the whole
  // fix rests on.
  const url = findStep(def.steps ?? [], "url");
  if (!url || url.saveAs !== DEDUPE_VAR) {
    throw new Error(
      `${FLOW_NAME}: step "url" does not save ${DEDUPE_VAR}; the dedupe key would never be set`
    );
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
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`Flow "${FLOW_NAME}" not found on ${businessId}`);
    process.exit(2);
  }
  const row = data as { id: string; name: string; definition: Definition };
  const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
  const def = JSON.parse(JSON.stringify(row.definition)) as Definition;

  let result: PatchResult;
  try {
    result = patchHomeLight(def);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (!result.changed) {
    console.log(`${FLOW_NAME}: already deduped by ${DEDUPE_VAR} and worded correctly.`);
    return;
  }
  try {
    parseAiFlowDefinition(def);
  } catch (e) {
    console.error(`${FLOW_NAME} would become INVALID, aborting before any write:`);
    if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
    else console.error(e);
    process.exit(2);
  }
  console.log(`${FLOW_NAME}: ${result.touched.join(", ")}`);
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: def })
    .eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-dedupe-and-price-digits.ts",
    businessId,
    details: {
      flow_id: row.id,
      flow_name: row.name,
      touched: result.touched,
      dedupe_var: DEDUPE_VAR,
      previous_definition: previous
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
