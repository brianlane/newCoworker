"use client";

/**
 * Direct CalDAV connection card for /dashboard/integrations.
 *
 * The zero-OAuth calendar path for iCloud (and Nextcloud / any CalDAV
 * server): the owner pastes the server URL, username, and an app-specific
 * password; the server verifies the credentials with a full CalDAV
 * discovery walk and remembers the event calendar bookings land on. Once
 * connected, the coworker runs REAL availability searches and creates REAL
 * events on that calendar.
 *
 * API contract (/api/integrations/caldav):
 *   GET    ?businessId=…                              (state, masked)
 *   POST   {businessId, serverUrl?, username?, password?}  (create/rotate + verify)
 *   DELETE {businessId}
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type CaldavConnection = {
  id: string;
  business_id: string;
  server_url: string;
  username: string;
  calendar_url: string | null;
  calendar_name: string | null;
  is_active: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialConnection: CaldavConnection | null;
};

const ICLOUD_SERVER_URL = "https://caldav.icloud.com";

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

export function CaldavIntegrationCard({ businessId, initialConnection }: Props) {
  const [connection, setConnection] = useState<CaldavConnection | null>(initialConnection);
  const [serverUrl, setServerUrl] = useState(initialConnection?.server_url ?? ICLOUD_SERVER_URL);
  const [username, setUsername] = useState(initialConnection?.username ?? "");
  const [password, setPassword] = useState("");
  const [showForm, setShowForm] = useState(initialConnection === null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function save() {
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/caldav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          ...(serverUrl.trim() ? { serverUrl: serverUrl.trim() } : {}),
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(password.trim() ? { password: password.trim() } : {})
        })
      });
      const json = (await res.json()) as {
        data?: { connection?: CaldavConnection; verified?: boolean };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not save the connection");
        return;
      }
      setConnection(json.data?.connection ?? null);
      setPassword("");
      setShowForm(false);
      setBanner(
        json.data?.verified
          ? null
          : "Saved, but the CalDAV server rejected the credentials — for iCloud, use an " +
              "app-specific password from appleid.apple.com (not your Apple ID password)."
      );
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/caldav", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) {
        setConnection(null);
        setServerUrl(ICLOUD_SERVER_URL);
        setUsername("");
        setPassword("");
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
          <h3 className="text-sm font-semibold text-parchment">Apple iCloud / CalDAV</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Connect an iCloud, Nextcloud, or any CalDAV calendar so your coworker can
            check real availability and book appointments straight onto it.
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
            Linked to <span className="text-parchment/90">{connection.username}</span>
            <span className="text-parchment/40"> · {connection.server_url}</span>
            {connection.calendar_name ? (
              <>
                {" "}
                — bookings land on{" "}
                <span className="text-parchment/90">{connection.calendar_name}</span>
              </>
            ) : null}
          </div>
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
            <label className="block text-xs text-parchment/50 mb-1">Server URL</label>
            <input
              className={inputClass}
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={ICLOUD_SERVER_URL}
              required
            />
          </div>
          <div>
            <label className="block text-xs text-parchment/50 mb-1">Username</label>
            <input
              className={inputClass}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@icloud.com"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-parchment/50 mb-1">
              App-specific password
            </label>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                connection?.has_password
                  ? "Leave blank to keep the stored password"
                  : "For iCloud: appleid.apple.com → App-Specific Passwords"
              }
              required={!connection?.has_password}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={saving}>
              {connection ? "Save" : "Connect calendar"}
            </Button>
            {connection ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-parchment/40">
            For iCloud: sign in at appleid.apple.com → Sign-In and Security →
            App-Specific Passwords → generate one for &quot;NewCoworker&quot;, and use your
            Apple ID email as the username with server {ICLOUD_SERVER_URL}. Your real Apple
            ID password never works here and is never stored.
          </p>
        </form>
      )}
    </Card>
  );
}
