"use client";

/**
 * Informational Starter gate for a saved webhook AiFlow. The flow stays
 * editable; outside lead webhooks will not start it until the tenant
 * upgrades. Matches the Zapier keys card / webhook-guide banner tone.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";

type Props = {
  /** Tighter type for the trigger card inside the flow editor/detail. */
  compact?: boolean;
};

export function StarterWebhookGateBanner({ compact = false }: Props) {
  const t = useTranslations("dashboard.pages");
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
      <p className={compact ? "text-[11px] text-amber-400/90" : "text-sm text-amber-400/90"}>
        {t("webhookGateBody")}{" "}
        <Link href="/dashboard/billing" className="text-signal-teal hover:underline">
          {t("webhookGateUpgrade")}
        </Link>
      </p>
    </div>
  );
}
