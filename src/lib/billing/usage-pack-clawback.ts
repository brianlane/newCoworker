/**
 * Usage-pack grant clawback.
 *
 * Customer Stripe refunds and disputes without New Coworker refund metadata
 * do NOT automatically void pack grants (packs are non-refundable from the
 * user side). New Coworker-issued refunds (lifecycle money-back / admin
 * force-refund, stamped with `metadata.newcoworker_reason`) claw back
 * membership invoice grants. Operators can also call this helper via
 * POST /api/admin/usage-pack-clawback for Dashboard-only pack refunds.
 *
 * `sourceId` is the grant's `stripe_checkout_session_id` column value:
 *   - Standalone Billing top-up: real Checkout Session id (`cs_...`)
 *   - Membership recurring pack: `inv_{invoiceId}:{voice|sms|chat}:{packId}`
 */

import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import { parseMembershipPackAddonMetadata } from "@/lib/billing/membership-pack-addons";

export type UsagePackClawbackKind = "voice" | "sms" | "chat";

/** Refund metadata values stamped by lifecycle `refund_latest_charge`. */
export const NEWCOWORKER_PACK_CLAWBACK_REASONS = new Set([
  "thirty_day_money_back",
  "admin_force"
]);

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

export function membershipPackGrantSourceId(
  invoiceId: string,
  kind: UsagePackClawbackKind,
  packId: string
): string {
  return `inv_${invoiceId}:${kind}:${packId}`;
}

export function clawbackReasonForNewcoworkerRefund(
  newcoworkerReason: string | undefined | null
): "refund" | "admin" | null {
  if (newcoworkerReason === "thirty_day_money_back") return "refund";
  if (newcoworkerReason === "admin_force") return "admin";
  return null;
}

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
  if (originalAmountCents == null || originalAmountCents <= 0 || refundedAmountCents == null) {
    return null;
  }
  // Nothing refunded means nothing to claw: return the explicit no-op, NOT
  // null, because null is the FULL-VOID sentinel at the RPC and a malformed
  // zero-refund event would otherwise void the entire grant (the sibling
  // computeVoiceBonusClawbackSeconds already returns 0 here).
  if (refundedAmountCents <= 0) return 0;
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

  const rpc =
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

  const { data, error } = await db.rpc(rpc, {
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

  logger.info("Usage pack grant voided", {
    sourceId,
    kind: params.kind,
    reason: params.reason,
    clawback,
    result: data
  });
  return { ok: true, result: data };
}

function kindFromMembershipSourceId(
  invoiceId: string,
  sourceId: string
): UsagePackClawbackKind | null {
  const prefix = `inv_${invoiceId}:`;
  if (!sourceId.startsWith(prefix)) return null;
  const rest = sourceId.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep);
  if (kind === "voice" || kind === "sms" || kind === "chat") return kind;
  return null;
}

async function listOpenMembershipGrantSourceIds(
  invoiceId: string
): Promise<Array<{ sourceId: string; kind: UsagePackClawbackKind }>> {
  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  if (typeof (db as { from?: unknown }).from !== "function") {
    return [];
  }
  const prefix = `inv_${invoiceId}:%`;
  const tables: Array<{ table: string; kind: UsagePackClawbackKind }> = [
    { table: "voice_bonus_grants", kind: "voice" },
    { table: "sms_bonus_grants", kind: "sms" },
    // NOT "chat_credit_grants": that table does not exist, and the error
    // branch below swallows a bad name as an empty list (which silently
    // left chat grants alive on mixed-pack refunds until Aug 2026).
    { table: "chat_spend_credit_grants", kind: "chat" }
  ];
  const out: Array<{ sourceId: string; kind: UsagePackClawbackKind }> = [];
  for (const { table, kind } of tables) {
    try {
      const { data, error } = await db
        .from(table)
        .select("stripe_checkout_session_id")
        .like("stripe_checkout_session_id", prefix)
        .is("voided_at", null);
      if (error) {
        logger.warn("usage pack clawback: grant list failed", {
          table,
          invoiceId,
          error: error.message
        });
        continue;
      }
      for (const row of data ?? []) {
        const sourceId =
          typeof row.stripe_checkout_session_id === "string"
            ? row.stripe_checkout_session_id.trim()
            : "";
        if (!sourceId) continue;
        out.push({ sourceId, kind });
      }
    } catch (err) {
      logger.warn("usage pack clawback: grant list threw", {
        table,
        invoiceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return out;
}

/**
 * Void membership pack grants for a paid invoice after a New Coworker refund.
 * Pack line cents on the invoice are refunded with the charge; this removes
 * the matching credits. Idempotent via the void RPCs.
 */
export async function clawbackMembershipPackGrantsForInvoice(params: {
  invoiceId: string;
  reason: "refund" | "admin";
  /** Optional Stripe subscription metadata to resolve pack SKUs if DB list is empty. */
  subscriptionMetadata?: Stripe.Metadata | null;
}): Promise<{ attempted: number; failed: number }> {
  const invoiceId = params.invoiceId.trim();
  if (!invoiceId) return { attempted: 0, failed: 0 };

  const fromDb = await listOpenMembershipGrantSourceIds(invoiceId);
  const targets = new Map<string, UsagePackClawbackKind>();
  for (const row of fromDb) {
    targets.set(row.sourceId, row.kind);
  }

  if (targets.size === 0 && params.subscriptionMetadata) {
    const parsed = parseMembershipPackAddonMetadata(params.subscriptionMetadata);
    for (const e of parsed.voice) {
      targets.set(membershipPackGrantSourceId(invoiceId, "voice", e.packId), "voice");
    }
    for (const e of parsed.sms) {
      targets.set(membershipPackGrantSourceId(invoiceId, "sms", e.packId), "sms");
    }
    for (const e of parsed.chat) {
      targets.set(membershipPackGrantSourceId(invoiceId, "chat", e.packId), "chat");
    }
  }

  let failed = 0;
  for (const [sourceId, kind] of targets) {
    const resolved = kindFromMembershipSourceId(invoiceId, sourceId) ?? kind;
    const result = await clawbackUsagePackGrantBySourceId({
      sourceId,
      kind: resolved,
      reason: params.reason
    });
    if (!result.ok) failed += 1;
  }

  if (targets.size > 0) {
    logger.info("membership pack grants clawed back for invoice", {
      invoiceId,
      reason: params.reason,
      attempted: targets.size,
      failed
    });
  }

  return { attempted: targets.size, failed };
}
