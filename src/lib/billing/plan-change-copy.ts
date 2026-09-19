/**
 * Owner-facing plan-change copy helpers.
 *
 * Entitlements (`businesses.tier`) flip immediately. Hardware stays on the
 * current Hostinger box while that box still has prepaid time, and only
 * migrates or resizes at lapse. Confirm, success-banner, and billing-line
 * copy all branch on that story so the UI cannot promise a fresh VPS on
 * every plan change.
 */

import { boxHasPaidTimeLeft, shouldMigrateHardwareForPlanChange } from "@/lib/billing/plan-change-hardware";

type PlanChangeHardwareStory =
  | "same_tier"
  | "keep_until_lapse"
  | "keep_same_hardware"
  | "migrate_now";

type PlanChangeConfirmHardwareKey =
  | "confirmSameTier"
  | "confirmKeepDated"
  | "confirmKeepGeneric"
  | "confirmKeepSameHardware"
  | "confirmMigrate";

export type PlanChangeSuccessBannerKey =
  | "planChangedKeepDated"
  | "planChangedKeepGeneric"
  | "planChangedMigrate";

function planChangeHardwareStory(input: {
  currentTier: "starter" | "standard";
  selectedTier: "starter" | "standard";
  vpsSizePin?: string | null;
  expiresAt?: string | null;
  hasLiveBox?: boolean;
  nowMs?: number;
}): PlanChangeHardwareStory {
  if (input.currentTier === input.selectedTier) return "same_tier";
  const migrate = shouldMigrateHardwareForPlanChange({
    oldTier: input.currentTier,
    newTier: input.selectedTier,
    vpsSizePin: input.vpsSizePin ?? null,
    termAlignment: false,
    expiresAt: input.expiresAt,
    hasLiveBox: input.hasLiveBox,
    nowMs: input.nowMs
  });
  if (migrate) return "migrate_now";
  if (input.hasLiveBox !== false && boxHasPaidTimeLeft(input.expiresAt, input.nowMs)) {
    return "keep_until_lapse";
  }
  return "keep_same_hardware";
}

/** Confirm-sheet key for the hardware paragraph (literal catalog keys). */
function planChangeConfirmHardwareKey(
  input: Parameters<typeof planChangeHardwareStory>[0]
): PlanChangeConfirmHardwareKey {
  const story = planChangeHardwareStory(input);
  if (story === "same_tier") return "confirmSameTier";
  if (story === "migrate_now") return "confirmMigrate";
  if (story === "keep_same_hardware") return "confirmKeepSameHardware";
  return parseablePaidThroughIso(input.expiresAt, input.nowMs)
    ? "confirmKeepDated"
    : "confirmKeepGeneric";
}

function planChangeWarnsStarterWebhooks(
  currentTier: "starter" | "standard",
  selectedTier: "starter" | "standard"
): boolean {
  return selectedTier === "starter" && currentTier !== "starter";
}

/**
 * Standard-only surfaces that flip off the moment `businesses.tier` becomes
 * Starter. Order is the confirm-sheet list: webhooks and API keys first
 * (the KIN gap), then the other server-side plan gates.
 */
export const STARTER_DOWNGRADE_LOSS_IDS = [
  "incoming_webhooks",
  "api_keys",
  "messenger_and_widget",
  "outbound_ai_calls",
  "prospecting",
  "scheduled_outreach",
  "team_chat_and_push",
  "call_intel_and_browser"
] as const;

export type StarterDowngradeLossId = (typeof STARTER_DOWNGRADE_LOSS_IDS)[number];

export const STARTER_DOWNGRADE_LOSS_CATALOG_KEYS = {
  incoming_webhooks: "lossIncomingWebhooks",
  api_keys: "lossApiKeys",
  messenger_and_widget: "lossMessengerAndWidget",
  outbound_ai_calls: "lossOutboundAiCalls",
  prospecting: "lossProspecting",
  scheduled_outreach: "lossScheduledOutreach",
  team_chat_and_push: "lossTeamChatAndPush",
  call_intel_and_browser: "lossCallIntelAndBrowser"
} as const satisfies Record<StarterDowngradeLossId, string>;

function starterDowngradeLossIds(
  currentTier: "starter" | "standard",
  selectedTier: "starter" | "standard"
): readonly StarterDowngradeLossId[] {
  if (!planChangeWarnsStarterWebhooks(currentTier, selectedTier)) return [];
  return STARTER_DOWNGRADE_LOSS_IDS;
}

/**
 * Starter capabilities that continue after a Standard cut. Configs stay;
 * only the Standard-gated surfaces in STARTER_DOWNGRADE_LOSS_IDS stop.
 */
export const STARTER_DOWNGRADE_KEEP_IDS = [
  "inbound_voice_sms",
  "booking_email_chat",
  "knowledge_and_limits",
  "saved_config"
] as const;

export type StarterDowngradeKeepId = (typeof STARTER_DOWNGRADE_KEEP_IDS)[number];

export const STARTER_DOWNGRADE_KEEP_CATALOG_KEYS = {
  inbound_voice_sms: "keepInboundVoiceSms",
  booking_email_chat: "keepBookingEmailChat",
  knowledge_and_limits: "keepKnowledgeAndLimits",
  saved_config: "keepSavedConfig"
} as const satisfies Record<StarterDowngradeKeepId, string>;

function starterDowngradeKeepIds(
  currentTier: "starter" | "standard",
  selectedTier: "starter" | "standard"
): readonly StarterDowngradeKeepId[] {
  if (!planChangeWarnsStarterWebhooks(currentTier, selectedTier)) return [];
  return STARTER_DOWNGRADE_KEEP_IDS;
}

/**
 * Confirm-sheet model: destination, retain vs lose, entitlement timing vs
 * hardware. Hardware copy stays direction-agnostic; Starter-only flags
 * carry the "prepaid box does not keep Standard features" honesty line.
 */
type PlanChangeConfirmPreview = {
  destinationTier: "starter" | "standard";
  showsEntitlementFlipNow: boolean;
  showsStarterFeatureSplit: boolean;
  hardwareKey: PlanChangeConfirmHardwareKey;
  lossIds: readonly StarterDowngradeLossId[];
  keepIds: readonly StarterDowngradeKeepId[];
};

export function planChangeConfirmPreview(input: {
  currentTier: "starter" | "standard";
  selectedTier: "starter" | "standard";
  vpsSizePin?: string | null;
  expiresAt?: string | null;
  hasLiveBox?: boolean;
  nowMs?: number;
}): PlanChangeConfirmPreview {
  const { currentTier, selectedTier } = input;
  return {
    destinationTier: selectedTier,
    showsEntitlementFlipNow: currentTier !== selectedTier,
    showsStarterFeatureSplit: planChangeWarnsStarterWebhooks(currentTier, selectedTier),
    hardwareKey: planChangeConfirmHardwareKey(input),
    lossIds: starterDowngradeLossIds(currentTier, selectedTier),
    keepIds: starterDowngradeKeepIds(currentTier, selectedTier)
  };
}

/** True when a parseable expires_at is still in the future. */
export function parseablePaidThroughIso(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (expiresAt == null || expiresAt === "") return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  if (ms <= nowMs) return null;
  return expiresAt;
}

export function formatPlanChangePaidThroughDate(
  expiresAt: string,
  locale: string = "en"
): string | null {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(ms));
}

/**
 * Success-banner key after Stripe Checkout returns. We do not know from
 * `?planChanged=1` whether the customer changed tier or only period, so
 * this follows prepaid time: keep-dated when we can name the day, keep
 * generic when expiry is unknown, migrate when the box has already lapsed.
 */
export function planChangeSuccessBannerKey(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): PlanChangeSuccessBannerKey {
  if (!boxHasPaidTimeLeft(expiresAt, nowMs)) return "planChangedMigrate";
  return parseablePaidThroughIso(expiresAt, nowMs) ? "planChangedKeepDated" : "planChangedKeepGeneric";
}

export function showServerPrepaidLine(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
  hasLiveBox: boolean = true
): boolean {
  if (!hasLiveBox) return false;
  return boxHasPaidTimeLeft(expiresAt, nowMs);
}

export function entitlementBillingMismatch(
  businessTier: string | null | undefined,
  subscriptionTier: string | null | undefined
): boolean {
  if (!businessTier || !subscriptionTier) return false;
  return businessTier !== subscriptionTier;
}
