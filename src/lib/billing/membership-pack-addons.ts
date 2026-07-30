/**
 * Membership Checkout usage-pack add-ons.
 *
 * At signup and plan-change, the customer may optionally buy one voice, one
 * SMS, and/or one chat credit pack as one-time lines on the membership
 * Checkout Session. Prices are the standalone catalog list prices discounted
 * by the selected billing period (buying with the membership, not later from
 * Dashboard → Billing):
 *
 *   monthly  → 5%
 *   annual   → 10%
 *   biennial → 20%
 *
 * Discounts are baked into `price_data.unit_amount` so they do not consume
 * Stripe's one-discount-per-session slot (intro coupon / promo codes).
 * Standalone Billing top-ups keep the full catalog price.
 */

import type { BillingPeriod } from "@/lib/plans/tier";
import { getVoiceBonusPack, listVoiceBonusPacks } from "@/lib/billing/voice-bonus-packs";
import { getSmsBonusPack, listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { getChatCreditPack, listChatCreditPacks } from "@/lib/billing/chat-credit-packs";

export const MEMBERSHIP_PACK_DISCOUNT_PERCENT: Record<BillingPeriod, number> = {
  monthly: 5,
  annual: 10,
  biennial: 20
};

export type MembershipPackAddonCategory = "voice" | "sms" | "chat";

export type MembershipPackAddonSelection = {
  voicePackId?: string | null;
  smsPackId?: string | null;
  chatPackId?: string | null;
};

export type MembershipPackAddonLine = {
  category: MembershipPackAddonCategory;
  packId: string;
  name: string;
  unitAmountCents: number;
  listPriceCents: number;
  /** Grant payload fields for webhook / orchestrator. */
  voiceSeconds?: number;
  smsTexts?: number;
  creditMicros?: number;
};

export type MembershipPackAddonOption = {
  category: MembershipPackAddonCategory;
  id: string;
  label: string;
  listPriceCents: number;
};

export type ResolveMembershipPackAddonsResult =
  | { ok: true; lines: MembershipPackAddonLine[]; totalCents: number; metadata: Record<string, string> }
  | { ok: false; error: string };

/** Integer cents after the membership-term discount. */
export function discountedPackCents(listCents: number, period: BillingPeriod): number {
  if (!Number.isFinite(listCents) || listCents <= 0) return 0;
  const pct = MEMBERSHIP_PACK_DISCOUNT_PERCENT[period];
  return Math.round((listCents * (100 - pct)) / 100);
}

export function membershipPackDiscountPercent(period: BillingPeriod): number {
  return MEMBERSHIP_PACK_DISCOUNT_PERCENT[period];
}

/** Env-gated catalog rows for the add-on picker (list prices; client applies discount). */
export function listMembershipPackAddonOptions(): MembershipPackAddonOption[] {
  const out: MembershipPackAddonOption[] = [];
  for (const pack of listVoiceBonusPacks()) {
    out.push({
      category: "voice",
      id: pack.id,
      label: pack.label,
      listPriceCents: pack.priceCents
    });
  }
  for (const pack of listSmsBonusPacks()) {
    out.push({
      category: "sms",
      id: pack.id,
      label: pack.label,
      listPriceCents: pack.priceCents
    });
  }
  for (const pack of listChatCreditPacks()) {
    out.push({
      category: "chat",
      id: pack.id,
      label: pack.label,
      listPriceCents: pack.priceCents
    });
  }
  return out;
}

/**
 * Resolve client-sent pack IDs against the live catalogs. Unknown or
 * unconfigured IDs fail closed. At most one pack per category.
 */
export function resolveMembershipPackAddons(
  selection: MembershipPackAddonSelection,
  period: BillingPeriod
): ResolveMembershipPackAddonsResult {
  const lines: MembershipPackAddonLine[] = [];

  const voiceId = selection.voicePackId?.trim() || null;
  if (voiceId) {
    const pack = getVoiceBonusPack(voiceId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable voice pack: ${voiceId}` };
    }
    const unitAmountCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "voice",
      packId: pack.id,
      name: `Voice top-up: ${pack.label}`,
      unitAmountCents,
      listPriceCents: pack.priceCents,
      voiceSeconds: pack.seconds
    });
  }

  const smsId = selection.smsPackId?.trim() || null;
  if (smsId) {
    const pack = getSmsBonusPack(smsId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable SMS pack: ${smsId}` };
    }
    const unitAmountCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "sms",
      packId: pack.id,
      name: `SMS top-up: ${pack.label}`,
      unitAmountCents,
      listPriceCents: pack.priceCents,
      smsTexts: pack.texts
    });
  }

  const chatId = selection.chatPackId?.trim() || null;
  if (chatId) {
    const pack = getChatCreditPack(chatId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable chat credit pack: ${chatId}` };
    }
    const unitAmountCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "chat",
      packId: pack.id,
      name: `AI chat credit: ${pack.label}`,
      unitAmountCents,
      listPriceCents: pack.priceCents,
      creditMicros: pack.creditMicros
    });
  }

  const metadata: Record<string, string> = {};
  for (const line of lines) {
    if (line.category === "voice" && line.voiceSeconds != null) {
      metadata.addonVoicePackId = line.packId;
      metadata.addonVoiceSeconds = String(line.voiceSeconds);
      metadata.addonVoiceCents = String(line.unitAmountCents);
    } else if (line.category === "sms" && line.smsTexts != null) {
      metadata.addonSmsPackId = line.packId;
      metadata.addonSmsTexts = String(line.smsTexts);
      metadata.addonSmsCents = String(line.unitAmountCents);
    } else if (line.category === "chat" && line.creditMicros != null) {
      metadata.addonChatPackId = line.packId;
      metadata.addonChatMicros = String(line.creditMicros);
      metadata.addonChatCents = String(line.unitAmountCents);
    }
  }

  return {
    ok: true,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.unitAmountCents, 0),
    metadata
  };
}

/** True when Checkout Session metadata carries any membership pack add-on. */
export function sessionHasMembershipPackAddons(
  metadata: Record<string, string> | null | undefined
): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.addonVoicePackId || metadata.addonSmsPackId || metadata.addonChatPackId
  );
}
