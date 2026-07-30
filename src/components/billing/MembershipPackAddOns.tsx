/**
 * Optional recurring usage-pack picker for membership signup / plan-change.
 * Quantity steppers per catalog SKU; term discount applied; packs renew with
 * the membership.
 */

"use client";

import { useTranslations } from "next-intl";
import type { BillingPeriod } from "@/lib/plans/tier";
import { getCommitmentMonths } from "@/lib/plans/tier";
import {
  discountedPackCents,
  MEMBERSHIP_PACK_MAX_QTY,
  membershipPackAddOnsDueTodayCents,
  membershipPackDiscountPercent,
  type MembershipPackAddonCategory,
  type MembershipPackAddonOption,
  type MembershipPackAddonSelection,
  type MembershipPackQty
} from "@/lib/billing/membership-pack-addons";
import { formatPriceCents } from "@/lib/pricing";

export type MembershipPackAddOnsProps = {
  period: BillingPeriod;
  options: MembershipPackAddonOption[];
  selection: MembershipPackAddonSelection;
  onChange: (next: MembershipPackAddonSelection) => void;
};

const CATEGORIES: MembershipPackAddonCategory[] = ["voice", "sms", "chat"];

function categoryTitleKey(category: MembershipPackAddonCategory): string {
  if (category === "voice") return "packCategoryVoice";
  if (category === "sms") return "packCategorySms";
  return "packCategoryChat";
}

function listForCategory(
  selection: MembershipPackAddonSelection,
  category: MembershipPackAddonCategory
): MembershipPackQty[] {
  if (category === "voice") return selection.voicePacks ?? [];
  if (category === "sms") return selection.smsPacks ?? [];
  return selection.chatPacks ?? [];
}

function qtyFor(
  selection: MembershipPackAddonSelection,
  category: MembershipPackAddonCategory,
  packId: string
): number {
  return listForCategory(selection, category).find((p) => p.packId === packId)?.quantity ?? 0;
}

function setQty(
  selection: MembershipPackAddonSelection,
  category: MembershipPackAddonCategory,
  packId: string,
  quantity: number
): MembershipPackAddonSelection {
  const nextList = listForCategory(selection, category).filter((p) => p.packId !== packId);
  if (quantity > 0) nextList.push({ packId, quantity });
  if (category === "voice") return { ...selection, voicePacks: nextList };
  if (category === "sms") return { ...selection, smsPacks: nextList };
  return { ...selection, chatPacks: nextList };
}

export function MembershipPackAddOns({
  period,
  options,
  selection,
  onChange
}: MembershipPackAddOnsProps) {
  const t = useTranslations("marketing.orderSummary");
  const discountPct = membershipPackDiscountPercent(period);
  const months = getCommitmentMonths(period);

  if (options.length === 0) return null;

  return (
    <div className="space-y-3 rounded-lg border border-parchment/15 bg-parchment/5 p-3">
      <div>
        <h4 className="text-sm font-semibold text-parchment">{t("packAddOnsTitle")}</h4>
        <p className="mt-1 text-xs text-parchment/55">
          {t("packAddOnsBody", { percent: discountPct })}
        </p>
        <p className="mt-1 text-xs text-parchment/45">{t("packAddOnsNonRefundable")}</p>
      </div>

      {CATEGORIES.map((category) => {
        const packs = options.filter((o) => o.category === category);
        if (packs.length === 0) return null;
        return (
          <div key={category} className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/50">
              {t(categoryTitleKey(category))}
            </div>
            <div className="space-y-2">
              {packs.map((pack) => {
                const qty = qtyFor(selection, category, pack.id);
                const discountedMonthly = discountedPackCents(pack.listPriceCents, period);
                const periodUnit = discountedMonthly * months;
                return (
                  <div
                    key={pack.id}
                    className={[
                      "flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2",
                      qty > 0
                        ? "border-signal-teal/60 bg-signal-teal/10"
                        : "border-parchment/15 bg-deep-ink/40"
                    ].join(" ")}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-parchment">{pack.label}</div>
                      <div className="mt-1 flex items-center gap-2 font-mono text-xs text-parchment/80">
                        <span className="text-parchment/35 line-through">
                          {formatPriceCents(pack.listPriceCents * months)}
                        </span>
                        <span>{formatPriceCents(periodUnit)}</span>
                        <span className="text-[10px] text-claw-green">
                          {t("packSavePercent", { percent: discountPct })}
                        </span>
                      </div>
                      {months > 1 ? (
                        <div className="mt-0.5 text-[10px] text-parchment/45">
                          {t("packPerPeriodNote", {
                            monthly: formatPriceCents(discountedMonthly),
                            months
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={t("packQtyDecrease", { label: pack.label })}
                        disabled={qty <= 0}
                        onClick={() => onChange(setQty(selection, category, pack.id, qty - 1))}
                        className="h-8 w-8 rounded border border-parchment/20 text-parchment disabled:opacity-30"
                      >
                        −
                      </button>
                      <span className="w-6 text-center font-mono text-sm text-parchment">{qty}</span>
                      <button
                        type="button"
                        aria-label={t("packQtyIncrease", { label: pack.label })}
                        disabled={qty >= MEMBERSHIP_PACK_MAX_QTY}
                        onClick={() => onChange(setQty(selection, category, pack.id, qty + 1))}
                        className="h-8 w-8 rounded border border-parchment/20 text-parchment disabled:opacity-30"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { membershipPackAddOnsDueTodayCents };
