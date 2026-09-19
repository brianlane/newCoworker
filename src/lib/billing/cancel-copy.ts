/**
 * Owner-facing cancel confirm copy helpers.
 *
 * Plan-change confirm (#1873) lists Standard-only losses on a Starter cut.
 * Cancel is the whole product stopping: access through grace vs wipe, plus
 * the live coworker capabilities that actually stop. Feature lines come
 * from the same catalog keys as plan-change where they match; cancel-only
 * lines (VPS coworker, lead follow-up, grace keep) live beside them.
 */

import {
  parseablePaidThroughIso,
  STARTER_DOWNGRADE_LOSS_CATALOG_KEYS,
  STARTER_DOWNGRADE_LOSS_IDS,
  type StarterDowngradeLossId
} from "@/lib/billing/plan-change-copy";

export type CancelConfirmMode = "refund" | "period_end" | "immediate";

export const CANCEL_KEEP_IDS = ["saved_data", "reactivate"] as const;
export type CancelKeepId = (typeof CANCEL_KEEP_IDS)[number];

export const CANCEL_KEEP_CATALOG_KEYS = {
  saved_data: "cancelKeepSavedData",
  reactivate: "cancelKeepReactivate"
} as const satisfies Record<CancelKeepId, string>;

export const CANCEL_LOSS_CORE_IDS = [
  "vps_coworker",
  "inbound_voice_sms",
  "booking_email_chat",
  "lead_followup"
] as const;

export type CancelLossCoreId = (typeof CANCEL_LOSS_CORE_IDS)[number];

export type CancelLossId = CancelLossCoreId | StarterDowngradeLossId;

export const CANCEL_LOSS_CORE_CATALOG_KEYS = {
  vps_coworker: "cancelLossVpsCoworker",
  inbound_voice_sms: "keepInboundVoiceSms",
  booking_email_chat: "keepBookingEmailChat",
  lead_followup: "cancelLossLeadFollowup"
} as const satisfies Record<CancelLossCoreId, string>;

export const CANCEL_LOSS_CATALOG_KEYS = {
  ...CANCEL_LOSS_CORE_CATALOG_KEYS,
  ...STARTER_DOWNGRADE_LOSS_CATALOG_KEYS
} as const satisfies Record<CancelLossId, string>;

export function cancelLossIdsForTier(
  tier: "starter" | "standard" | "enterprise" | null | undefined
): readonly CancelLossId[] {
  if (tier === "standard" || tier === "enterprise") {
    return [...CANCEL_LOSS_CORE_IDS, ...STARTER_DOWNGRADE_LOSS_IDS];
  }
  return CANCEL_LOSS_CORE_IDS;
}

export type CancelConfirmHardwareKey =
  | "none"
  | "cliffDated"
  | "cliffGeneric"
  | "periodEndDated";

export type CancelConfirmPreview = {
  mode: CancelConfirmMode;
  keepIds: readonly CancelKeepId[];
  lossIds: readonly CancelLossId[];
  hardwareKey: CancelConfirmHardwareKey;
  showsStandardLosses: boolean;
};

export function cancelConfirmPreview(input: {
  mode: CancelConfirmMode;
  currentTier?: "starter" | "standard" | "enterprise" | null;
  periodEnd?: string | null;
  boxExpiresAt?: string | null;
  hasLiveBox?: boolean;
  nowMs?: number;
}): CancelConfirmPreview {
  const nowMs = input.nowMs ?? Date.now();
  const lossIds = cancelLossIdsForTier(input.currentTier);
  return {
    mode: input.mode,
    keepIds: CANCEL_KEEP_IDS,
    lossIds,
    hardwareKey: cancelHardwareKey(input, nowMs),
    showsStandardLosses: input.currentTier === "standard" || input.currentTier === "enterprise"
  };
}

function cancelHardwareKey(
  input: {
    mode: CancelConfirmMode;
    periodEnd?: string | null;
    boxExpiresAt?: string | null;
    hasLiveBox?: boolean;
  },
  nowMs: number
): CancelConfirmHardwareKey {
  if (input.hasLiveBox === false) return "none";
  if (input.mode === "period_end") {
    return parseablePaidThroughIso(input.boxExpiresAt, nowMs) ? "periodEndDated" : "none";
  }
  const dated = parseablePaidThroughIso(input.boxExpiresAt, nowMs);
  if (dated) return "cliffDated";
  if (input.boxExpiresAt) return "cliffGeneric";
  return "none";
}

/** True when the owner-facing keep/lose summary belongs on this cancel reason. */
export function cancelReasonShowsKeepLose(
  reason: string
): boolean {
  return (
    reason === "user_refund" ||
    reason === "user_period_end" ||
    reason === "payment_failed" ||
    reason === "stripe_external"
  );
}

export function cancelConfirmModeForReason(reason: string): CancelConfirmMode {
  if (reason === "user_period_end") return "period_end";
  if (reason === "user_refund") return "refund";
  return "immediate";
}
