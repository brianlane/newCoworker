"use client";

/**
 * Cal.com connection card. Connect sends the owner through first-party
 * OAuth. Disconnect soft-disables the row.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type CalConnection = {
  id: string;
  account_email: string | null;
  account_name: string | null;
  username: string | null;
  is_active: boolean;
  needs_reauth: boolean;
};

type Props = {
  businessId: string;
  initialConnection: CalConnection | null;
};

export function CalIntegrationCard({ businessId, initialConnection }: Props) {
  const router = useRouter();
  const [connection, setConnection] = useState(initialConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startConnect() {
    // Full navigation: the route 302s to Cal.com, which a client router push cannot do.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/integrations/cal/connect?businessId=${encodeURIComponent(businessId)}`;
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/cal", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (!res.ok) {
        setError("Could not disconnect Cal.com");
        return;
      }
      setConnection(null);
      router.refresh();
    } catch {
      setError("Could not disconnect Cal.com");
    } finally {
      setBusy(false);
    }
  }

  const active = connection?.is_active === true;
  const label = connection?.needs_reauth
    ? "Needs reconnect"
    : active
      ? "Connected"
      : "Not connected";

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Cal.com</h2>
          <p className="mt-1 text-sm text-parchment">
            Let your coworker check open times and book on your Cal.com page.
          </p>
        </div>
        <Badge variant={active && !connection?.needs_reauth ? "success" : "neutral"}>{label}</Badge>
      </div>
      {active && (connection?.account_name || connection?.account_email || connection?.username) ? (
        <p className="text-sm text-ink">
          {connection.account_name || connection.username || connection.account_email}
          {connection.account_email ? ` (${connection.account_email})` : ""}
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={startConnect}>
          {active ? "Reconnect" : "Connect Cal.com"}
        </Button>
        {active ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void disconnect()} disabled={busy}>
            {busy ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
