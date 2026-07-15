"use client";

/**
 * Direct Zoom connection card for /dashboard/integrations.
 *
 * First-party OAuth (our published "New Coworker OAuth" Marketplace app):
 * Connect navigates the browser through /api/integrations/zoom/connect →
 * Zoom consent → our callback, which stores the encrypted token pair. Once
 * connected, the coworker can create Zoom meetings for booked appointments
 * and text/email customers the join link.
 *
 * Legacy note: Zoom links made through the old Nango workspace flow keep
 * working via the resolver fallback, but every NEW connection comes through
 * this card.
 *
 * API contract (/api/integrations/zoom):
 *   GET    ?businessId=…           (state, masked)
 *   PATCH  {businessId, isActive}
 *   DELETE {businessId}
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type ZoomConnection = {
  id: string;
  business_id: string;
  zoom_user_id: string | null;
  account_email: string | null;
  account_name: string | null;
  is_active: boolean;
  has_tokens: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialConnection: ZoomConnection | null;
};

export function ZoomIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<ZoomConnection | null>(initialConnection);
  const [banner, setBanner] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const connectHref = `/api/integrations/zoom/connect?businessId=${encodeURIComponent(businessId)}`;
  const connectedAndActive = !!connection && connection.is_active;

  function startConnect() {
    window.location.href = connectHref;
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/zoom", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
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

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Zoom</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Let your coworker schedule Zoom meetings on your account and send
            customers the join link when it books a video appointment.
          </p>
        </div>
        <span
          className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border ${
            connectedAndActive
              ? "text-claw-green border-claw-green/40 bg-claw-green/5"
              : "text-parchment/40 border-parchment/15"
          }`}
        >
          {connectedAndActive
            ? "Connected"
            : connection
              ? "Needs reconnect"
              : "Not connected"}
        </span>
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {connection ? (
        <div className="space-y-4 mt-4">
          <div className="text-xs text-parchment/60">
            {connection.account_name || connection.account_email ? (
              <>
                Linked to{" "}
                <span className="text-parchment/90">
                  {connection.account_name ?? connection.account_email}
                </span>
                {connection.account_name && connection.account_email ? (
                  <span className="text-parchment/40"> · {connection.account_email}</span>
                ) : null}
              </>
            ) : (
              "Zoom account connected."
            )}
            {!connection.is_active ? (
              <span className="text-spark-orange">
                {" "}
                Access was revoked or expired — reconnect to resume.
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            {!connection.is_active ? (
              <Button type="button" variant="secondary" size="sm" onClick={startConnect}>
                Reconnect
              </Button>
            ) : null}
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
        </div>
      ) : (
        <div className="space-y-3 mt-4">
          <Button type="button" variant="secondary" size="sm" onClick={startConnect}>
            Connect Zoom
          </Button>
          <p className="text-[11px] text-parchment/40">
            You&apos;ll be sent to Zoom to approve access. We only request meeting
            scheduling permissions; your Zoom sign-in stays with Zoom.
          </p>
        </div>
      )}
    </Card>
  );
}
