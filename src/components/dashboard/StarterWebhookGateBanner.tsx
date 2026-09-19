"use client";

/**
 * Informational Starter gate for a saved webhook AiFlow. Soft-blocks only
 * outside webhook intake: the flow stays editable, history stays visible.
 * Diagnostic copy names current plan, required plan, blocked outcome, and
 * one Upgrade CTA. Contextual (trigger card / flow detail), not a modal wall.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { webhookGatePlanLabel } from "@/lib/ai-flows/webhook-sources";

type Props = {
  /** Tighter type for the trigger card inside the flow editor/detail. */
  compact?: boolean;
  /** Live `businesses.tier`. Defaults to Starter, the only gated case. */
  currentTier?: string | null;
};

export function StarterWebhookGateBanner({ compact = false, currentTier = "starter" }: Props) {
  const t = useTranslations("dashboard.pages");
  const typeClass = compact
    ? "text-[11px] text-amber-400/90"
    : "text-sm text-amber-400/90";
  return (
    <div
      className={
        compact
          ? "rounded-md border border-amber-400/30 bg-amber-400/5 p-3 space-y-1"
          : "rounded-md border border-amber-400/40 bg-amber-400/5 p-4 space-y-1.5"
      }
      role="status"
    >
      <p className={compact ? "text-[11px] font-semibold text-amber-400" : "text-sm font-semibold text-amber-400"}>
        {t("webhookGateTitle")}
      </p>
      <p className={typeClass}>{t("webhookGateCurrentPlan", { tier: webhookGatePlanLabel(currentTier) })}</p>
      <p className={typeClass}>{t("webhookGateRequiredPlan")}</p>
      <p className={typeClass}>{t("webhookGateBlockedOutcome")}</p>
      <p className={typeClass}>{t("webhookGateBody")}</p>
      <Link
        href="/dashboard/billing"
        className={
          compact
            ? "inline-block text-[11px] font-semibold text-signal-teal hover:underline"
            : "inline-block text-sm font-semibold text-signal-teal hover:underline"
        }
      >
        {t("webhookGateUpgrade")}
      </Link>
    </div>
  );
}
