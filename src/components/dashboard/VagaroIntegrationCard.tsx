"use client";

/**
 * Vagaro connection card for /dashboard/integrations.
 *
 * Owners paste the Client ID / Client Secret from Vagaro's
 * Settings → APIs & Webhooks page. On save the server verifies the
 * credentials (token exchange + service listing) and returns the service
 * catalog, so the default-service picker is populated immediately. The
 * card also surfaces the tenant's webhook URL — pasting it into Vagaro's
 * webhook settings streams appointment/customer events straight into
 * AiFlows and the contact list, no Zapier account needed.
 *
 * API contract (/api/integrations/vagaro):
 *   GET    ?businessId=…&services=1  (state + live service catalog)
 *   POST   {businessId, clientId, clientSecret?, apiBaseUrl?}
 *   PATCH  {businessId, defaultServiceId?}
 *   DELETE {businessId}
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type VagaroConnection = {
  id: string;
  business_id: string;
  client_id: string;
  api_base_url: string;
  webhook_verification_token: string;
  default_service_id: string | null;
  default_employee_id: string | null;
  is_active: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
};

type VagaroService = { id: string; name: string; durationMinutes: number | null };

type Props = {
  businessId: string;
  initialConnection: VagaroConnection | null;
};

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

export function VagaroIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<VagaroConnection | null>(initialConnection);
  const [services, setServices] = useState<VagaroService[]>([]);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [clientId, setClientId] = useState(initialConnection?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(
    initialConnection?.api_base_url ?? "https://api.vagaro.com"
  );
  const [showForm, setShowForm] = useState(initialConnection === null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState(false);

  const webhookUrl =
    connection && typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/vagaro?business=${connection.business_id}&token=${connection.webhook_verification_token}`
      : null;

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/integrations/vagaro?businessId=${businessId}&services=1`
        );
        const json = (await res.json()) as {
          data?: { services?: VagaroService[]; servicesError?: string | null };
        };
        if (cancelled || !res.ok) return;
        setServices(json.data?.services ?? []);
        setServicesError(json.data?.servicesError ?? null);
      } catch {
        if (!cancelled) setServicesError("request_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-list when the connection row changes (fresh credentials).
  }, [businessId, connection]);

  async function save() {
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/vagaro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          apiBaseUrl: apiBaseUrl.trim()
        })
      });
      const json = (await res.json()) as {
        data?: {
          connection?: VagaroConnection;
          verified?: boolean;
          verifyError?: string;
          services?: VagaroService[];
        };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not save the connection");
        return;
      }
      setConnection(json.data?.connection ?? null);
      setServices(json.data?.services ?? []);
      setClientSecret("");
      setShowForm(false);
      setBanner(
        json.data?.verified
          ? null
          : "Saved, but Vagaro rejected the credentials — double-check the Client ID and Secret."
      );
    } finally {
      setSaving(false);
    }
  }

  async function setDefaultService(serviceId: string) {
    setBanner(null);
    const res = await fetch("/api/integrations/vagaro", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, defaultServiceId: serviceId || null })
    });
    const json = (await res.json()) as {
      data?: VagaroConnection | null;
      error?: { message?: string };
    };
    if (res.ok && json.data) {
      setConnection(json.data);
    } else {
      setBanner(json.error?.message ?? "Could not update the default service");
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/vagaro", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
        setServices([]);
        setClientId("");
        setClientSecret("");
        setShowForm(true);
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

  async function copyWebhookUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setBanner("Could not copy — select the URL and copy it manually.");
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Vagaro</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Let your coworker check real availability and book appointments on your
            Vagaro calendar, and start AiFlows from Vagaro events.
          </p>
        </div>
        <span
          className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border ${
            connection
              ? "text-claw-green border-claw-green/40 bg-claw-green/5"
              : "text-parchment/40 border-parchment/15"
          }`}
        >
          {connection ? "Connected" : "Not connected"}
        </span>
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {connection && !showForm ? (
        <div className="space-y-4 mt-4">
          <div className="text-xs text-parchment/60">
            Client ID <span className="text-parchment/90">{connection.client_id}</span>
            <span className="text-parchment/40"> · {connection.api_base_url}</span>
          </div>

          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              Default service to book
            </label>
            {services.length > 0 ? (
              <select
                className={inputClass}
                value={connection.default_service_id ?? ""}
                onChange={(e) => void setDefaultService(e.target.value)}
              >
                <option value="">Closest match by duration (automatic)</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.durationMinutes ? ` (${s.durationMinutes} min)` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-parchment/40">
                {servicesError
                  ? "Couldn't load your Vagaro services — check the credentials below."
                  : "Loading your Vagaro services…"}
              </p>
            )}
          </div>

          {webhookUrl ? (
            <div>
              <label className="block text-xs text-parchment/50 mb-1">
                Webhook URL — paste into Vagaro → Settings → APIs &amp; Webhooks
              </label>
              <div className="flex gap-2">
                <input readOnly value={webhookUrl} className={inputClass} />
                <Button type="button" variant="secondary" size="sm" onClick={copyWebhookUrl}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[11px] text-parchment/40 mt-1">
                Enable the Appointments and Customers event types so bookings and new
                clients reach your coworker automatically.
              </p>
            </div>
          ) : null}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(true)}>
              Update credentials
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
        </div>
      ) : (
        <form
          className="space-y-3 mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label className="block text-xs text-parchment/50 mb-1">Client ID</label>
            <input
              className={inputClass}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="From Vagaro → Settings → APIs & Webhooks"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-parchment/50 mb-1">Client Secret</label>
            <input
              className={inputClass}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={
                connection?.has_secret ? "Leave blank to keep the stored secret" : "Required"
              }
              required={!connection?.has_secret}
            />
          </div>
          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              API base URL (from your Vagaro developer settings)
            </label>
            <input
              className={inputClass}
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="https://api.vagaro.com"
              required
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={saving}>
              {connection ? "Save" : "Connect Vagaro"}
            </Button>
            {connection ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-parchment/40">
            Vagaro API access requires the APIs &amp; Webhooks add-on on your Vagaro
            account (Settings → APIs &amp; Webhooks → request access).
          </p>
        </form>
      )}
    </Card>
  );
}
