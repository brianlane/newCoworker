"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

type Props = {
  businessId: string;
  /**
   * True only when the connect route would actually refuse: at the tier cap AND
   * with no Google row to reconnect.
   *
   * NOT simply "at cap". A reconnect consumes no seat, so the route lets an
   * at-cap owner through when they already hold a Google row. Disabling on the
   * cap alone would lock a Starter tenant (cap 1, one Nango Google row) out of
   * the very migration this button exists for, with the server happily allowing
   * what the UI forbids.
   */
  blocked: boolean;
};

/**
 * "Connect Google", the first-party OAuth entry point for Gmail and Calendar.
 *
 * Navigates rather than fetches: the connect route answers with a 302 to
 * Google's consent screen, so the browser has to follow it. Same shape as the
 * Outlook and Zoom connect actions.
 *
 * An owner still on the Nango-brokered Google connection can use this: the
 * callback flips their EXISTING row to first-party in place, keeping the row id
 * every AiFlow mailbox binding references, so nothing they built breaks.
 */
export function GoogleConnectButton({ businessId, blocked }: Props) {
  const t = useTranslations("dashboard.integrationsWorkspace");

  function startConnect() {
    window.location.href = `/api/integrations/google/connect?businessId=${encodeURIComponent(businessId)}`;
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={startConnect}
        disabled={blocked}
      >
        {t("connectGoogle")}
      </Button>
      <p className="text-xs text-parchment/40">{t("connectGoogleHelp")}</p>
    </div>
  );
}
