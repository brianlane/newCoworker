"use client";

/**
 * Slack workspace connection card for /dashboard/integrations.
 *
 * First-party OAuth v2 install: Connect navigates the browser through
 * /api/integrations/slack/connect → Slack consent → our callback, which
 * stores the encrypted bot token. Once connected, the owner picks the
 * channel coworker alerts post to; the server stores it only after a hello
 * post proves the bot can actually deliver there.
 *
 * API contract (/api/integrations/slack):
 *   GET    ?businessId=…                → { connection, channels }
 *   PATCH  {businessId, alertChannel}   → save the alerts channel
 *   DELETE {businessId}                 → revoke + remove
 *
 * Standard+ only: starter tenants see the upgrade note instead of Connect
 * (the connect route enforces the same gate server-side).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type SlackConnection = {
  id: string;
  business_id: string;
  team_id: string;
  team_name: string | null;
  alert_channel_id: string | null;
  alert_channel_name: string | null;
  is_active: boolean;
  has_bot_token: boolean;
  created_at: string;
  updated_at: string;
};

type SlackChannel = {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
};

type Props = {
  businessId: string;
  initialConnection: SlackConnection | null;
  tierAllowed: boolean;
};

export function SlackIntegrationCard({ businessId, initialConnection, tierAllowed }: Props) {
  const t = useTranslations("dashboard.integrationsSlack");
  const [connection, setConnection] = useState<SlackConnection | null>(initialConnection);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>(
    initialConnection?.alert_channel_id ?? ""
  );
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(
    null
  );
  const [savingChannel, setSavingChannel] = useState(false);
  const [removing, setRemoving] = useState(false);

  const connectedAndActive = !!connection && connection.is_active && connection.has_bot_token;
  const connectHref = `/api/integrations/slack/connect?businessId=${encodeURIComponent(businessId)}`;

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/integrations/slack?businessId=${encodeURIComponent(businessId)}`
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { connection?: SlackConnection | null; channels?: SlackChannel[] };
      } | null;
      if (res.ok && json?.data) {
        if (json.data.connection !== undefined) setConnection(json.data.connection ?? null);
        setChannels(json.data.channels ?? []);
      }
    } catch {
      // Best-effort: the picker just stays empty.
    }
  }, [businessId]);

  useEffect(() => {
    if (connectedAndActive) void loadChannels();
  }, [connectedAndActive, loadChannels]);

  function startConnect() {
    // Full document load: the connect route 302s to Slack's consent screen,
    // so the browser must follow it natively.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = connectHref;
  }

  async function saveChannel() {
    const channel = channels.find((c) => c.id === selectedChannelId);
    if (!channel) return;
    setBanner(null);
    setSavingChannel(true);
    try {
      const res = await fetch("/api/integrations/slack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          alertChannel: { id: channel.id, name: channel.name }
        })
      });
      const json = (await res.json().catch(() => null)) as {
        data?: SlackConnection | null;
        error?: { message?: string };
      } | null;
      if (res.ok && json?.data) {
        setConnection(json.data);
        setBanner({ kind: "success", text: t("alertChannelSaved", { channel: channel.name }) });
      } else {
        setBanner({ kind: "error", text: json?.error?.message ?? t("alertChannelSaveFailed") });
      }
    } finally {
      setSavingChannel(false);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/slack", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
        setChannels([]);
        setSelectedChannelId("");
      } else {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner({ kind: "error", text: json?.error?.message ?? t("disconnectFailed") });
      }
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">{t("title")}</h3>
          <p className="text-xs text-parchment/50 mt-1">{t("description")}</p>
        </div>
        <Badge
          className="whitespace-nowrap"
          variant={connectedAndActive ? "success" : connection ? "pending" : "neutral"}
        >
          {connectedAndActive
            ? t("statusConnected")
            : connection
              ? t("statusNeedsReconnect")
              : t("statusNotConnected")}
        </Badge>
      </div>

      {banner ? (
        <p
          className={`text-xs mt-3 ${banner.kind === "success" ? "text-claw-green" : "text-spark-orange"}`}
        >
          {banner.text}
        </p>
      ) : null}

      {!tierAllowed ? (
        <p className="text-xs text-parchment/60 mt-4">{t("upgradeMessage")}</p>
      ) : connection ? (
        <div className="space-y-4 mt-4">
          <div className="text-xs text-parchment/60">
            {connection.team_name
              ? t("linkedTo", { workspace: connection.team_name })
              : t("linkedNoName")}
            {!connectedAndActive ? (
              <span className="text-spark-orange"> {t("reconnectNote")}</span>
            ) : null}
          </div>

          {connectedAndActive ? (
            <div className="rounded-lg border border-parchment/10 bg-parchment/[0.02] p-3">
              <p className="text-xs font-semibold text-parchment">{t("alertChannelTitle")}</p>
              <p className="text-[11px] text-parchment/40 mt-0.5">{t("alertChannelHint")}</p>
              <p className="text-xs text-parchment/60 mt-2">
                {connection.alert_channel_name
                  ? t("alertChannelCurrent", { channel: connection.alert_channel_name })
                  : t("alertChannelNone")}
              </p>
              <div className="mt-2 flex gap-2">
                <select
                  value={selectedChannelId}
                  onChange={(e) => setSelectedChannelId(e.target.value)}
                  aria-label={t("alertChannelTitle")}
                  className="flex-1 rounded-md border border-parchment/15 bg-deep-ink px-2 py-1.5 text-xs text-parchment"
                >
                  <option value="">{t("alertChannelPlaceholder")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                      {c.is_private ? ` ${t("privateChannelSuffix")}` : ""}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={saveChannel}
                  loading={savingChannel}
                  disabled={selectedChannelId.length === 0}
                >
                  {t("alertChannelSave")}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex gap-2">
            {!connectedAndActive ? (
              <Button type="button" variant="secondary" size="sm" onClick={startConnect}>
                {t("reconnect")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
              loading={removing}
            >
              {t("disconnect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 mt-4">
          <Button type="button" variant="secondary" size="sm" onClick={startConnect}>
            {t("connectCta")}
          </Button>
          <p className="text-[11px] text-parchment/40">{t("connectNote")}</p>
        </div>
      )}
    </Card>
  );
}
