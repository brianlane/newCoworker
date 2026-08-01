/**
 * Membership Checkout usage-pack add-ons (recurring).
 *
 * At signup and plan-change, the customer may optionally add voice, SMS,
 * and/or chat credit packs as recurring subscription items. Prices are the
 * standalone catalog list prices discounted by the selected billing period:
 *
 *   monthly  → 5%
 *   annual   → 10%
 *   biennial → 20%
 *
 * Discounts are baked into `price_data.unit_amount` so they do not consume
 * Stripe's one-discount-per-session slot (intro coupon / promo codes).
 * Standalone Billing top-ups keep the full catalog price and stay one-time.
 *
 * Quantity is per catalog SKU (1..20). Multiple SKUs in the same category
 * are allowed. Term plans bill `discountedMonthly × months` per unit with
 * matching `interval_count`, same as the Canada messaging fee.
 */

import type { BillingPeriod } from "@/lib/plans/tier";
import { getCommitmentMonths } from "@/lib/plans/tier";
import { HARD_MAX_PACK_UNIT } from "@/lib/billing/usage-pack-metadata";
import { getVoiceBonusPack, listVoiceBonusPacks } from "@/lib/billing/voice-bonus-packs";
import { getSmsBonusPack, listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { getChatCreditPack, listChatCreditPacks } from "@/lib/billing/chat-credit-packs";

export const MEMBERSHIP_PACK_DISCOUNT_PERCENT: Record<BillingPeriod, number> = {
  monthly: 5,
  annual: 10,
  biennial: 20
};

export const MEMBERSHIP_PACK_MAX_QTY = 20;

export type MembershipPackAddonCategory = "voice" | "sms" | "chat";

export type MembershipPackQty = {
  packId: string;
  quantity: number;
};

export type MembershipPackAddonSelection = {
  voicePacks?: MembershipPackQty[] | null;
  smsPacks?: MembershipPackQty[] | null;
  chatPacks?: MembershipPackQty[] | null;
};

export type MembershipPackAddonLine = {
  category: MembershipPackAddonCategory;
  packId: string;
  quantity: number;
  name: string;
  /** Stripe `price_data.unit_amount` = discounted monthly × commitment months. */
  unitAmountCents: number;
  discountedMonthlyCents: number;
  listPriceCents: number;
  /** Per-pack unit grant size (before qty × months). */
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

/** Decoded pack row from subscription / session metadata. */
export type MembershipPackAddonMetaEntry = {
  packId: string;
  quantity: number;
  unitSize: number;
};

export type ResolveMembershipPackAddonsResult =
  | { ok: true; lines: MembershipPackAddonLine[]; totalCents: number; metadata: Record<string, string> }
  | { ok: false; error: string };

/** Integer cents after the membership-term discount (monthly catalog list). */
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

function collapseQtyList(
  items: MembershipPackQty[] | null | undefined
): Map<string, number> | { error: string } {
  const map = new Map<string, number>();
  if (!items?.length) return map;
  for (const item of items) {
    const packId = typeof item.packId === "string" ? item.packId.trim() : "";
    if (!packId) return { error: "Pack id is required" };
    const qty = item.quantity;
    if (!Number.isInteger(qty) || qty < 1 || qty > MEMBERSHIP_PACK_MAX_QTY) {
      return {
        error: `Pack quantity must be an integer from 1 to ${MEMBERSHIP_PACK_MAX_QTY}`
      };
    }
    map.set(packId, (map.get(packId) ?? 0) + qty);
  }
  for (const [packId, qty] of map) {
    if (qty > MEMBERSHIP_PACK_MAX_QTY) {
      return {
        error: `Pack quantity for ${packId} exceeds max ${MEMBERSHIP_PACK_MAX_QTY}`
      };
    }
  }
  return map;
}

/**
 * Compact metadata: `packId:qty:unitSize,packId:qty:unitSize`
 * (unitSize = per-pack seconds / texts / micros before qty × months).
 */
export function encodeMembershipPackMeta(
  entries: ReadonlyArray<MembershipPackAddonMetaEntry>
): string {
  return entries
    .map((e) => `${e.packId}:${e.quantity}:${e.unitSize}`)
    .join(",");
}

export function decodeMembershipPackMeta(
  raw: string | null | undefined,
  /**
   * Per-unit ceiling for this key's kind (HARD_MAX_PACK_UNIT). Same
   * fail-closed posture as the standalone top-up parsers: an oversized entry
   * is DROPPED, not clamped, because quantity (<=20) and commitment months
   * (<=24) then multiply whatever passes here.
   */
  maxUnitSize: number = Number.MAX_SAFE_INTEGER
): MembershipPackAddonMetaEntry[] {
  if (!raw?.trim()) return [];
  const out: MembershipPackAddonMetaEntry[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const bits = trimmed.split(":");
    if (bits.length !== 3) continue;
    const packId = bits[0]?.trim();
    const quantity = Number(bits[1]);
    const unitSize = Number(bits[2]);
    if (!packId) continue;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MEMBERSHIP_PACK_MAX_QTY) {
      continue;
    }
    if (!Number.isInteger(unitSize) || unitSize <= 0 || unitSize > maxUnitSize) continue;
    out.push({ packId, quantity, unitSize });
  }
  return out;
}

export function grantAmountForPeriod(
  unitSize: number,
  quantity: number,
  period: BillingPeriod
): number {
  const months = getCommitmentMonths(period);
  return unitSize * quantity * months;
}

/**
 * Resolve client-sent pack quantities against the live catalogs. Unknown or
 * unconfigured IDs fail closed. Duplicate SKUs are collapsed by summing qty.
 */
export function resolveMembershipPackAddons(
  selection: MembershipPackAddonSelection,
  period: BillingPeriod
): ResolveMembershipPackAddonsResult {
  const months = getCommitmentMonths(period);
  const lines: MembershipPackAddonLine[] = [];

  const voiceMap = collapseQtyList(selection.voicePacks ?? undefined);
  if ("error" in voiceMap) return { ok: false, error: voiceMap.error };
  for (const [packId, quantity] of voiceMap) {
    const pack = getVoiceBonusPack(packId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable voice pack: ${packId}` };
    }
    const discountedMonthlyCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "voice",
      packId: pack.id,
      quantity,
      name: `Voice top-up: ${pack.label}`,
      unitAmountCents: discountedMonthlyCents * months,
      discountedMonthlyCents,
      listPriceCents: pack.priceCents,
      voiceSeconds: pack.seconds
    });
  }

  const smsMap = collapseQtyList(selection.smsPacks ?? undefined);
  if ("error" in smsMap) return { ok: false, error: smsMap.error };
  for (const [packId, quantity] of smsMap) {
    const pack = getSmsBonusPack(packId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable SMS pack: ${packId}` };
    }
    const discountedMonthlyCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "sms",
      packId: pack.id,
      quantity,
      name: `SMS top-up: ${pack.label}`,
      unitAmountCents: discountedMonthlyCents * months,
      discountedMonthlyCents,
      listPriceCents: pack.priceCents,
      smsTexts: pack.texts
    });
  }

  const chatMap = collapseQtyList(selection.chatPacks ?? undefined);
  if ("error" in chatMap) return { ok: false, error: chatMap.error };
  for (const [packId, quantity] of chatMap) {
    const pack = getChatCreditPack(packId);
    if (!pack) {
      return { ok: false, error: `Unknown or unavailable chat credit pack: ${packId}` };
    }
    const discountedMonthlyCents = discountedPackCents(pack.priceCents, period);
    lines.push({
      category: "chat",
      packId: pack.id,
      quantity,
      name: `AI chat credit: ${pack.label}`,
      unitAmountCents: discountedMonthlyCents * months,
      discountedMonthlyCents,
      listPriceCents: pack.priceCents,
      creditMicros: pack.creditMicros
    });
  }

  const metadata: Record<string, string> = {};
  const voiceEntries = lines
    .filter((l) => l.category === "voice")
    .map((l) => ({
      packId: l.packId,
      quantity: l.quantity,
      unitSize: l.voiceSeconds as number
    }));
  const smsEntries = lines
    .filter((l) => l.category === "sms")
    .map((l) => ({
      packId: l.packId,
      quantity: l.quantity,
      unitSize: l.smsTexts as number
    }));
  const chatEntries = lines
    .filter((l) => l.category === "chat")
    .map((l) => ({
      packId: l.packId,
      quantity: l.quantity,
      unitSize: l.creditMicros as number
    }));
  if (voiceEntries.length) metadata.addonVoice = encodeMembershipPackMeta(voiceEntries);
  if (smsEntries.length) metadata.addonSms = encodeMembershipPackMeta(smsEntries);
  if (chatEntries.length) metadata.addonChat = encodeMembershipPackMeta(chatEntries);

  return {
    ok: true,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.unitAmountCents * line.quantity, 0),
    metadata
  };
}

/**
 * True when metadata carries recurring membership pack add-ons.
 * Legacy one-time keys (`addonVoicePackId`, etc.) are ignored so renewals
 * never re-grant packs that were billed once under the prior ship.
 */
export function sessionHasMembershipPackAddons(
  metadata: Record<string, string> | null | undefined
): boolean {
  if (!metadata) return false;
  return Boolean(metadata.addonVoice || metadata.addonSms || metadata.addonChat);
}

/** Parse compact recurring pack metadata into grantable entries. */
export function parseMembershipPackAddonMetadata(
  metadata: Record<string, string> | null | undefined
): {
  voice: MembershipPackAddonMetaEntry[];
  sms: MembershipPackAddonMetaEntry[];
  chat: MembershipPackAddonMetaEntry[];
} {
  if (!metadata) return { voice: [], sms: [], chat: [] };

  return {
    voice: decodeMembershipPackMeta(metadata.addonVoice, HARD_MAX_PACK_UNIT.voiceSeconds),
    sms: decodeMembershipPackMeta(metadata.addonSms, HARD_MAX_PACK_UNIT.smsTexts),
    chat: decodeMembershipPackMeta(metadata.addonChat, HARD_MAX_PACK_UNIT.chatMicros)
  };
}

/** Due-today cents for UI: discounted monthly × months × qty per selected line. */
export function membershipPackAddOnsDueTodayCents(
  selection: MembershipPackAddonSelection,
  options: MembershipPackAddonOption[],
  period: BillingPeriod
): number {
  const months = getCommitmentMonths(period);
  let total = 0;
  const add = (items: MembershipPackQty[] | null | undefined, category: MembershipPackAddonCategory) => {
    for (const item of items ?? []) {
      const opt = options.find((o) => o.category === category && o.id === item.packId);
      if (!opt) continue;
      const qty = Number.isInteger(item.quantity) ? item.quantity : 0;
      if (qty < 1) continue;
      total += discountedPackCents(opt.listPriceCents, period) * months * qty;
    }
  };
  add(selection.voicePacks, "voice");
  add(selection.smsPacks, "sms");
  add(selection.chatPacks, "chat");
  return total;
}

/** The metadata keys that carry recurring pack add-ons. Nothing else is mirrored. */
const MEMBERSHIP_PACK_METADATA_KEYS = ["addonVoice", "addonSms", "addonChat"] as const;

/** Shape stored in `subscriptions.membership_pack_addons`. */
export type MembershipPackAddonsRow = Partial<
  Record<(typeof MEMBERSHIP_PACK_METADATA_KEYS)[number], string>
>;

/**
 * Narrow Stripe subscription metadata down to the pack keys for the local
 * mirror.
 *
 * Deliberately stores the SAME encoding Stripe holds rather than a decoded
 * shape: one format to keep in step instead of two, and
 * {@link parseMembershipPackAddonMetadata} reads the column unchanged.
 * Returns null when there are no packs, so "no row yet" and "no packs" look
 * the same to callers, which is what the UI wants.
 */
export function membershipPackAddonsForRow(
  metadata: Record<string, string> | null | undefined
): MembershipPackAddonsRow | null {
  if (!metadata) return null;
  const out: MembershipPackAddonsRow = {};
  for (const key of MEMBERSHIP_PACK_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The mirrored row as a change-plan selector selection, so switching billing
 * period starts from what the tenant already has instead of from nothing.
 *
 * Tolerant of junk: the column is a read cache, and a malformed value must
 * degrade to "no packs" rather than break the billing page.
 */
export function membershipPackSelectionFromRow(
  stored: unknown
): Required<MembershipPackAddonSelection> {
  const empty = { voicePacks: [], smsPacks: [], chatPacks: [] };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return empty;

  const parsed = parseMembershipPackAddonMetadata(stored as Record<string, string>);
  const toQty = (entries: MembershipPackAddonMetaEntry[]): MembershipPackQty[] =>
    entries.map((e) => ({ packId: e.packId, quantity: e.quantity }));
  return {
    voicePacks: toQty(parsed.voice),
    smsPacks: toQty(parsed.sms),
    chatPacks: toQty(parsed.chat)
  };
}
