"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

type Props = {
  businessId: string;
  /** True once the tier cap is reached; the connect route enforces it too. */
  atCap: boolean;
};

/**
 * "Connect Outlook", the first-party OAuth entry point.
 *
 * Navigates rather than fetches: the connect route answers with a 302 to
 * login.microsoftonline.com, so the browser has to follow it. Same shape as
 * the Zoom card's connect action.
 *
 * This sits ABOVE the Nango actions on the workspace card, and both remain
 * usable: Outlook comes through here, while Google, OneDrive and the long tail
 * still go through the Nango Connect UI below.
 */
export function MicrosoftConnectButton({ businessId, atCap }: Props) {
  const t = useTranslations("dashboard.integrationsWorkspace");

  function startConnect() {
    window.location.href = `/api/integrations/microsoft/connect?businessId=${encodeURIComponent(businessId)}`;
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={startConnect}
        disabled={atCap}
      >
        {t("connectMicrosoft")}
      </Button>
      <p className="text-xs text-parchment/40">{t("connectMicrosoftHelp")}</p>
    </div>
  );
}
