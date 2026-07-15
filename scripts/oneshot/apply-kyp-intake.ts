/**
 * apply-kyp-intake.ts — one-shot: apply the completed KYP Ads white-glove
 * intake (851d0a36-be68-414f-9968-e00fa18685bb) to their live tenant
 * (056034a7-e84c-444d-8d15-747eeb1fa899) via `applyWhiteGloveIntake` — the
 * first production use of the intake→tenant pipeline (PR #607).
 *
 * What --apply does, in order:
 *   1. Fix the malformed owner phone ("5188192" from a truncated signup
 *      field) to +15145188192 (James — the number on the intake's team line).
 *   2. Run the apply: white-glove marker blocks into soul/memory, business
 *      hours (11am–6pm → Mon–Fri) merged into the profile, and the
 *      "Lead follow-up (white-glove build)" flow installed DISABLED for
 *      James's wording approval (greeting within seconds, nudges at 2h /
 *      next day, personal-touch flag + Inactive tag after 3 unanswered).
 *   3. Push the vault to the tenant box (syncVaultToVps) — the Next.js
 *      route does this via after(); here we run it inline.
 *   4. Record the run in the applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/apply-kyp-intake.ts          # dry-run summary
 *   npx tsx scripts/oneshot/apply-kyp-intake.ts --apply  # ⚠️ writes tenant config
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const INTAKE_ID = "851d0a36-be68-414f-9968-e00fa18685bb";
const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";
const OWNER_PHONE_E164 = "+15145188192";

const { getBusiness, updateBusinessPhone } = await import("../../src/lib/db/businesses.ts");
const { getWhiteGloveIntake } = await import("../../src/lib/white-glove/intake.ts");
const { buildIntakeApplyPlan } = await import("../../src/lib/white-glove/apply.ts");

const business = await getBusiness(BUSINESS_ID);
if (!business) {
  console.error(`Business ${BUSINESS_ID} not found`);
  process.exit(1);
}
const intake = await getWhiteGloveIntake(INTAKE_ID);
if (!intake || intake.status !== "completed" || !intake.answers) {
  console.error(`Intake ${INTAKE_ID} missing or not completed`);
  process.exit(1);
}

const plan = buildIntakeApplyPlan(intake.answers, {
  businessName: intake.business_name,
  industry: intake.industry
});

console.log("[oneshot] target:", {
  business: business.name,
  status: business.status,
  currentPhone: business.phone,
  intakeCompletedAt: intake.completed_at,
  alreadyAppliedAt: intake.applied_at
});
console.log("[oneshot] plan:", {
  flowName: plan.flow.name,
  flowSteps: plan.flow.definition.steps.length,
  businessHoursParsed: plan.businessHours !== null,
  soulBlockChars: plan.soulBlock.length,
  memoryBlockChars: plan.memoryBlock.length,
  phoneFix: `${business.phone ?? "(none)"} -> ${OWNER_PHONE_E164}`
});

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write the tenant config.");
  process.exit(0);
}

// 1. Owner phone fix (truncated at signup; owner alerts + notify_owner SMS
//    depend on it being a real E.164).
await updateBusinessPhone(BUSINESS_ID, OWNER_PHONE_E164);
console.log("[oneshot] owner phone updated");

// 2. The apply itself (same service the admin route calls).
const { applyWhiteGloveIntake } = await import("../../src/lib/white-glove/apply-service.ts");
const result = await applyWhiteGloveIntake({ intakeId: INTAKE_ID, businessId: BUSINESS_ID });
console.log("[oneshot] applied:", result);

// 3. Vault → VPS re-seed (inline; no request scope for after()).
const { syncVaultToVps } = await import("../../src/lib/vps/sync-vault.ts");
const sync = await syncVaultToVps(BUSINESS_ID);
console.log(
  "[oneshot] vault sync:",
  sync.ok
    ? { ok: true, instructionsLength: sync.instructionsLength }
    : { ok: false, reason: sync.reason, detail: sync.detail }
);

// 4. Ledger.
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    intake_id: INTAKE_ID,
    flow_id: result.flowId,
    flow_created: result.flowCreated,
    business_hours_applied: result.businessHoursApplied,
    vault_synced: sync?.ok ?? false
  }
});
console.log(
  "[oneshot] done. Flow is installed DISABLED — enable it from /dashboard/aiflows " +
    "after James approves the wording (go-live checklist)."
);
