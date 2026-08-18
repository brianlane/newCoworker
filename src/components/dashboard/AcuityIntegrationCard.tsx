"use client";

/**
 * Acuity Scheduling connection card for /dashboard/integrations.
 *
 * Owners paste the User ID and API Key from Acuity's
 * Integrations → API page (both are self-serve; no app approval, no OAuth
 * client). On save the server verifies them against GET /me and returns the
 * appointment types and calendars, so the default pickers populate
 * immediately.
 *
 * Two things here are Acuity-specific rather than cosmetic:
 *
 *   - The card warns when Vagaro is already connected. Vagaro wins calendar
 *     resolution over Acuity by design (it is the incumbent, and switching a
 *     live tenant's book silently is the one unacceptable outcome), so
 *     without this an owner could connect Acuity and watch it do nothing.
 *
 *   - "Let Acuity email the customer too" defaults OFF. The platform already
 *     sends its own confirmation, and two confirmations for one booking is
 *     the complaint that dominates support for this class of integration.
 *
 * API contract (/api/integrations/acuity):
 *   GET    ?businessId=…&catalog=1  (state + appointment types + calendars)
 *   POST   {businessId, userId, apiKey?}
 *   PATCH  {businessId, defaultAppointmentTypeId?, defaultCalendarId?,
 *           suppressProviderEmails?}
 *   DELETE {businessId}
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type AcuityConnection = {
  id: string;
  business_id: string;
  user_id: string;
  api_base_url: string;
  webhook_verification_token: string;
  default_appointment_type_id: string | null;
  default_calendar_id: string | null;
  default_calendar_timezone: string | null;
  suppress_provider_emails: boolean;
  is_active: boolean;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
};

type AcuityAppointmentType = {
  id: string;
  name: string | null;
  durationMinutes: number | null;
  type: string;
  active: boolean;
};

type AcuityCalendar = { id: string; name: string | null; timezone: string | null };

type Props = {
  businessId: string;
  initialConnection: AcuityConnection | null;
};

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

export function AcuityIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<AcuityConnection | null>(initialConnection);
  const [appointmentTypes, setAppointmentTypes] = useState<AcuityAppointmentType[]>([]);
  const [calendars, setCalendars] = useState<AcuityCalendar[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(initialConnection !== null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [otherProvider, setOtherProvider] = useState<string | null>(null);
  const [userId, setUserId] = useState(initialConnection?.user_id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showForm, setShowForm] = useState(initialConnection === null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState(false);

  const webhookUrl =
    connection && typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/acuity?business=${connection.business_id}&token=${connection.webhook_verification_token}`
      : null;

  /** Only one-on-one services are bookable; classes need a different API. */
  const bookableTypes = appointmentTypes.filter((t) => t.active && t.type === "service");

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(connection !== null);
    (async () => {
      try {
        const res = await fetch(
          `/api/integrations/acuity?businessId=${businessId}${connection ? "&catalog=1" : ""}`
        );
        const json = (await res.json()) as {
          data?: {
            appointmentTypes?: AcuityAppointmentType[];
            calendars?: AcuityCalendar[];
            catalogError?: string | null;
            otherBookingProviderActive?: string | null;
          };
        };
        if (cancelled) return;
        if (!res.ok) {
          setCatalogError("request_failed");
          return;
        }
        setAppointmentTypes(json.data?.appointmentTypes ?? []);
        setCalendars(json.data?.calendars ?? []);
        setCatalogError(json.data?.catalogError ?? null);
        setOtherProvider(json.data?.otherBookingProviderActive ?? null);
      } catch {
        if (!cancelled) setCatalogError("request_failed");
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-read when the connection row changes (fresh credentials).
  }, [businessId, connection]);

  async function save() {
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/acuity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          userId: userId.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
        })
      });
      const json = (await res.json()) as {
        data?: {
          connection?: AcuityConnection;
          verified?: boolean;
          verifyError?: string;
          appointmentTypes?: AcuityAppointmentType[];
          calendars?: AcuityCalendar[];
        };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not save the connection");
        return;
      }
      setConnection(json.data?.connection ?? null);
      setAppointmentTypes(json.data?.appointmentTypes ?? []);
      setCalendars(json.data?.calendars ?? []);
      setApiKey("");
      setShowForm(false);
      setBanner(
        json.data?.verified
          ? null
          : "Saved, but Acuity rejected the credentials, double-check the User ID and API Key."
      );
    } finally {
      setSaving(false);
    }
  }

  async function patch(body: Record<string, unknown>, failure: string) {
    setBanner(null);
    const res = await fetch("/api/integrations/acuity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, ...body })
    });
    const json = (await res.json()) as {
      data?: AcuityConnection | null;
      error?: { message?: string };
    };
    if (res.ok && json.data) {
      setConnection(json.data);
    } else {
      setBanner(json.error?.message ?? failure);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/acuity", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
        setAppointmentTypes([]);
        setCalendars([]);
        setUserId("");
        setApiKey("");
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
      setBanner("Could not copy, select the URL and copy it manually.");
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Acuity Scheduling</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Let your coworker check real availability and book appointments on your
            Acuity calendar, and start AiFlows from Acuity appointments.
          </p>
        </div>
        <Badge variant={connection ? "success" : "neutral"}>
          {connection ? "Connected" : "Not connected"}
        </Badge>
      </div>

      {otherProvider === "vagaro" ? (
        <p className="text-xs text-spark-orange mt-3">
          Vagaro is currently handling booking for this business. Disconnect Vagaro first,
          or your coworker will keep booking there rather than on Acuity.
        </p>
      ) : null}

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {connection && !showForm ? (
        <div className="space-y-4 mt-4">
          <div className="text-xs text-parchment/60">
            User ID <span className="text-parchment/90">{connection.user_id}</span>
            {connection.default_calendar_timezone ? (
              <span className="text-parchment/40">
                {" "}
                · {connection.default_calendar_timezone}
              </span>
            ) : null}
          </div>

          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              Default appointment type to book
            </label>
            {bookableTypes.length > 0 ? (
              <select
                className={inputClass}
                value={connection.default_appointment_type_id ?? ""}
                onChange={(e) =>
                  void patch(
                    { defaultAppointmentTypeId: e.target.value || null },
                    "Could not update the default appointment type"
                  )
                }
              >
                <option value="">Closest match by duration (automatic)</option>
                {bookableTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name ?? t.id}
                    {t.durationMinutes ? ` (${t.durationMinutes} min)` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-parchment/40">
                {catalogLoading
                  ? "Loading your Acuity appointment types…"
                  : catalogError
                    ? "Couldn't load your Acuity appointment types, check the credentials below."
                    : "No bookable one-on-one appointment types found. Classes and series are not bookable by your coworker yet."}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              Default calendar (staff member or resource)
            </label>
            {calendars.length > 0 ? (
              <select
                className={inputClass}
                value={connection.default_calendar_id ?? ""}
                onChange={(e) =>
                  void patch(
                    { defaultCalendarId: e.target.value || null },
                    "Could not update the default calendar"
                  )
                }
              >
                <option value="">Let Acuity choose</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? c.id}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-parchment/40">
                {catalogLoading ? "Loading your Acuity calendars…" : "No calendars found."}
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 text-xs text-parchment/60">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!connection.suppress_provider_emails}
              onChange={(e) =>
                void patch(
                  { suppressProviderEmails: !e.target.checked },
                  "Could not update the email setting"
                )
              }
            />
            <span>
              Let Acuity email and text the customer too.
              <span className="block text-parchment/40">
                Off by default: your coworker already sends its own confirmation, so
                leaving this on means customers get two.
              </span>
            </span>
          </label>

          {webhookUrl ? (
            <div>
              <label className="block text-xs text-parchment/50 mb-1">
                Webhook URL, paste into Acuity → Integrations → Webhooks
              </label>
              <div className="flex gap-2">
                <input readOnly value={webhookUrl} className={inputClass} />
                <Button type="button" variant="secondary" size="sm" onClick={copyWebhookUrl}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[11px] text-parchment/40 mt-1">
                Optional. Bookings still reach your coworker within about a minute without
                it; the webhook just makes them instant.
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
            <label className="block text-xs text-parchment/50 mb-1">User ID</label>
            <input
              className={inputClass}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="From Acuity → Integrations → API"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-parchment/50 mb-1">API Key</label>
            <input
              className={inputClass}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                connection?.has_api_key ? "Leave blank to keep the stored key" : "Required"
              }
              required={!connection?.has_api_key}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={saving}>
              {connection ? "Save" : "Connect Acuity"}
            </Button>
            {connection ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-parchment/40">
            Both values are on your own Acuity account under Integrations → API. Nothing
            needs approval from Acuity.
          </p>
        </form>
      )}
    </Card>
  );
}
