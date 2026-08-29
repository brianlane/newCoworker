"use client";

/**
 * Microsoft Teams connection card for /dashboard/integrations.
 *
 * NO TOKEN AND NO OAUTH REDIRECT, unlike every other card here. Teams
 * authenticates with OUR Azure app credentials rather than the tenant's, so
 * there is no per-tenant secret to collect. What the owner supplies is which
 * Entra (Microsoft 365) tenant to accept activities from, which is the
 * boundary that stops a multi-tenant bot serving a business it was never
 * given to.
 *
 * The second step is the one that surprises people, so the card says it
 * plainly: Teams cannot START a conversation. A proactive alert can only
 * continue one the bot has already seen, so until somebody messages it once
 * there is nowhere to deliver, and the tile says "Message your bot once"
 * rather than "Connected".
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type TeamsConnection = {
  id: string;
  business_id: string;
  external_workspace_id: string;
  alert_target_id: string | null;
  is_active: boolean;
};

export function TeamsIntegrationCard({
  businessId,
  initialConnection,
  tierAllowed
}: {
  businessId: string;
  initialConnection: TeamsConnection | null;
  tierAllowed: boolean;
}) {
  const [connection, setConnection] = useState<TeamsConnection | null>(initialConnection);
  const [tenantId, setTenantId] = useState("");
  const [linkCode, setLinkCode] = useState<{ code: string; expiresAt: string } | null>(null);
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
      const res = await fetch(`/api/integrations/teams${query}`, {
        headers: { "Content-Type": "application/json" },
        ...init
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { connection?: TeamsConnection | null; linkCode?: typeof linkCode };
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

  async function connect() {
    const data = await call({
      method: "POST",
      body: JSON.stringify({ businessId, tenantId: tenantId.trim() })
    });
    if (!data) return;
    setConnection(data.connection ?? null);
    setTenantId("");
    setNotice("Connected. Now message the New Coworker app in Teams once, so it can reach you.");
  }

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
        <h2 className="text-lg text-parchment">Microsoft Teams</h2>
        <p className="mt-2 text-sm text-parchment/60">
          The Microsoft Teams integration is available on Standard and Enterprise plans.
        </p>
      </Card>
    );
  }

  const awaitingFirstMessage = Boolean(connection && !connection.alert_target_id);

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-parchment">Microsoft Teams</h2>
        {!connection ? (
          <Badge variant="neutral">Not connected</Badge>
        ) : !connection.is_active ? (
          <Badge variant="pending">Paused</Badge>
        ) : awaitingFirstMessage ? (
          <Badge variant="pending">Message your bot once</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-claw-green">{notice}</p> : null}

      {!connection ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-parchment/60">
            Install the New Coworker app in Teams, then tell us which Microsoft 365 tenant it is
            installed in. Only activity from that tenant is answered.
          </p>
          <p className="text-sm text-parchment/60">
            Your tenant id is in the Microsoft Entra admin centre, under Overview. It looks like a
            long id with dashes.
          </p>
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-label="Microsoft 365 tenant id"
            className="w-full rounded border border-parchment/20 bg-transparent px-3 py-2 text-sm text-parchment"
          />
          <Button onClick={connect} disabled={busy || tenantId.trim().length < 36}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-parchment/60">
            Connected to tenant{" "}
            <span className="text-parchment">{connection.external_workspace_id}</span>.
          </p>

          {awaitingFirstMessage ? (
            <p className="text-sm text-parchment/60">
              One step left: open the New Coworker app in Teams and send it any message. Teams does
              not let an app start a conversation, so alerts have nowhere to go until it has heard
              from someone once.
            </p>
          ) : (
            <p className="text-sm text-parchment/60">
              Alerts are going to the conversation your team started with the app.
            </p>
          )}

          <div className="space-y-2">
            <p className="text-sm text-parchment">Accounts that cannot be matched</p>
            <p className="text-sm text-parchment/60">
              Most people are recognised automatically from their Microsoft account. If your
              directory does not share email addresses with apps, generate a one-time code and send
              it to the bot instead.
            </p>
            {linkCode ? (
              <p className="text-sm text-parchment">
                Send <span className="font-mono text-claw-green">{linkCode.code}</span> to the app.
                It works once, and expires in 15 minutes.
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
