#!/usr/bin/env tsx
/**
 * One-shot: Clever SELLER calls leave a voicemail.
 *
 * The gap, found while adding the buyer ladder and confirmed by Amy on
 * 2026-08-24: `ai_call_1`, `ai_call_2` and `ai_call_3` on "Clever Lead -
 * Accept" carry no `voicemailTemplate` at all, and never have across the
 * flow's 119 runs. 116 of those are sellers. So a Clever seller who does not
 * pick up hears nothing: three calls, three silences, and the first thing they
 * ever hear from this office is a teammate ringing later, if one claims.
 *
 * Every comparable call on this account already leaves one. ReferralExchange's
 * `ai_call_seller`, `ai_call_buyer` and `ai_call_both` all do, and the buyer
 * rungs added to this same flow do. Clever's seller rungs were the outlier.
 *
 * The copy follows the ladder's own arc rather than repeating one message
 * three times, matching how the personas escalate (first contact, "again",
 * then a last try that says we will stop):
 *   1. who we are, what it is about, call us back;
 *   2. the same plus the one concrete reason to call back that the seller
 *      persona leads on, the licensed appraiser, so the second message earns
 *      its place instead of nagging;
 *   3. a plain last message that says we will leave them be, which is what
 *      the round 3 persona already tells the AI to say out loud.
 *
 * Deliberately names Clever and not `{{vars.lead_address}}`. The address is a
 * template var that can come back empty, and "selling your home on ." is a
 * worse voicemail than one that never mentions it. ReferralExchange's
 * voicemails name the source and no address, for the same reason.
 *
 * The BUYER rungs are untouched: they already leave a voicemail, added with
 * the buyer ladder. Theirs does not escalate across the three rungs, which is
 * a small inconsistency with what this installs and is noted rather than
 * changed, since re-applying that script to reword one field would cost a
 * live write for a nicety.
 *
 * Refuses to overwrite a voicemail that is already there, so a hand edit in
 * the builder is never lost (--force overrides). Idempotent, dry-run by
 * default, ledger-recorded, --revert removes them again. Enqueues nothing and
 * sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-seller-voicemail.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-seller-voicemail.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-clever-seller-voicemail.ts --business <uuid> --revert --apply
 */
import { CLEVER_FLOW_NAME, walkSteps } from "./amy-clever-lead-type";

export { CLEVER_FLOW_NAME };

/** The schema cap on a voicemail (`voicemailTemplate` in schema.ts). */
export const VOICEMAIL_MAX = 600;

/** Amy's line, the one every other Clever message gives out. */
const CALLBACK = "602-695-1142";

/**
 * One voicemail per seller rung, in ladder order.
 *
 * Keyed by step id rather than positionally so a reordering of the ladder
 * cannot silently pair round 3's "we will leave you be" with the first call.
 */
export const SELLER_VOICEMAILS: ReadonlyArray<{ stepId: string; voicemail: string }> = [
  {
    stepId: "ai_call_1",
    voicemail:
      "Hi {{vars.lead_name.first}}, this is the Amy Laidlaw Team with HomeSmart, calling about " +
      `selling your home through Clever. We would love to help. Call us back at ${CALLBACK}.`
  },
  {
    stepId: "ai_call_2",
    voicemail:
      "Hi {{vars.lead_name.first}}, the Amy Laidlaw Team with HomeSmart again, about selling " +
      "your home through Clever. We have a licensed appraiser on the team, so the number we " +
      `give you is a real one. Call us back at ${CALLBACK}.`
  },
  {
    stepId: "ai_call_3",
    voicemail:
      "Hi {{vars.lead_name.first}}, the Amy Laidlaw Team with HomeSmart, one last message about " +
      "your Clever referral. We will leave you be now, and we would be glad to hear from you " +
      `any time at ${CALLBACK}.`
  }
];

type AnyStep = Record<string, unknown> & { id?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;

/**
 * Install or remove the seller voicemails.
 *
 * Refuses a rung whose voicemail is present and is NOT one of these, because
 * this flow is edited by hand and clobbering somebody's wording would destroy
 * it with no trace.
 */
export function patchSellerVoicemails(
  def: AnyDef,
  direction: "apply" | "revert",
  force = false
): { changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  const steps = walkSteps(def.steps);
  for (const entry of SELLER_VOICEMAILS) {
    const step = steps.find((s) => s.id === entry.stepId) as AnyStep | undefined;
    if (!step) {
      problems.push(`"${entry.stepId}" is missing from the flow`);
      continue;
    }
    const current = typeof step.voicemailTemplate === "string" ? step.voicemailTemplate : "";
    if (direction === "apply") {
      if (current === entry.voicemail) continue;
      if (current && !force) {
        problems.push(
          `"${entry.stepId}" already has a voicemail this script did not write, so it will not ` +
            "be replaced. Re-run with --force to overwrite it."
        );
        continue;
      }
      step.voicemailTemplate = entry.voicemail;
      changed.push(`${entry.stepId}: voicemail added`);
    } else {
      if (current !== entry.voicemail) continue;
      delete step.voicemailTemplate;
      changed.push(`${entry.stepId}: voicemail removed`);
    }
  }
  return { changed, problems };
}

/* c8 ignore start -- the IO shell; the pure patch above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { parseAiFlowDefinition, summarizeDefinition } = await import(
    "../../src/lib/ai-flows/schema.ts"
  );
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const REVERT = process.argv.includes("--revert");
  const FORCE = process.argv.includes("--force");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-clever-seller-voicemail.ts --business <uuid> [--apply] [--revert] [--force]"
    );
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", CLEVER_FLOW_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`"${CLEVER_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  const next = JSON.parse(JSON.stringify(row.definition)) as AnyDef;
  const { changed, problems } = patchSellerVoicemails(next, REVERT ? "revert" : "apply", FORCE);
  if (problems.length > 0) {
    console.error("\nNothing was written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  console.log(`=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log(REVERT ? "  nothing to revert" : "  already patched, no changes");
    process.exit(0);
  }
  for (const c of changed) console.log(`  - ${c}`);
  if (!REVERT) {
    for (const entry of SELLER_VOICEMAILS) {
      console.log(`\n  ${entry.stepId} (${entry.voicemail.length}/${VOICEMAIL_MAX} chars):`);
      console.log(`    ${entry.voicemail}`);
    }
  }

  let validated;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (e) {
    console.error(`\nwould not validate after patching: ${String(e)}`);
    process.exit(1);
  }
  console.log(`\n  after: ${summarizeDefinition(validated)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const { data: updated, error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id)
    .eq("business_id", BUSINESS_ID)
    .select("id");
  if (upErr) {
    console.error(`update failed: ${upErr.message}`);
    process.exit(1);
  }
  if ((updated ?? []).length !== 1) {
    console.error(`update matched ${(updated ?? []).length} rows; NOT written.`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-seller-voicemail.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, steps: SELLER_VOICEMAILS.map((v) => v.stepId), reverted: REVERT }
  });
  console.log(
    REVERT
      ? "\nReverted. Clever seller calls leave no voicemail again."
      : "\nDone. A Clever seller who does not pick up now hears who called and why."
  );
}

/* c8 ignore stop */
