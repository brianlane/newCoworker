"use client";

/**
 * Direct Meta (Facebook) Lead Ads connection card for
 * /dashboard/integrations.
 *
 * The two-click alternative to the Zapier/Make/Privyr bridges: "Connect
 * Facebook" runs our platform Meta app's OAuth (via
 * /api/integrations/meta/connect), then the owner picks which Page to
 * watch — we subscribe it to leadgen webhooks and every new ad lead starts
 * their webhook AiFlows within seconds (source "facebook_lead_ads").
 *
 * API contract (/api/integrations/meta):
 *   GET    ?businessId=…       (state + Page options while pending)
 *   POST   {businessId, pageId} (finish setup: subscribe + activate)
 *   PATCH  {businessId, isActive}
 *   DELETE {businessId}
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type MetaConnection = {
  id: string;
  business_id: string;
  status: "pending" | "active";
  page_id: string | null;
  page_name: string | null;
  account_name: string | null;
  dataset_id: string | null;
  capi_enabled: boolean;
  is_active: boolean;
  /** Meta is refusing the token; the owner must reconnect. */
  needs_reconnect?: boolean;
  has_page_token: boolean;
  created_at: string;
  updated_at: string;
};

type PageOption = { id: string; name: string };

type Props = {
  businessId: string;
  initialConnection: MetaConnection | null;
};

export function MetaIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<MetaConnection | null>(initialConnection);
  const [pages, setPages] = useState<PageOption[]>([]);
  const [selectedPage, setSelectedPage] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [datasetInput, setDatasetInput] = useState(initialConnection?.dataset_id ?? "");
  const [savingDataset, setSavingDataset] = useState(false);
  const [datasetMessage, setDatasetMessage] = useState<string | null>(null);

  const pending = connection?.status === "pending";

  /**
   * Replace the connection AND re-seed the dataset field from it. Always use
   * this instead of setConnection: a dataset belongs to ONE Page, so picking
   * a different Page drops dataset_id server-side, and a field still holding
   * the old id would let one Save click attach the previous Page's dataset
   * to the new one (Bugbot 4cc8f6c4).
   */
  function applyConnection(next: MetaConnection | null) {
    setConnection(next);
    setDatasetInput(next?.dataset_id ?? "");
    setDatasetMessage(null);
  }

  // A pending connection needs its Page options (server-side Graph call).
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    setLoadingPages(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/integrations/meta?businessId=${encodeURIComponent(businessId)}`
        );
        const json = (await res.json()) as {
          data?: { connection?: MetaConnection | null; pages?: PageOption[] };
        };
        if (cancelled) return;
        setPages(json.data?.pages ?? []);
        if (json.data?.connection !== undefined) {
          applyConnection(json.data.connection ?? null);
        }
      } finally {
        if (!cancelled) setLoadingPages(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, businessId]);

  async function selectPage() {
    if (!selectedPage) return;
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, pageId: selectedPage })
      });
      const json = (await res.json()) as {
        data?: MetaConnection;
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not connect the Page");
        return;
      }
      applyConnection(json.data ?? null);
    } finally {
      setSaving(false);
    }
  }

  async function saveDataset() {
    setDatasetMessage(null);
    setSavingDataset(true);
    try {
      const res = await fetch("/api/integrations/meta", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, datasetId: datasetInput.trim() })
      });
      const json = (await res.json()) as {
        data?: MetaConnection;
        error?: { message?: string };
      };
      if (!res.ok || !json.data) {
        setDatasetMessage(
          json.error?.message ??
            "Could not save that dataset ID. It should be the numeric ID from Events Manager."
        );
        return;
      }
      const saved = json.data;
      applyConnection(saved);
      setDatasetMessage(
        saved.dataset_id ? "Saved. Stage changes now report to Meta." : "Dataset cleared."
      );
    } catch {
      setDatasetMessage("Network error");
    } finally {
      setSavingDataset(false);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/meta", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        applyConnection(null);
        setPages([]);
        setSelectedPage("");
      } else {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(json?.error?.message ?? "Could not disconnect");
      }
    } finally {
      setRemoving(false);
    }
  }

  // A rejected token outranks every other state: the connection LOOKS
  // complete, which is exactly why "Connected" here is the wrong thing to
  // show. Same wording and badge tone Zoom and Slack use for a dead grant.
  const needsReconnect = Boolean(connection?.needs_reconnect);
  const statusLabel = needsReconnect
    ? "Needs reconnect"
    : connection?.status === "active"
      ? "Connected"
      : connection
        ? "Almost there"
        : "Not connected";

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">
            Meta Lead Ads (Facebook &amp; Instagram)
          </h3>
          <p className="text-xs text-parchment/50 mt-1">
            Connect your Facebook Page and every new ad lead starts your webhook
            AiFlows within seconds — no Zapier or Make account needed.
          </p>
        </div>
        <Badge
          className="whitespace-nowrap"
          variant={
            needsReconnect
              ? "pending"
              : connection?.status === "active"
                ? "success"
                : connection
                  ? "pending"
                  : "neutral"
          }
        >
          {statusLabel}
        </Badge>
      </div>

      {needsReconnect ? (
        <p className="text-xs text-spark-orange mt-3">
          Facebook stopped accepting our requests for this account, so leads, replies, and
          scheduled posts are paused. This usually means the Facebook password changed, the
          Page role was removed, or the app was removed. Reconnect below to resume; nothing
          is lost.
        </p>
      ) : null}

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {!connection ? (
        <div className="space-y-3 mt-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              // Full document load: the connect route 302s to Facebook's OAuth
              // dialog, so the browser must follow it natively.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.href = `/api/integrations/meta/connect?businessId=${businessId}`;
            }}
          >
            Connect Facebook
          </Button>
          <p className="text-[11px] text-parchment/40">
            You&apos;ll log into Facebook and grant access to the Page that runs your
            ads. Prefer a bridge instead? The{" "}
            <Link
              href="/dashboard/aiflows/guides/meta-leads"
              className="text-signal-teal hover:underline"
            >
              bridge setup guide
            </Link>{" "}
            (Make.com / Zapier / Privyr) works too.
          </p>
        </div>
      ) : pending ? (
        <div className="space-y-3 mt-4">
          <p className="text-xs text-parchment/60">
            Facebook connected{connection.account_name ? (
              <>
                {" "}as <span className="text-parchment/90">{connection.account_name}</span>
              </>
            ) : null}
            . Pick the Page that runs your lead ads:
          </p>
          {loadingPages ? (
            <p className="text-xs text-parchment/40">Loading your Pages…</p>
          ) : pages.length === 0 ? (
            <p className="text-xs text-spark-orange">
              No Pages found on that Facebook account. Make sure you&apos;re an admin
              of the Page that runs your ads, then reconnect.
            </p>
          ) : (
            <select
              className="w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm text-parchment focus:outline-none focus:border-signal-teal/60"
              value={selectedPage}
              onChange={(e) => setSelectedPage(e.target.value)}
            >
              <option value="">Choose a Page…</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void selectPage()}
              loading={saving}
              disabled={!selectedPage}
            >
              Watch this Page for leads
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
              loading={removing}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 mt-4">
          <div className="text-xs text-parchment/60">
            Watching{" "}
            <span className="text-parchment/90">
              {connection.page_name ?? connection.page_id}
            </span>{" "}
            for new leads
            {connection.account_name ? (
              <span className="text-parchment/40"> · connected by {connection.account_name}</span>
            ) : null}
            {!connection.is_active ? (
              <span className="text-spark-orange"> · paused</span>
            ) : null}
          </div>
          <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
            <p className="text-[11px] text-parchment/40">
              Ads feedback:{" "}
              {connection.dataset_id && connection.capi_enabled && connection.is_active ? (
                <span className="text-claw-green">
                  on — booked and stage changes are reported back to Meta so your ads
                  optimize for lead quality
                </span>
              ) : connection.dataset_id && connection.capi_enabled ? (
                // Paused connections defer uploads; they resume on re-enable.
                <span>
                  paused with the connection — stage changes are held and report to
                  Meta once the connection is re-enabled.
                </span>
              ) : (
                <span>
                  off. Add your Conversions API dataset below and moving a lead to
                  Booked (or any pipeline stage) starts training your ads on lead
                  quality.
                </span>
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                className="min-w-[12rem] flex-1 rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-1.5 font-mono text-xs text-parchment focus:outline-none focus:border-signal-teal/60"
                placeholder="Dataset ID, e.g. 1234567890123456"
                value={datasetInput}
                onChange={(e) => setDatasetInput(e.target.value)}
                aria-label="Conversions API dataset ID"
                disabled={savingDataset}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void saveDataset()}
                loading={savingDataset}
                disabled={datasetInput.trim() === (connection.dataset_id ?? "")}
              >
                Save
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-parchment/40">
              In{" "}
              <a
                href="https://business.facebook.com/events_manager2"
                target="_blank"
                rel="noreferrer"
                className="text-signal-teal hover:underline"
              >
                Meta Events Manager
              </a>
              , open <strong>Connect data sources → CRM</strong>, create the dataset,
              then paste its ID here. Meta requires the advertiser to create it, so we
              cannot do this step for you. Leave blank to turn the feedback loop off.
            </p>
            {datasetMessage ? (
              <p className="mt-2 text-[11px] text-parchment/70" role="status">
                {datasetMessage}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                // Full document load: the connect route 302s to Facebook's OAuth
                // dialog, so the browser must follow it natively.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = `/api/integrations/meta/connect?businessId=${businessId}`;
              }}
            >
              Reconnect / change Page
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
              loading={removing}
            >
              Disconnect
            </Button>
          </div>
          <p className="text-[11px] text-parchment/40">
            New leads start your{" "}
            <Link
              href="/dashboard/aiflows/guides/meta-leads"
              className="text-signal-teal hover:underline"
            >
              webhook AiFlows
            </Link>{" "}
            with source <code className="text-parchment/60">facebook_lead_ads</code> —
            the same shape as the bridge path, so existing flows keep working.
            On Standard and above, Messenger and Instagram DMs are answered
            automatically and appear under{" "}
            <Link href="/dashboard/messenger" className="text-signal-teal hover:underline">
              Messenger
            </Link>
            .
          </p>
        </div>
      )}
    </Card>
  );
}
