"use client";

/**
 * Auto-reload settings, one section per pack family.
 *
 * Modelled on the two products that already do this to us: Telnyx
 * (toggle + threshold + recharge amount + Save) and Google AI Studio (preset
 * reload amounts + "when credit balance falls below" + optional monthly cap).
 *
 * Reload amounts are preset buttons rather than a free number field, because a
 * pack is an env-gated Stripe Price and an arbitrary amount is not
 * purchasable. The toggle reverts on a failed save: this card decides whether
 * real money moves unattended, so it must never show a state the server did
 * not accept.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export type AutoReloadCategory = "voice" | "sms" | "chat";

export type AutoReloadPackOption = {
  id: string;
  label: string;
  priceUsd: number;
  /** Grant size in canonical units (seconds / texts / micros). */
  grantUnits: number;
};

export type AutoReloadCategoryView = {
  category: AutoReloadCategory;
  enabled: boolean;
  packId: string | null;
  /** Canonical units; the UI converts for display. */
  thresholdUnits: number | null;
  monthlyLimitCents: number | null;
  packs: AutoReloadPackOption[];
  /** Current remaining capacity in canonical units, for the "you have X" line. */
  currentUnits: number | null;
  /** Hard block: no subscription, uncapped SMS plan, or no configured packs. */
  unavailableReason: "no_subscription" | "uncapped_sms" | "no_packs" | null;
  pausedReason: string | null;
  disabledReason: string | null;
};

export type AutoReloadEventView = {
  id: number;
  category: AutoReloadCategory;
  createdAt: string;
  status: string;
  amountCents: number;
  packLabel: string;
  failureMessage: string | null;
};

export type AutoReloadCardView = {
  brand: string | null;
  last4: string | null;
} | null;

type Props = {
  categories: AutoReloadCategoryView[];
  recentEvents: AutoReloadEventView[];
  card: AutoReloadCardView;
  /** True when the subscription already carries recurring pack add-ons. */
  hasRecurringPacks: boolean;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** Canonical units to the number the tenant reads. */
function toDisplay(category: AutoReloadCategory, units: number): number {
  if (category === "voice") return Math.round(units / 60);
  if (category === "chat") return Math.round(units / 1_000_000);
  return units;
}

function fromDisplay(category: AutoReloadCategory, display: number): number {
  if (category === "voice") return Math.round(display * 60);
  if (category === "chat") return Math.round(display * 1_000_000);
  return Math.round(display);
}

function formatBalance(category: AutoReloadCategory, units: number, unitWord: string): string {
  return `${toDisplay(category, units).toLocaleString("en-US")} ${unitWord}`;
}

export function AutoReloadSettings({
  categories,
  recentEvents,
  card,
  hasRecurringPacks
}: Props) {
  const t = useTranslations("dashboard.billing.autoReload");

  return (
    <Card>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-parchment">{t("title")}</h2>
        <p className="text-sm text-parchment/60">{t("blurb")}</p>
        {hasRecurringPacks && (
          <p className="text-xs text-parchment/50">{t("recurringNote")}</p>
        )}
      </div>

      <div className="mt-6 space-y-6">
        {categories.map((view) => (
          <CategorySection key={view.category} view={view} />
        ))}
      </div>

      <div className="mt-6 pt-6 border-t border-parchment/10 space-y-2">
        {card?.last4 ? (
          <p className="text-xs text-parchment/60">
            {t("cardOnFile", { brand: card.brand ?? "card", last4: card.last4 })}
          </p>
        ) : null}
        <form action="/api/billing/portal" method="POST">
          <button type="submit" className="text-xs underline text-parchment/60">
            {t("updateCard")}
          </button>
        </form>
      </div>

      <div className="mt-6 pt-6 border-t border-parchment/10">
        <h3 className="text-sm font-semibold text-parchment">{t("historyTitle")}</h3>
        {recentEvents.length === 0 ? (
          <p className="mt-2 text-xs text-parchment/50">{t("historyEmpty")}</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {recentEvents.map((e) => (
              <li key={e.id} className="text-xs text-parchment/60 flex justify-between gap-3">
                <span>
                  {new Date(e.createdAt).toLocaleDateString("en-US")} {e.packLabel}
                </span>
                <span>
                  {currency.format(e.amountCents / 100)} {statusLabel(t, e.status)}
                  {e.failureMessage ? ` (${e.failureMessage})` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function statusLabel(t: ReturnType<typeof useTranslations>, status: string): string {
  const map: Record<string, string> = {
    succeeded: "statusSucceeded",
    failed: "statusFailed",
    requires_action: "statusRequiresAction",
    skipped_monthly_limit: "statusSkippedMonthlyLimit",
    skipped_pack_unavailable: "statusSkippedPackUnavailable",
    skipped_no_card: "statusSkippedNoCard",
    pending: "statusPending"
  };
  const key = map[status];
  return key ? t(key) : status;
}

function CategorySection({ view }: { view: AutoReloadCategoryView }) {
  const t = useTranslations("dashboard.billing.autoReload");
  const [enabled, setEnabled] = useState(view.enabled);
  const [packId, setPackId] = useState(view.packId ?? view.packs[0]?.id ?? "");
  const [threshold, setThreshold] = useState(
    view.thresholdUnits === null ? "" : String(toDisplay(view.category, view.thresholdUnits))
  );
  const [monthlyLimit, setMonthlyLimit] = useState(
    view.monthlyLimitCents === null ? "" : String(view.monthlyLimitCents / 100)
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const unitWord =
    view.category === "voice"
      ? t("unitMinutes")
      : view.category === "sms"
        ? t("unitTexts")
        : t("unitDollars");

  const label =
    view.category === "voice"
      ? t("voiceLabel")
      : view.category === "sms"
        ? t("smsLabel")
        : t("chatLabel");

  if (view.unavailableReason) {
    const reason =
      view.unavailableReason === "no_subscription"
        ? t("unavailableNoSubscription")
        : view.unavailableReason === "uncapped_sms"
          ? t("unavailableUncappedSms")
          : t("unavailableNoPacks");
    return (
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-parchment">{label}</h3>
        <p className="text-xs text-parchment/50">{reason}</p>
      </section>
    );
  }

  async function save(nextEnabled: boolean) {
    const previous = enabled;
    setEnabled(nextEnabled);
    setBusy(true);
    setStatus(t("saving"));
    try {
      const res = await fetch("/api/billing/auto-reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: view.category,
          enabled: nextEnabled,
          packId,
          thresholdUnits: fromDisplay(view.category, Number(threshold)),
          monthlyLimitCents: monthlyLimit === "" ? null : Math.round(Number(monthlyLimit) * 100)
        })
      });
      const body = (await res.json()) as {
        data?: { needsCard?: boolean; setupUrl?: string | null };
        error?: { message?: string };
      };
      if (!res.ok) {
        // Never leave the toggle claiming a state the server refused: this
        // card decides whether money moves without the tenant present.
        setEnabled(previous);
        setStatus(body.error?.message ?? t("saveFailed"));
        return;
      }
      if (body.data?.needsCard && body.data.setupUrl) {
        window.location.assign(body.data.setupUrl);
        return;
      }
      setStatus(t("saved"));
    } catch {
      setEnabled(previous);
      setStatus(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 pt-4 first:pt-0 border-t border-parchment/10 first:border-t-0">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold text-parchment">{label}</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={label}
          disabled={busy}
          onClick={() => void save(!enabled)}
          className={[
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-claw-green" : "bg-parchment/20",
            busy ? "opacity-50 cursor-wait" : ""
          ].join(" ")}
        >
          <span
            className={[
              "inline-block h-4 w-4 rounded-full bg-deep-ink transition-transform",
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            ].join(" ")}
          />
        </button>
      </div>

      {view.currentUnits !== null && (
        <p className="text-xs text-parchment/50">
          {t("currentBalance", {
            balance: formatBalance(view.category, view.currentUnits, unitWord)
          })}
        </p>
      )}
      {view.category === "sms" && (
        <p className="text-xs text-parchment/40">{t("smsWindowNote")}</p>
      )}

      {view.pausedReason === "authentication_required" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("pausedAuthenticationRequired")}
        </p>
      )}
      {view.pausedReason === "monthly_limit_reached" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("pausedMonthlyLimit")}
        </p>
      )}
      {view.disabledReason === "payment_failures" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("disabledPaymentFailures")}
        </p>
      )}
      {view.disabledReason === "dispute" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("disabledDispute")}
        </p>
      )}
      {view.disabledReason === "card_detached" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("disabledCardDetached")}
        </p>
      )}
      {view.disabledReason === "subscription_canceled" && (
        <p className="text-xs text-spark-orange" role="alert">
          {t("disabledSubscriptionCanceled")}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-xs text-parchment/60">{t("reloadAmount")}</p>
        <div className="flex flex-wrap gap-2">
          {view.packs.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => setPackId(pack.id)}
              aria-pressed={packId === pack.id}
              className={[
                "rounded-md border px-3 py-1.5 text-xs transition-colors",
                packId === pack.id
                  ? "border-claw-green text-parchment"
                  : "border-parchment/20 text-parchment/60"
              ].join(" ")}
            >
              {pack.label} - {currency.format(pack.priceUsd)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-parchment/60">
          {t("whenBalanceBelow")}
          <input
            type="number"
            min={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="ml-2 w-24 rounded-md border border-parchment/20 bg-transparent px-2 py-1 text-parchment"
          />
          <span className="ml-1">{unitWord}</span>
        </label>

        <label className="text-xs text-parchment/60">
          {view.category === "chat" ? t("monthlyLimitRequiredChat") : t("monthlyLimitOptional")}
          <input
            type="number"
            min={1}
            value={monthlyLimit}
            onChange={(e) => setMonthlyLimit(e.target.value)}
            className="ml-2 w-24 rounded-md border border-parchment/20 bg-transparent px-2 py-1 text-parchment"
          />
        </label>

        <Button type="button" onClick={() => void save(enabled)} disabled={busy}>
          {t("save")}
        </Button>
      </div>

      {status && (
        <p className="text-xs text-parchment/60" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
