"use client";

/**
 * Direct Calendly connection card for /dashboard/integrations.
 *
 * The zero-setup sibling of the Nango OAuth path: paste a Personal Access
 * Token (Calendly → Integrations & apps → API & webhooks) and the server
 * verifies it end-to-end before storing anything, keeping the connected
 * account's name/email for display.
 *
 * A business can link SEVERAL Calendly accounts, one row per account
 * (e.g. a teammate who books on their own Calendly). Bookings on every
 * linked account are seen by the booking machinery; availability offers
 * and booking links keep coming from the FIRST (primary) connection.
 *
 * Reconnect of a flagged row writes the new PAT onto THAT id (POST
 * connectionId), so a rejected token never stacks a duplicate account.
 *
 * API contract (/api/integrations/calendly):
 *   GET    ?businessId=…                        → { connections: [...] }
 *   POST   {businessId, accessToken, connectionId?}  (verify, then add/refresh)
 *   PATCH  {businessId, connectionId, isActive}
 *   DELETE {businessId, connectionId}
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatCalendlyLastHealthy } from "@/lib/calendly/reauth-copy";

type CalendlyConnection = {
  id: string;
  business_id: string;
  account_name: string | null;
  account_email: string | null;
  user_uri: string | null;
  is_active: boolean;
  needs_reauth: boolean;
  last_healthy_at: string | null;
  has_token: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialConnections: CalendlyConnection[];
  /** Deep-link target from ?reconnect=<id>; opens the paste-token form on that row. */
  reconnectConnectionId?: string | null;
};

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

function accountLabel(connection: CalendlyConnection): string {
  return connection.account_name ?? connection.account_email ?? "Linked account";
}

export function CalendlyIntegrationCard({
  businessId,
  initialConnections,
  reconnectConnectionId = null
}: Props) {
  const t = useTranslations("dashboard.integrationsCalendly");
  const [connections, setConnections] = useState<CalendlyConnection[]>(initialConnections);
  const [accessToken, setAccessToken] = useState("");
  const [showForm, setShowForm] = useState(
    initialConnections.length === 0 || Boolean(reconnectConnectionId)
  );
  const [reconnectId, setReconnectId] = useState<string | null>(reconnectConnectionId);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!reconnectConnectionId) return;
    setReconnectId(reconnectConnectionId);
    setShowForm(true);
  }, [reconnectConnectionId]);

  async function refresh() {
    const res = await fetch(
      `/api/integrations/calendly?businessId=${encodeURIComponent(businessId)}`
    );
    const json = (await res.json().catch(() => null)) as {
      data?: { connections?: CalendlyConnection[] };
    } | null;
    if (res.ok && json?.data?.connections) setConnections(json.data.connections);
  }

  async function save() {
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/calendly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          accessToken: accessToken.trim(),
          ...(reconnectId ? { connectionId: reconnectId } : {})
        })
      });
      const json = (await res.json()) as {
        data?: { connection?: CalendlyConnection | null; verified?: boolean; created?: boolean };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not save the connection");
        return;
      }
      if (!json.data?.verified || !json.data.connection) {
        setBanner(
          "Calendly rejected the token, double-check it and make sure it was created " +
            "with the user profile, event types, and scheduling links scopes. Nothing was saved."
        );
        return;
      }
      setAccessToken("");
      setShowForm(false);
      setReconnectId(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function setActive(connectionId: string, isActive: boolean) {
    setBanner(null);
    setBusyId(connectionId);
    try {
      const res = await fetch("/api/integrations/calendly", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, connectionId, isActive })
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(json?.error?.message ?? "Could not update the connection");
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(connectionId: string) {
    setBanner(null);
    setBusyId(connectionId);
    try {
      const res = await fetch("/api/integrations/calendly", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, connectionId })
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(json?.error?.message ?? "Could not disconnect");
        return;
      }
      const next = connections.filter((c) => c.id !== connectionId);
      setConnections(next);
      if (reconnectId === connectionId) setReconnectId(null);
      if (next.length === 0) setShowForm(true);
    } finally {
      setBusyId(null);
    }
  }

  function startReconnect(connectionId: string) {
    setBanner(null);
    setReconnectId(connectionId);
    setShowForm(true);
  }

  const anyConnected = connections.length > 0;
  const anyNeedsReauth = connections.some((c) => c.needs_reauth);
  const reconnectTarget = reconnectId ? connections.find((c) => c.id === reconnectId) : null;
  const headerBadge = !anyConnected
    ? { variant: "neutral" as const, label: t("statusNotConnected") }
    : anyNeedsReauth
      ? { variant: "high_load" as const, label: t("statusNeedsReconnect") }
      : {
          variant: "success" as const,
          label:
            connections.length === 1
              ? t("statusConnected")
              : t("accountsLabel", { count: connections.length })
        };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Calendly</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Let your coworker offer your Calendly availability and text customers a
            booking link, they confirm the time on your Calendly page. Link more than
            one account and bookings on any of them are seen.
          </p>
        </div>
        <Badge variant={headerBadge.variant} className="whitespace-nowrap">
          {headerBadge.label}
        </Badge>
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {anyConnected ? (
        <ul className="space-y-3 mt-4">
          {connections.map((connection, index) => {
            const needsReauth = connection.needs_reauth === true;
            return (
              <li
                key={connection.id}
                className="flex items-center justify-between gap-3 rounded-md border border-parchment/10 px-3 py-2"
              >
                <div className="text-xs text-parchment/60 min-w-0">
                  <span className="text-parchment/90 break-all">{accountLabel(connection)}</span>
                  {connection.account_name && connection.account_email ? (
                    <span className="text-parchment/40 break-all">
                      {" "}
                      · {connection.account_email}
                    </span>
                  ) : null}
                  {index === 0 ? (
                    <span className="text-parchment/40"> · {t("primary")}</span>
                  ) : null}
                  {needsReauth ? (
                    <>
                      <span className="ml-2">
                        <Badge variant="high_load" className="whitespace-nowrap">
                          {t("statusNeedsReconnect")}
                        </Badge>
                      </span>
                      {formatCalendlyLastHealthy(connection.last_healthy_at) ? (
                        <div className="mt-1 text-[11px] text-parchment/40">
                          {t("lastCheck", {
                            when: formatCalendlyLastHealthy(connection.last_healthy_at) ?? ""
                          })}
                        </div>
                      ) : null}
                    </>
                  ) : connection.is_active ? (
                    <span className="ml-2">
                      <Badge variant="success" className="whitespace-nowrap">
                        {t("statusConnected")}
                      </Badge>
                    </span>
                  ) : (
                    <span className="text-spark-orange/80"> · {t("statusDisabled")}</span>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {needsReauth ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => startReconnect(connection.id)}
                    >
                      {t("reconnect")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setActive(connection.id, !connection.is_active)}
                      loading={busyId === connection.id}
                    >
                      {connection.is_active ? "Disable" : "Enable"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => disconnect(connection.id)}
                    loading={busyId === connection.id}
                  >
                    {t("disconnect")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {showForm || !anyConnected ? (
        <form
          className="space-y-3 mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              {reconnectTarget
                ? `${t("reconnect")} ${accountLabel(reconnectTarget)}`
                : "Personal Access Token"}
            </label>
            <input
              className={inputClass}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="From Calendly → Integrations & apps → API & webhooks"
              required
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={saving}>
              {reconnectTarget
                ? t("reconnect")
                : anyConnected
                  ? "Add account"
                  : "Connect Calendly"}
            </Button>
            {anyConnected ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  setReconnectId(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-parchment/40">
            Create a token in Calendly under Integrations &amp; apps → API &amp; webhooks →
            &quot;Get a token now&quot;. Any Calendly plan works. When Calendly asks which
            permissions (scopes) to grant, include{" "}
            <span className="text-parchment/60">user profile (read)</span>,{" "}
            <span className="text-parchment/60">event types (read)</span>, and{" "}
            <span className="text-parchment/60">scheduling links (write)</span>, a token
            without them will fail verification here. Each teammate creates the token in
            their own Calendly account.
          </p>
        </form>
      ) : (
        <div className="mt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(true)}>
            Add another account
          </Button>
        </div>
      )}
    </Card>
  );
}
