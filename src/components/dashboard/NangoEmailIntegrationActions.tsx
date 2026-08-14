"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Nango from "@nangohq/frontend";
import { Button } from "@/components/ui/Button";
import {
  WorkspaceConnectionList,
  type WorkspaceConnectionCapClient,
  type WorkspaceConnectionClient
} from "@/components/dashboard/WorkspaceConnectionList";

type Props = {
  businessId: string;
  /** The long-tail rows only; Google and Outlook have their own pages now. */
  connections: WorkspaceConnectionClient[];
  /** Tier cap state; the server routes enforce it, this only explains it. */
  cap: WorkspaceConnectionCapClient;
};

const defaultApiHost = "https://api.nango.dev";

/**
 * The "Other 3rd Party Connections" tile: the Nango Connect UI plus the list
 * of long-tail connections it produced.
 *
 * Google and Microsoft 365 moved to their own tiles with first-party OAuth
 * buttons. The Connect UI can still broker a Google grant, which is exactly
 * why the success landing goes to the integrations hub rather than back here:
 * that row belongs to the Google tile, and dropping the owner on a page that
 * does not list it would read as a failed connect.
 */
export function NangoEmailIntegrationActions({ businessId, connections, cap }: Props) {
  const t = useTranslations("dashboard.integrationsWorkspace");
  const [loadingConnect, setLoadingConnect] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const atCap = cap.max !== null && cap.used >= cap.max;

  async function connect() {
    if (atCap) return;
    setBanner(null);
    setLoadingConnect(true);
    try {
      const res = await fetch("/api/integrations/nango/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: { token?: string };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not start connection");
        return;
      }
      const token = json.data?.token;
      if (!token) {
        setBanner("Invalid response from server");
        return;
      }

      const apiHost = (process.env.NEXT_PUBLIC_NANGO_API_HOST ?? defaultApiHost).replace(/\/$/, "");
      const nango = new Nango({ host: apiHost, connectSessionToken: token });
      const ui = nango.openConnectUI({
        sessionToken: token,
        onEvent: async (event) => {
          if (event.type === "error") {
            setBanner(event.payload.errorMessage);
          }
          if (event.type === "connect") {
            if (event.payload.isPending) return;
            const done = await fetch("/api/integrations/nango/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                businessId,
                connectionId: event.payload.connectionId,
                providerConfigKey: event.payload.providerConfigKey
              })
            });
            const doneJson = (await done.json().catch(() => null)) as {
              ok?: boolean;
              error?: { message?: string };
            } | null;
            if (done.ok) {
              ui.close();
              // Full reload so the server-rendered tiles pick up the connection
              // row /complete just wrote, landing the same way the first-party
              // OAuth callbacks do (they 302 the browser). The hub, not this
              // page: the Connect UI can broker a Google or Outlook grant, and
              // those rows now belong to their own tiles.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.href = "/dashboard/integrations?workspace=connected";
            } else {
              setBanner(doneJson?.error?.message ?? "Could not save connection");
            }
          }
        }
      });
      ui.open();
    } finally {
      setLoadingConnect(false);
    }
  }

  return (
    <div className="space-y-3">
      {banner ? <p className="text-xs text-spark-orange">{banner}</p> : null}

      {/* No reconnect exemption on this tile: the Nango session route refuses
          outright at the cap, so at-cap always means blocked here. */}
      <WorkspaceConnectionList
        businessId={businessId}
        connections={connections}
        cap={cap}
        connectBlocked={atCap}
      />

      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={connect}
        loading={loadingConnect}
        disabled={atCap}
      >
        {t("connectOther")}
      </Button>
    </div>
  );
}
