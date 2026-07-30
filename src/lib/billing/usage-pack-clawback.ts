/**
 * Admin/manual usage-pack grant clawback.
 *
 * Customer Stripe refunds and disputes do NOT automatically void pack grants
 * (packs are non-refundable from the user side). Operators call this helper
 * (via POST /api/admin/usage-pack-clawback) when intentionally refunding a
 * pack and needing to remove the matching grant.
 *
 * `sourceId` is the grant's `stripe_checkout_session_id` column value:
 *   - Standalone Billing top-up: real Checkout Session id (`cs_...`)
 *   - Membership recurring pack: `inv_{invoiceId}:{voice|sms|chat}:{packId}`
 */

import { logger } from "@/lib/logger";

export type UsagePackClawbackKind = "voice" | "sms" | "chat";

export type ClawbackUsagePackGrantParams = {
  sourceId: string;
  kind: UsagePackClawbackKind;
  reason: "refund" | "dispute" | "admin";
  /**
   * Partial clawback amount (seconds / texts / micros). `null` = full void.
   * Omit or null for a full void (typical admin manual refund).
   */
  clawbackAmount?: number | null;
};

export type ClawbackUsagePackGrantResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Prorate a standalone pack grant for a partial charge refund.
 * Returns null (full void) when inputs are missing or a full refund;
 * returns 0 when nothing should be clawed back; otherwise a positive amount.
 */
export function computeUsagePackClawbackAmount(
  originalAmountCents: number | null,
  refundedAmountCents: number | null,
  purchased: number | null
): number | null {
  if (purchased == null || purchased <= 0) return null;
  if (
    originalAmountCents == null ||
    originalAmountCents <= 0 ||
    refundedAmountCents == null ||
    refundedAmountCents <= 0
  ) {
    return null;
  }
  if (refundedAmountCents >= originalAmountCents) return null;
  const clawback = Math.round((purchased * refundedAmountCents) / originalAmountCents);
  if (clawback <= 0) return 0;
  if (clawback >= purchased) return null;
  return clawback;
}

export async function clawbackUsagePackGrantBySourceId(
  params: ClawbackUsagePackGrantParams
): Promise<ClawbackUsagePackGrantResult> {
  const sourceId = params.sourceId.trim();
  if (!sourceId) return { ok: false, error: "sourceId is required" };

  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();

  const rpcName =
    params.kind === "voice"
      ? "void_voice_bonus_grant_by_checkout_session"
      : params.kind === "sms"
        ? "void_sms_bonus_grant_by_checkout_session"
        : "void_chat_credit_grant_by_checkout_session";
  const clawbackParam =
    params.kind === "voice"
      ? "p_clawback_seconds"
      : params.kind === "sms"
        ? "p_clawback_texts"
        : "p_clawback_micros";

  const clawback =
    params.clawbackAmount === undefined ? null : params.clawbackAmount;

  const { data, error } = await db.rpc(rpcName, {
    p_checkout_session_id: sourceId,
    p_reason: params.reason,
    [clawbackParam]: clawback
  });

  if (error) {
    logger.error("usage pack clawback failed", {
      sourceId,
      kind: params.kind,
      reason: params.reason,
      error: error.message
    });
    return { ok: false, error: error.message };
  }

  logger.info("Usage pack grant voided (admin/manual)", {
    sourceId,
    kind: params.kind,
    reason: params.reason,
    clawback,
    result: data
  });
  return { ok: true, result: data };
}
