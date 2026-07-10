"use client";

/**
 * Direct Calendly connection card for /dashboard/integrations.
 *
 * The zero-setup sibling of the Nango OAuth path: the owner pastes a
 * Personal Access Token (Calendly → Integrations & apps → API & webhooks)
 * and the server verifies it end-to-end, storing the connected account's
 * name/email for display. Once connected, the coworker can offer the
 * account's Calendly availability and text single-use booking links —
 * a Calendly booking is always completed by the customer on Calendly's
 * page, so the agent never claims a confirmed time.
 *
 * API contract (/api/integrations/calendly):
 *   GET    ?businessId=…            (state, masked)
 *   POST   {businessId, accessToken?}   (create/rotate + verify)
 *   DELETE {businessId}
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type CalendlyConnection = {
  id: string;
  business_id: string;
  account_name: string | null;
  account_email: string | null;
  is_active: boolean;
  has_token: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialConnection: CalendlyConnection | null;
};

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

export function CalendlyIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<CalendlyConnection | null>(initialConnection);
  const [accessToken, setAccessToken] = useState("");
  const [showForm, setShowForm] = useState(initialConnection === null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function save() {
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/calendly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {})
        })
      });
      const json = (await res.json()) as {
        data?: { connection?: CalendlyConnection; verified?: boolean };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not save the connection");
        return;
      }
      setConnection(json.data?.connection ?? null);
      setAccessToken("");
      setShowForm(false);
      setBanner(
        json.data?.verified
          ? null
          : "Saved, but Calendly rejected the token — double-check it and make sure it " +
              "was created with the user profile, event types, and scheduling links scopes."
      );
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/calendly", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
        setAccessToken("");
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

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Calendly</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Let your coworker offer your Calendly availability and text customers a
            booking link — they confirm the time on your Calendly page.
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
              "Personal Access Token stored."
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(true)}>
              Update token
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
            <label className="block text-xs text-parchment/50 mb-1">
              Personal Access Token
            </label>
            <input
              className={inputClass}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={
                connection?.has_token
                  ? "Leave blank to keep the stored token"
                  : "From Calendly → Integrations & apps → API & webhooks"
              }
              required={!connection?.has_token}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={saving}>
              {connection ? "Save" : "Connect Calendly"}
            </Button>
            {connection ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-parchment/40">
            Create a token in Calendly under Integrations &amp; apps → API &amp; webhooks →
            &quot;Get a token now&quot;. Any Calendly plan works. When Calendly asks which
            permissions (scopes) to grant, include{" "}
            <span className="text-parchment/60">user profile (read)</span>,{" "}
            <span className="text-parchment/60">event types (read)</span>, and{" "}
            <span className="text-parchment/60">scheduling links (write)</span> — a token
            without them will fail verification here.
          </p>
        </form>
      )}
    </Card>
  );
}
