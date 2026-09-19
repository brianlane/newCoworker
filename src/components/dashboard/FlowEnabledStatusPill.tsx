"use client";

/**
 * On/off pill for an AiFlow. A still-enabled webhook flow on Starter is
 * not painted as healthy ENABLED: outside leads will not start it.
 */

import { useTranslations } from "next-intl";
import {
  flowEnabledStatusKind,
  type FlowEnabledStatusKind
} from "@/lib/ai-flows/webhook-sources";

const KIND_CLASS: Record<FlowEnabledStatusKind, string> = {
  enabled: "bg-claw-green/15 text-claw-green",
  off: "bg-parchment/10 text-parchment/50",
  saved_no_webhooks: "bg-amber-400/15 text-amber-400"
};

type Props = {
  enabled: boolean;
  webhookBlockedOnStarter?: boolean;
  className?: string;
};

export function FlowEnabledStatusPill({
  enabled,
  webhookBlockedOnStarter = false,
  className = "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
}: Props) {
  const t = useTranslations("dashboard.pages");
  const kind = flowEnabledStatusKind(enabled, webhookBlockedOnStarter);
  const label =
    kind === "off"
      ? t("flowStatusOff")
      : kind === "saved_no_webhooks"
        ? t("flowStatusSavedNoWebhooks")
        : t("flowStatusEnabled");
  return <span className={`${className} ${KIND_CLASS[kind]}`}>{label}</span>;
}
