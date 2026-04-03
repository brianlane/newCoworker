"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { NotificationPreferencesRow } from "@/lib/db/notification-preferences";

type Props = {
  businessId: string;
  initial: NotificationPreferencesRow;
};

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        type="checkbox"
        className="mt-1 rounded border-parchment/30 bg-deep-ink text-signal-teal focus:ring-signal-teal"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span>
        <span className="text-sm font-medium text-parchment block">{label}</span>
        <span className="text-xs text-parchment/45">{description}</span>
      </span>
    </label>
  );
}

export function NotificationPreferences({ businessId, initial }: Props) {
  const [smsUrgent, setSmsUrgent] = useState(initial.sms_urgent);
  const [emailDigest, setEmailDigest] = useState(initial.email_digest);
  const [emailUrgent, setEmailUrgent] = useState(initial.email_urgent);
  const [dashboardAlerts, setDashboardAlerts] = useState(initial.dashboard_alerts);
  const [phone, setPhone] = useState(initial.phone_number ?? "");
  const [alertEmail, setAlertEmail] = useState(initial.alert_email ?? "");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setSmsUrgent(initial.sms_urgent);
    setEmailDigest(initial.email_digest);
    setEmailUrgent(initial.email_urgent);
    setDashboardAlerts(initial.dashboard_alerts);
    setPhone(initial.phone_number ?? "");
    setAlertEmail(initial.alert_email ?? "");
  }, [initial]);

  async function save() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          sms_urgent: smsUrgent,
          email_digest: emailDigest,
          email_urgent: emailUrgent,
          dashboard_alerts: dashboardAlerts,
          phone_number: phone.trim() || null,
          alert_email: alertEmail.trim() || ""
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error?.message ?? "Save failed");
        return;
      }
      setMessage("Saved");
      setTimeout(() => setMessage(null), 2500);
    } catch {
      setMessage("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <ToggleRow
          label="SMS — urgent alerts"
          description="Text when your coworker flags something critical."
          checked={smsUrgent}
          onChange={setSmsUrgent}
          disabled={loading}
        />
        <ToggleRow
          label="Email — daily digest"
          description="Summary of activity sent to your inbox."
          checked={emailDigest}
          onChange={setEmailDigest}
          disabled={loading}
        />
        <ToggleRow
          label="Email — urgent alerts"
          description="Immediate email for high-priority events."
          checked={emailUrgent}
          onChange={setEmailUrgent}
          disabled={loading}
        />
        <ToggleRow
          label="Dashboard alerts"
          description="Show notifications inside this dashboard."
          checked={dashboardAlerts}
          onChange={setDashboardAlerts}
          disabled={loading}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Alert phone (SMS)"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1…"
          disabled={loading}
        />
        <Input
          label="Alert email"
          type="email"
          value={alertEmail}
          onChange={(e) => setAlertEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={loading}
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Button type="button" onClick={save} loading={loading}>
          Save preferences
        </Button>
        {message && (
          <span
            className={
              message === "Saved" ? "text-sm text-claw-green" : "text-sm text-spark-orange"
            }
          >
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
