"use client";

/**
 * Google Chat connection card for /dashboard/integrations.
 *
 * NO FIELD TO FILL IN AND NO CONNECT BUTTON, which is not a simplification
 * but the only thing that works. A Google Chat space name is opaque and is
 * shown nowhere in the Chat UI, so there is no value the owner could paste
 * the way they paste an Entra tenant id for Teams, and Chat has no
 * per-tenant OAuth install to learn one from either.
 *
 * So the connect code does both jobs. Sending it in a space says which
 * business, which binds the space, and says who sent it, which binds them.
 * The card mints the code; the space finishes the job. That is why this card
 * offers a code BEFORE there is a connection, where Teams offers one only
 * after.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type GoogleChatConnection = {
  id: string;
  business_id: string;
  external_workspace_id: string;
  external_workspace_name: string | null;
  is_active: boolean;
};

type LinkCode = { code: string; expiresAt: string };

export function GoogleChatIntegrationCard({
  businessId,
  initialConnection,
  tierAllowed
}: {
  businessId: string;
  initialConnection: GoogleChatConnection | null;
  tierAllowed: boolean;
}) {
  const [connection, setConnection] = useState<GoogleChatConnection | null>(initialConnection);
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  const call = useCallback(async (init: RequestInit & { method: string }, query = "") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/integrations/google-chat${query}`, {
        headers: { "Content-Type": "application/json" },
        ...init
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { connection?: GoogleChatConnection | null; linkCode?: LinkCode | null };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? "Something went wrong. Try again.");
        return null;
      }
      return body?.data ?? {};
    } catch {
      setError("Could not reach the server. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  async function setActive(isActive: boolean) {
    const data = await call({ method: "PATCH", body: JSON.stringify({ businessId, isActive }) });
    if (data) setConnection(data.connection ?? null);
  }

  async function mintCode() {
    const data = await call({
      method: "PATCH",
      body: JSON.stringify({ businessId, mintLinkCodeFor: { isOwner: true, employeeId: null } })
    });
    if (data?.linkCode) setLinkCode(data.linkCode);
  }

  async function disconnect() {
    const data = await call({ method: "DELETE" }, `?businessId=${encodeURIComponent(businessId)}`);
    if (!data) return;
    setConnection(null);
    setLinkCode(null);
    setNotice("Disconnected.");
  }

  if (!tierAllowed) {
    return (
      <Card>
        <h2 className="text-lg text-parchment">Google Chat</h2>
        <p className="mt-2 text-sm text-parchment/60">
          The Google Chat integration is available on Standard and Enterprise plans.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-parchment">Google Chat</h2>
        {!connection ? (
          <Badge variant="neutral">Not connected</Badge>
        ) : !connection.is_active ? (
          <Badge variant="pending">Paused</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-claw-green">{notice}</p> : null}

      {!connection ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-parchment/60">
            Two steps. In Google Chat, add the New Coworker app to the space you want alerts in, or
            start a direct message with it. Then generate a code below and send it in that space.
          </p>
          <p className="text-sm text-parchment/60">
            The code is what tells us which space belongs to your business, so send it from the
            space you actually want to use.
          </p>
          {linkCode ? (
            <p className="text-sm text-parchment">
              Send <span className="font-mono text-claw-green">{linkCode.code}</span> in the space.
              It works once, and expires in 15 minutes.
            </p>
          ) : null}
          <Button onClick={mintCode} disabled={busy}>
            {busy ? "Working…" : "Generate a connect code"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-parchment/60">
            Alerts are going to{" "}
            <span className="text-parchment">
              {connection.external_workspace_name ?? "your connected space"}
            </span>
            .
          </p>

          <div className="space-y-2">
            <p className="text-sm text-parchment">Accounts that cannot be matched</p>
            <p className="text-sm text-parchment/60">
              Most people are recognised automatically from their Google Workspace account. If your
              Workspace does not share email addresses with apps, generate a one-time code and have
              them send it in the space instead.
            </p>
            {linkCode ? (
              <p className="text-sm text-parchment">
                Send <span className="font-mono text-claw-green">{linkCode.code}</span> in the
                space. It works once, and expires in 15 minutes.
              </p>
            ) : null}
            <Button variant="secondary" onClick={mintCode} disabled={busy}>
              Generate a connect code
            </Button>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => setActive(!connection.is_active)}
              disabled={busy}
            >
              {connection.is_active ? "Pause" : "Resume"}
            </Button>
            <Button variant="secondary" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
