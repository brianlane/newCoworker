/**
 * Cancel/plan-end confirmation sheet opened from the billing page. Two
 * composable modes mirror the lifecycle planner:
 *
 *   - `refund`: immediate cancel + full refund + VPS teardown + 30-day
 *     data-grace. Only offered inside the customer-lifetime 30-day money-
 *     back window AND when the lifetime refund hasn't been used. The
 *     server-side planner re-verifies both constraints; we just hide the
 *     button when we know it's ineligible.
 *   - `period_end`: keep access until `current_period_end`; at that
 *     boundary the subscription flips to canceled + grace. Does NOT burn
 *     the refund right, if the user later decides to claim the refund
 *     within the lifetime window they still can (until they burn it).
 *
 * Before commit, labeled sections spell out timing, what they keep through
 * grace, and what stops. Copy is catalog-backed (same feature lines as
 * plan-change confirm). The cancel actions stay clearly available.
 *
 * Calls `/api/billing/cancel`. Refresh is a hard nav so server-rendered
 * banners (grace) reflect the new state immediately.
 */

"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import {
  cancelConfirmPreview,
  CANCEL_KEEP_CATALOG_KEYS,
  CANCEL_LOSS_CATALOG_KEYS,
  type CancelConfirmMode,
  type CancelKeepId,
  type CancelLossId
} from "@/lib/billing/cancel-copy";
import {
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso
} from "@/lib/billing/plan-change-copy";

type SubmitMode = "refund" | "period_end";

type Props = {
  open: boolean;
  onClose: () => void;
  canRefund: boolean;
  refundBlockedReason?: string | null;
  periodEnd?: string | null;
  alreadyPeriodEnd: boolean;
  onUndoPeriodEnd?: () => Promise<void> | void;
  currentTier?: "starter" | "standard" | "enterprise" | null;
  boxExpiresAt?: string | null;
  hasLiveBox?: boolean;
};

function formatDate(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return iso;
  }
}

export function CancelSheet({
  open,
  onClose,
  canRefund,
  refundBlockedReason,
  periodEnd,
  alreadyPeriodEnd,
  onUndoPeriodEnd,
  currentTier = null,
  boxExpiresAt = null,
  hasLiveBox
}: Props) {
  const t = useTranslations("dashboard.planCard");
  const locale = useLocale();
  const [submitting, setSubmitting] = useState<SubmitMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const periodFallback = t("cancelEndOfPeriodFallback");
  const periodLabel = formatDate(periodEnd, periodFallback);
  const preview = cancelConfirmPreview({
    mode: alreadyPeriodEnd ? "period_end" : "refund",
    currentTier,
    periodEnd,
    boxExpiresAt,
    hasLiveBox
  });

  function keepLine(id: CancelKeepId): string {
    return t(CANCEL_KEEP_CATALOG_KEYS[id]);
  }

  function lossLine(id: CancelLossId): string {
    return t(CANCEL_LOSS_CATALOG_KEYS[id]);
  }

  function hardwareText(mode: CancelConfirmMode): string | null {
    const key = cancelConfirmPreview({
      mode,
      currentTier,
      periodEnd,
      boxExpiresAt,
      hasLiveBox
    }).hardwareKey;
    if (key === "none") return null;
    const iso = parseablePaidThroughIso(boxExpiresAt);
    const date = iso ? formatPlanChangePaidThroughDate(iso, locale) : null;
    if (key === "cliffDated") {
      return date ? t("cancelHostingerCliffDated", { date }) : t("cancelHostingerCliffGeneric");
    }
    if (key === "cliffGeneric") return t("cancelHostingerCliffGeneric");
    if (key === "periodEndDated" && date) return t("cancelHostingerPeriodEndDated", { date });
    return null;
  }

  async function handleCancel(mode: SubmitMode) {
    setError(null);
    setSubmitting(mode);
    try {
      const res = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setError(json && json.ok === false ? json.error.message : t("cancelCouldNotCancel"));
        setSubmitting(null);
        return;
      }
      window.location.reload();
    } catch {
      setError(t("cancelNetworkError"));
      setSubmitting(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center overflow-y-auto bg-deep-ink/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* The honesty sections plus the two option blocks are taller than a
          phone viewport, so the panel scrolls rather than pushing its
          buttons off-screen. */}
      <div className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-parchment/10 bg-deep-ink p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-parchment">
            {alreadyPeriodEnd ? t("cancelManageTitle") : t("cancelTitle")}
          </h2>
          <p className="text-xs text-parchment/60 mt-1">
            {alreadyPeriodEnd
              ? t("cancelManageBody", { date: periodLabel })
              : t("cancelChooseBody")}
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-parchment/50 uppercase tracking-wider">
            {t("cancelConfirmTimingLabel")}
          </p>
          {canRefund ? (
            <p className="text-xs text-parchment/80">
              {t("cancelTimingRefundGeneric")}
            </p>
          ) : null}
          <p className="text-xs text-parchment/80">
            {periodEnd
              ? t("cancelTimingPeriodEnd", { date: periodLabel })
              : t("cancelTimingPeriodEndGeneric")}
          </p>
          {canRefund && hardwareText("refund") ? (
            <p className="text-xs text-parchment/60">{hardwareText("refund")}</p>
          ) : null}
          {hardwareText("period_end") ? (
            <p className="text-xs text-parchment/60">{hardwareText("period_end")}</p>
          ) : null}
        </div>

        <div className="text-xs text-parchment/80 space-y-1.5">
          <p className="font-semibold text-parchment">{t("cancelConfirmKeepLabel")}</p>
          <ul className="list-disc pl-4 space-y-1">
            {preview.keepIds.map((id) => (
              <li key={id}>{keepLine(id)}</li>
            ))}
          </ul>
        </div>

        <div className="text-xs text-spark-orange space-y-1.5" role="status">
          <p className="font-semibold">{t("cancelConfirmLossLabel")}</p>
          <ul className="list-disc pl-4 space-y-1 text-spark-orange/90">
            {preview.lossIds.map((id) => (
              <li key={id}>{lossLine(id)}</li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-parchment/50">{t("cancelAlternative")}</p>

        {canRefund ? (
          <div className="rounded-lg border border-claw-green/30 bg-claw-green/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">{t("cancelRefundTitle")}</p>
            <p className="text-xs text-parchment/60">{t("cancelRefundBody")}</p>
            <Button
              size="sm"
              variant="primary"
              loading={submitting === "refund"}
              disabled={submitting !== null}
              onClick={() => handleCancel("refund")}
            >
              {t("cancelRefundCta")}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4">
            <p className="text-sm font-semibold text-parchment/80">{t("cancelRefundUnavailableTitle")}</p>
            <p className="text-xs text-parchment/50 mt-1">
              {refundBlockedReason ?? t("cancelRefundUnavailableBody")}
            </p>
          </div>
        )}

        {alreadyPeriodEnd ? (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">{t("cancelKeepPlanTitle")}</p>
            <p className="text-xs text-parchment/60">{t("cancelKeepPlanBody")}</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting !== null}
              onClick={() => onUndoPeriodEnd?.()}
            >
              {t("cancelUndoCta")}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">{t("cancelPeriodEndTitle")}</p>
            <p className="text-xs text-parchment/60">
              {t("cancelPeriodEndBody", { date: periodLabel })}
            </p>
            <Button
              size="sm"
              variant="ghost"
              loading={submitting === "period_end"}
              disabled={submitting !== null}
              onClick={() => handleCancel("period_end")}
            >
              {t("cancelPeriodEndCta")}
            </Button>
          </div>
        )}

        {error && (
          <p className="text-xs text-spark-orange" role="alert">
            {error}
          </p>
        )}

        <div className="pt-2 flex justify-end">
          <button
            type="button"
            className="text-xs text-parchment/50 hover:text-parchment underline"
            onClick={onClose}
            disabled={submitting !== null}
          >
            {t("cancelClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
