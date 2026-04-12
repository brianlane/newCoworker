"use client";

import { useMemo, useState } from "react";
import Nango from "@nangohq/frontend";
import { Button } from "@/components/ui/Button";

export type WorkspaceConnectionClient = {
  id: string;
  providerConfigKey: string;
  connectionId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

type Props = {
  businessId: string;
  connections: WorkspaceConnectionClient[];
};

const defaultApiHost = "https://api.nango.dev";

const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-mail": "Gmail",
  google: "Google",
  "google-calendar": "Google Calendar",
  outlook: "Microsoft Outlook",
  "outlook-calendar": "Outlook Calendar",
  onedrive: "OneDrive"
};

function providerLabel(providerConfigKey: string): string {
  const k = providerConfigKey.toLowerCase();
  if (PROVIDER_LABELS[k]) return PROVIDER_LABELS[k];
  return providerConfigKey
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function connectionPrimaryLabel(
  c: WorkspaceConnectionClient,
  sameProviderCount: number
): string {
  const m = c.metadata ?? {};
  const email = m.end_user_email;
  const displayName = m.end_user_display_name;
  if (typeof email === "string" && email.length > 0) return email;
  if (typeof displayName === "string" && displayName.length > 0) return displayName;

  const label = providerLabel(c.providerConfigKey);
  if (sameProviderCount > 1) {
    const tail =
      c.connectionId.length > 10 ? `…${c.connectionId.slice(-6)}` : c.connectionId;
    return `${label} (${tail})`;
  }
  return label;
}

export function NangoEmailIntegrationActions({ businessId, connections }: Props) {
  const [loadingConnect, setLoadingConnect] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const countsByProvider = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of connections) {
      m.set(c.providerConfigKey, (m.get(c.providerConfigKey) ?? 0) + 1);
    }
    return m;
  }, [connections]);

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
          {connections.map((c) => {
            const sameN = countsByProvider.get(c.providerConfigKey) ?? 1;
            const primary = connectionPrimaryLabel(c, sameN);
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1 border-b border-parchment/10 last:border-0"
              >
                <span className="text-parchment/70">
                  <span className="text-parchment/90">{primary}</span>
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
            );
          })}
        </ul>
      ) : null}

      <Button type="button" variant="secondary" size="sm" onClick={connect} loading={loadingConnect}>
        {connections.length > 0 ? "Connect another account" : "Connect workspace"}
      </Button>
    </div>
  );
}
