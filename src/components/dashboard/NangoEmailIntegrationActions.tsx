"use client";

import { useState } from "react";
import Nango from "@nangohq/frontend";
import { Button } from "@/components/ui/Button";

export type WorkspaceConnectionClient = {
  id: string;
  providerConfigKey: string;
  connectionId: string;
  createdAt: string;
};

type Props = {
  businessId: string;
  connections: WorkspaceConnectionClient[];
};

const defaultApiHost = "https://api.nango.dev";

export function NangoEmailIntegrationActions({ businessId, connections }: Props) {
  const [loadingConnect, setLoadingConnect] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  async function disconnectOne(id: string) {
    setBanner(null);
    setDisconnectingId(id);
    try {
      const res = await fetch("/api/integrations/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, id })
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setBanner(body?.error?.message ?? "Could not disconnect");
      }
    } finally {
      setDisconnectingId(null);
    }
  }

  async function connect() {
    setBanner(null);
    setLoadingConnect(true);
    try {
      const res = await fetch("/api/integrations/nango/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as { ok?: boolean; data?: { token?: string }; error?: { message?: string } };
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

      {connections.length > 0 ? (
        <ul className="space-y-2 text-sm text-parchment/80">
          {connections.map((c, i) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1 border-b border-parchment/10 last:border-0"
            >
              <span className="text-parchment/70">
                Account {i + 1}
                <span className="text-parchment/40 text-xs block sm:inline sm:ml-1">
                  · {new Date(c.createdAt).toLocaleDateString()}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => disconnectOne(c.id)}
                loading={disconnectingId === c.id}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Button type="button" variant="secondary" size="sm" onClick={connect} loading={loadingConnect}>
        {connections.length > 0 ? "Connect another account" : "Connect workspace"}
      </Button>
    </div>
  );
}
