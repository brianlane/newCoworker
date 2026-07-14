/**
 * White-glove intake → tenant configuration (DB half).
 *
 * `applyWhiteGloveIntake` takes a COMPLETED intake and a target business and
 * writes the {@link buildIntakeApplyPlan} output:
 *
 *   1. soul.md / memory.md marker blocks in `business_configs` (replacing a
 *      previous apply's block, never owner edits outside the markers);
 *   2. `businesses.business_hours` when the free text parsed (plus a
 *      profile_md refresh so prompts pick the hours up);
 *   3. the "Lead follow-up" flow — created DISABLED on first apply so the
 *      owner approves the wording, updated in place on re-apply (the flow's
 *      enabled state is preserved);
 *   4. the intake row's business link + `applied_at` / `applied_flow_id`.
 *
 * The caller (admin route) schedules the vault → VPS sync afterwards —
 * `scheduleVaultSync` needs the request scope this module deliberately
 * avoids so it stays unit-testable.
 *
 * Failures throw {@link WhiteGloveApplyError} with a stable `code` the route
 * maps onto HTTP statuses.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness, updateBusinessProfileFields } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { createAiFlow, getAiFlow, listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import {
  BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS,
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS
} from "@/lib/vault/business-config-markdown-limits";
import { buildIntakeApplyPlan, replaceWhiteGloveBlock } from "@/lib/white-glove/apply";
import {
  claimWhiteGloveIntakeForBusiness,
  getWhiteGloveIntake,
  markWhiteGloveIntakeApplied
} from "@/lib/white-glove/intake";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WhiteGloveApplyErrorCode =
  | "intake_not_found"
  | "intake_not_completed"
  | "intake_business_mismatch"
  | "business_not_found"
  | "vault_over_limit";

export class WhiteGloveApplyError extends Error {
  readonly code: WhiteGloveApplyErrorCode;

  constructor(code: WhiteGloveApplyErrorCode, message: string) {
    super(message);
    this.name = "WhiteGloveApplyError";
    this.code = code;
  }
}

export type ApplyWhiteGloveIntakeResult = {
  flowId: string;
  /** false = an earlier apply's flow was updated in place. */
  flowCreated: boolean;
  /** false = the free-text hours didn't parse (they still land in memory.md). */
  businessHoursApplied: boolean;
};

export async function applyWhiteGloveIntake(
  args: { intakeId: string; businessId: string },
  client?: SupabaseClient
): Promise<ApplyWhiteGloveIntakeResult> {
  const db = client ?? (await createSupabaseServiceClient());

  const intake = await getWhiteGloveIntake(args.intakeId, db);
  if (!intake) {
    throw new WhiteGloveApplyError("intake_not_found", "Intake not found.");
  }
  if (intake.status !== "completed" || !intake.answers) {
    throw new WhiteGloveApplyError(
      "intake_not_completed",
      "Only a completed questionnaire can be applied."
    );
  }
  // An intake already tied to a tenant (at create time or by an earlier
  // apply) can never be applied to a DIFFERENT one — that would write one
  // customer's build document into another customer's coworker.
  if (intake.business_id && intake.business_id !== args.businessId) {
    throw new WhiteGloveApplyError(
      "intake_business_mismatch",
      "This intake is tied to a different business."
    );
  }

  const business = await getBusiness(args.businessId, db);
  if (!business) {
    throw new WhiteGloveApplyError("business_not_found", "Business not found.");
  }

  const plan = buildIntakeApplyPlan(intake.answers, {
    businessName: intake.business_name,
    industry: intake.industry
  });

  // Vault blocks (marker-replace) with the cap check BEFORE the claim below,
  // so every typed refusal leaves the intake exactly as it was found — a
  // vault_over_limit must never pin an unlinked intake to a business that
  // received nothing. Loud failure over silent truncation.
  const config = await getBusinessConfig(args.businessId, db);
  const soulMd = replaceWhiteGloveBlock(config?.soul_md ?? "", plan.soulBlock);
  const memoryMd = replaceWhiteGloveBlock(config?.memory_md ?? "", plan.memoryBlock);
  if (soulMd.length > BUSINESS_CONFIG_SOUL_MD_MAX_CHARS) {
    throw new WhiteGloveApplyError(
      "vault_over_limit",
      `Applying would push soul.md over its ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS}-character limit; trim it first.`
    );
  }
  if (memoryMd.length > BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS) {
    throw new WhiteGloveApplyError(
      "vault_over_limit",
      `Applying would push memory.md over its ${BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS}-character limit; trim it first.`
    );
  }

  // Atomically CLAIM the intake for this tenant before writing anything.
  // The read-then-check above is only a fast path — two overlapping applies
  // targeting different tenants would both pass it; the conditional UPDATE
  // (unlinked-or-same-business) makes exactly one of them proceed.
  //
  // Every typed refusal is thrown BEFORE this claim, so a refused apply
  // leaves the intake exactly as it was found. A failure AFTER the claim is
  // a write failure — data may already have landed on this tenant — so the
  // claim deliberately stays in place: re-applying to the SAME business is
  // the idempotent recovery, and the mismatch guard keeps a half-built
  // tenant's intake from ever being re-pointed at a different one.
  const claimed = await claimWhiteGloveIntakeForBusiness(intake.id, args.businessId, db);
  if (!claimed) {
    throw new WhiteGloveApplyError(
      "intake_business_mismatch",
      "This intake was just applied to a different business."
    );
  }

  return performApplyWrites({
    businessId: args.businessId,
    intake,
    plan,
    business,
    soulMd,
    memoryMd,
    db
  });
}

async function performApplyWrites(args: {
  businessId: string;
  intake: NonNullable<Awaited<ReturnType<typeof getWhiteGloveIntake>>>;
  plan: ReturnType<typeof buildIntakeApplyPlan>;
  business: NonNullable<Awaited<ReturnType<typeof getBusiness>>>;
  soulMd: string;
  memoryMd: string;
  db: SupabaseClient;
}): Promise<ApplyWhiteGloveIntakeResult> {
  const { businessId, intake, plan, business, soulMd, memoryMd, db } = args;

  // 1. Vault blocks (cap-checked by the caller before the claim).
  await patchBusinessConfig(businessId, { soul_md: soulMd, memory_md: memoryMd }, db);

  // 2. Business hours (only when the free text parsed) + profile_md refresh
  //    so prompt composition picks the change up. Parsed days are MERGED over
  //    the tenant's existing hours — a dayless intake ("11am to 6pm" →
  //    Mon–Fri) must not silently drop a weekend the owner configured in
  //    Settings. The refresh is best-effort by contract
  //    (refreshBusinessProfileMdAndLog never throws).
  const businessHoursApplied = plan.businessHours !== null;
  if (plan.businessHours) {
    const existingHours = parseBusinessHours(business.business_hours ?? null);
    await updateBusinessProfileFields(
      args.businessId,
      { business_hours: { ...(existingHours ?? {}), ...plan.businessHours } },
      db
    );
    await refreshBusinessProfileMdAndLog(args.businessId, db);
  }

  // 3. The follow-up flow: update the previously installed flow in place
  //    (preserving its enabled state), else create it DISABLED for review.
  //    The stamped applied_flow_id is the primary reference; falling back to
  //    a NAME lookup keeps a retry idempotent when a previous apply created
  //    the flow but died before stamping the intake row — without it, that
  //    retry would install a duplicate flow on the same webhook trigger.
  let existingFlowId: string | null = null;
  if (intake.applied_flow_id) {
    const byRef = await getAiFlow(args.businessId, intake.applied_flow_id, db);
    existingFlowId = byRef?.id ?? null;
  }
  if (!existingFlowId) {
    const flows = await listAiFlows(args.businessId, db);
    existingFlowId = flows.find((f) => f.name === plan.flow.name)?.id ?? null;
  }

  let flowId: string;
  let flowCreated = false;
  if (existingFlowId) {
    const updated = await updateAiFlow(
      {
        businessId: args.businessId,
        id: existingFlowId,
        name: plan.flow.name,
        definition: plan.flow.definition
      },
      db
    );
    flowId = updated.id;
  } else {
    const created = await createAiFlow(
      {
        businessId: args.businessId,
        name: plan.flow.name,
        enabled: false,
        definition: plan.flow.definition
      },
      db
    );
    flowId = created.id;
    flowCreated = true;
  }

  // 4. Stamp the apply on the intake row.
  await markWhiteGloveIntakeApplied(intake.id, { businessId, flowId }, db);

  return { flowId, flowCreated, businessHoursApplied };
}
