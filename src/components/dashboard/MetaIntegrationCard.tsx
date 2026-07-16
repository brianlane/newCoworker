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
  is_active: boolean;
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

  const pending = connection?.status === "pending";

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
          setConnection(json.data.connection ?? null);
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
      setConnection(json.data ?? null);
    } finally {
      setSaving(false);
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
        setConnection(null);
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

  const statusLabel =
    connection?.status === "active"
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
            connection?.status === "active" ? "success" : connection ? "pending" : "neutral"
          }
        >
          {statusLabel}
        </Badge>
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {!connection ? (
        <div className="space-y-3 mt-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              window.location.href = `/api/integrations/meta/connect?businessId=${businessId}`;
            }}
          >
            Connect Facebook
          </Button>
          <p className="text-[11px] text-parchment/40">
            You&apos;ll log into Facebook and grant access to the Page that runs your
            ads. While our Meta app finishes its review, connecting requires your
            Facebook account to be added as a tester — contact us and we&apos;ll set
            that up. Or use the{" "}
            <Link
              href="/dashboard/aiflows/guides/meta-leads"
              className="text-signal-teal hover:underline"
            >
              bridge setup guide
            </Link>{" "}
            (Make.com / Zapier / Privyr) which works for everyone today.
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
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
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
            Messenger (and Instagram DM) conversations with your Page are answered
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
