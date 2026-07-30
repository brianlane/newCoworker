/**
 * Optional usage-pack picker for membership signup / plan-change Checkout.
 * Shows catalog list prices with the term discount applied. Selection is
 * at most one pack per category (voice, SMS, chat).
 */

"use client";

import { useTranslations } from "next-intl";
import type { BillingPeriod } from "@/lib/plans/tier";
import {
  discountedPackCents,
  membershipPackDiscountPercent,
  type MembershipPackAddonCategory,
  type MembershipPackAddonOption,
  type MembershipPackAddonSelection
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

export function MembershipPackAddOns({
  period,
  options,
  selection,
  onChange
}: MembershipPackAddOnsProps) {
  const t = useTranslations("marketing.orderSummary");
  const discountPct = membershipPackDiscountPercent(period);

  if (options.length === 0) return null;

  const selectedId = (category: MembershipPackAddonCategory): string | null => {
    if (category === "voice") return selection.voicePackId ?? null;
    if (category === "sms") return selection.smsPackId ?? null;
    return selection.chatPackId ?? null;
  };

  function setSelected(category: MembershipPackAddonCategory, packId: string | null) {
    if (category === "voice") {
      onChange({ ...selection, voicePackId: packId });
      return;
    }
    if (category === "sms") {
      onChange({ ...selection, smsPackId: packId });
      return;
    }
    onChange({ ...selection, chatPackId: packId });
  }

  return (
    <div className="space-y-3 rounded-lg border border-parchment/15 bg-parchment/5 p-3">
      <div>
        <h4 className="text-sm font-semibold text-parchment">{t("packAddOnsTitle")}</h4>
        <p className="mt-1 text-xs text-parchment/55">
          {t("packAddOnsBody", { percent: discountPct })}
        </p>
      </div>

      {CATEGORIES.map((category) => {
        const packs = options.filter((o) => o.category === category);
        if (packs.length === 0) return null;
        const current = selectedId(category);
        return (
          <div key={category} className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-parchment/50">
              {t(categoryTitleKey(category))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => setSelected(category, null)}
                className={[
                  "rounded-md border px-2 py-2 text-left text-xs transition-colors",
                  current === null
                    ? "border-signal-teal/60 bg-signal-teal/10 text-parchment"
                    : "border-parchment/15 bg-deep-ink/40 text-parchment/70 hover:border-parchment/30"
                ].join(" ")}
              >
                {t("packNone")}
              </button>
              {packs.map((pack) => {
                const discounted = discountedPackCents(pack.listPriceCents, period);
                const selected = current === pack.id;
                return (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => setSelected(category, pack.id)}
                    className={[
                      "rounded-md border px-2 py-2 text-left text-xs transition-colors",
                      selected
                        ? "border-signal-teal/60 bg-signal-teal/10 text-parchment"
                        : "border-parchment/15 bg-deep-ink/40 text-parchment/70 hover:border-parchment/30"
                    ].join(" ")}
                  >
                    <div className="font-semibold text-parchment">{pack.label}</div>
                    <div className="mt-1 flex items-center gap-2 font-mono">
                      <span className="text-parchment/35 line-through">
                        {formatPriceCents(pack.listPriceCents)}
                      </span>
                      <span>{formatPriceCents(discounted)}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-claw-green">
                      {t("packSavePercent", { percent: discountPct })}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Sum of discounted selected pack prices for due-today. */
export function membershipPackAddOnsDueTodayCents(
  selection: MembershipPackAddonSelection,
  options: MembershipPackAddonOption[],
  period: BillingPeriod
): number {
  let total = 0;
  const voice = selection.voicePackId
    ? options.find((o) => o.category === "voice" && o.id === selection.voicePackId)
    : null;
  const sms = selection.smsPackId
    ? options.find((o) => o.category === "sms" && o.id === selection.smsPackId)
    : null;
  const chat = selection.chatPackId
    ? options.find((o) => o.category === "chat" && o.id === selection.chatPackId)
    : null;
  if (voice) total += discountedPackCents(voice.listPriceCents, period);
  if (sms) total += discountedPackCents(sms.listPriceCents, period);
  if (chat) total += discountedPackCents(chat.listPriceCents, period);
  return total;
}
