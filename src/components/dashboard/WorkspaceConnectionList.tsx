"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

export type WorkspaceConnectionClient = {
  id: string;
  providerConfigKey: string;
  connectionId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type WorkspaceConnectionCapClient = {
  /**
   * Seats used across the WHOLE table, not just the rows below. The cap is one
   * shared pool spanning the Google, Microsoft 365, and Other tiles, so each
   * page reports the same total and the copy says so.
   */
  used: number;
  /** null = unlimited (enterprise). */
  max: number | null;
};

type Props = {
  businessId: string;
  /** Only the rows belonging to THIS page's tile. */
  connections: WorkspaceConnectionClient[];
  /** Tier cap state; the server routes enforce it, this only explains it. */
  cap: WorkspaceConnectionCapClient;
};

const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-mail": "Gmail",
  google: "Google",
  "google-calendar": "Google Calendar",
  outlook: "Microsoft Outlook",
  "outlook-calendar": "Outlook Calendar",
  calendly: "Calendly",
  onedrive: "OneDrive",
  slack: "Slack",
  zoom: "Zoom"
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
  // The real account behind the OAuth grant (probed from the provider after
  // connect). The end_user_* keys are only the dashboard login that started
  // the session, identical across every account, so they are last-resort
  // fallbacks for legacy rows.
  const accountEmail = m.provider_account_email;
  const accountName = m.provider_account_display_name;
  if (typeof accountEmail === "string" && accountEmail.length > 0) return accountEmail;
  if (typeof accountName === "string" && accountName.length > 0) return accountName;
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

/**
 * The connected-accounts list, with per-row disconnect and the shared cap copy.
 *
 * Shared by all three workspace tiles (Google, Microsoft 365, and Other 3rd
 * Party Connections). Only the CONNECT action differs between them, so it
 * lives on each page rather than here: first-party OAuth buttons for Google
 * and Microsoft, the Nango Connect UI for the long tail.
 */
export function WorkspaceConnectionList({ businessId, connections, cap }: Props) {
  const t = useTranslations("dashboard.integrationsWorkspace");
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const atCap = cap.max !== null && cap.used >= cap.max;

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
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(body?.error?.message ?? "Could not disconnect");
      }
    } finally {
      setDisconnectingId(null);
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
            const provider = providerLabel(c.providerConfigKey);
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1 border-b border-parchment/10 last:border-0"
              >
                <span className="text-parchment/70">
                  <span className="text-parchment/90">{primary}</span>
                  <span className="text-parchment/40 text-xs block sm:inline sm:ml-1">
                    {primary === provider ? "" : `· ${provider} `}·{" "}
                    {new Date(c.createdAt).toLocaleDateString()}
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

      {/* Gated on the SHARED total, not on this tile's row count: a tenant
          looking at an empty Google page still needs to know their seats went
          to Outlook and OneDrive, or the connect button refusing makes no
          sense to them. */}
      {cap.max !== null && cap.used > 0 ? (
        <p className="text-xs text-parchment/40">
          {t("capUsage", { used: cap.used, max: cap.max })}
        </p>
      ) : null}

      {atCap ? (
        <p className="text-xs text-parchment/60">{t("capReached", { max: cap.max ?? 0 })}</p>
      ) : null}
    </div>
  );
}
