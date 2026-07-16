"use client";

/**
 * Admin per-business notification mutes.
 *
 * Three switches that hide this business from the fleet-wide feeds on
 * /admin/dashboard (Recent Activity / System Errors / Recent Alerts).
 * Muting is admin-side noise control only: rows are still written, this
 * business's own admin page keeps showing everything, and owner-facing
 * notifications are untouched.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function NotificationMutesPanel({
  businessId,
  initialMuteActivity,
  initialMuteErrors,
  initialMuteAlerts
}: {
  businessId: string;
  initialMuteActivity: boolean;
  initialMuteErrors: boolean;
  initialMuteAlerts: boolean;
}) {
  const router = useRouter();
  const [muteActivity, setMuteActivity] = useState(initialMuteActivity);
  const [muteErrors, setMuteErrors] = useState(initialMuteErrors);
  const [muteAlerts, setMuteAlerts] = useState(initialMuteAlerts);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/notification-mutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, muteActivity, muteErrors, muteAlerts })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setNotice("Mutes saved");
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  const rows: Array<{
    label: string;
    detail: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }> = [
    {
      label: "Mute activity",
      detail: "Hide from the dashboard Recent Activity feed",
      checked: muteActivity,
      onChange: setMuteActivity
    },
    {
      label: "Mute errors",
      detail: "Hide from the dashboard System Errors feed",
      checked: muteErrors,
      onChange: setMuteErrors
    },
    {
      label: "Mute alerts",
      detail: "Hide from the dashboard Recent Alerts feed",
      checked: muteAlerts,
      onChange: setMuteAlerts
    }
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/50">
        Hides this business from the fleet-wide feeds on the admin dashboard. Everything stays
        visible on this page, and owner notifications are unaffected.
      </p>
      <div className="space-y-2">
        {rows.map((row) => (
          <label key={row.label} className="flex items-start gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={row.checked}
              onChange={(e) => row.onChange(e.target.checked)}
            />
            <span>
              {row.label}
              <span className="block text-[11px] text-parchment/40">{row.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <Button size="sm" variant="secondary" onClick={save} loading={saving}>
        Save mutes
      </Button>
      {notice && <p className="text-xs text-claw-green">{notice}</p>}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
