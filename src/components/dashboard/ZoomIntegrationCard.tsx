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
 *
 * Once connected, the card also offers meeting-transcript import
 * (POST /api/integrations/zoom/import-transcript): paste a meeting ID from a
 * cloud-recorded meeting and the transcript lands in Documents as
 * staff-only meeting minutes.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

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
  const [meetingId, setMeetingId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<
    { kind: "success"; message: string } | { kind: "error"; message: string } | null
  >(null);

  const connectHref = `/api/integrations/zoom/connect?businessId=${encodeURIComponent(businessId)}`;
  const connectedAndActive = !!connection && connection.is_active;

  function startConnect() {
    window.location.href = connectHref;
  }

  async function importTranscript() {
    setImportResult(null);
    setImporting(true);
    try {
      const res = await fetch("/api/integrations/zoom/import-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, meetingId })
      });
      const json = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        data?: {
          summary?: string | null;
          document?: { status?: string; error_detail?: string | null };
        };
      } | null;
      if (res.ok && json?.data?.document?.status === "ready") {
        setMeetingId("");
        setImportResult({
          kind: "success",
          message: json.data.summary
            ? `Minutes saved to Documents: ${json.data.summary}`
            : "Transcript imported — minutes are in your Documents."
        });
      } else if (res.ok) {
        // 200 with a failed document: the transcript stored but the minutes
        // condensation failed — same contract as the Documents upload route.
        setImportResult({
          kind: "error",
          message: json?.data?.document?.error_detail
            ? `The transcript was saved but minutes generation failed: ${json.data.document.error_detail}`
            : "The transcript was saved but minutes generation failed — retry from Documents."
        });
      } else {
        setImportResult({
          kind: "error",
          message: json?.error?.message ?? "Import failed — try again shortly."
        });
      }
    } finally {
      setImporting(false);
    }
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
        <Badge
          className="whitespace-nowrap"
          variant={connectedAndActive ? "success" : connection ? "pending" : "neutral"}
        >
          {connectedAndActive
            ? "Connected"
            : connection
              ? "Needs reconnect"
              : "Not connected"}
        </Badge>
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
          {connection.is_active ? (
            <div className="rounded-lg border border-parchment/10 bg-parchment/[0.02] p-3">
              <p className="text-xs font-semibold text-parchment">Meeting minutes</p>
              <p className="text-[11px] text-parchment/40 mt-1">
                Paste the recording page link (Zoom portal → Recordings &amp; Transcripts →
                your meeting) — or the meeting ID for scheduled meetings — and your
                coworker turns the cloud-recording transcript into minutes in Documents.
              </p>
              <div className="mt-2 flex gap-2">
                <Input
                  value={meetingId}
                  onChange={(e) => setMeetingId(e.target.value)}
                  placeholder="Recording link or meeting ID"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={importTranscript}
                  loading={importing}
                  disabled={meetingId.replace(/\s+/g, "").length === 0}
                >
                  Import transcript
                </Button>
              </div>
              {importResult ? (
                <p
                  className={`text-xs mt-2 ${
                    importResult.kind === "success" ? "text-claw-green" : "text-spark-orange"
                  }`}
                >
                  {importResult.message}
                </p>
              ) : null}
            </div>
          ) : null}
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
