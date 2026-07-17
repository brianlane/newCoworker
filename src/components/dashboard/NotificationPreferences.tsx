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
  const [whatsappUrgent, setWhatsappUrgent] = useState(initial.whatsapp_urgent ?? true);
  const [emailDigest, setEmailDigest] = useState(initial.email_digest);
  const [emailDigestWeekly, setEmailDigestWeekly] = useState(initial.email_digest_weekly);
  const [emailUrgent, setEmailUrgent] = useState(initial.email_urgent);
  const [dashboardAlerts, setDashboardAlerts] = useState(initial.dashboard_alerts);
  const [smsWarmTransfer, setSmsWarmTransfer] = useState(initial.sms_warm_transfer);
  const [imageLimitAlerts, setImageLimitAlerts] = useState(initial.image_limit_alerts);
  const [aiflowFailureAlerts, setAiflowFailureAlerts] = useState(
    initial.aiflow_failure_alerts ?? false
  );
  const [categoryLeads, setCategoryLeads] = useState(initial.category_leads ?? true);
  const [categoryTeam, setCategoryTeam] = useState(initial.category_team ?? true);
  const [categorySystem, setCategorySystem] = useState(initial.category_system ?? true);
  const [phone, setPhone] = useState(initial.phone_number ?? "");
  const [alertEmail, setAlertEmail] = useState(initial.alert_email ?? "");
  const [digestEmailDaily, setDigestEmailDaily] = useState(initial.digest_email_daily ?? "");
  const [digestEmailWeekly, setDigestEmailWeekly] = useState(initial.digest_email_weekly ?? "");
  const [unsubscribedAt, setUnsubscribedAt] = useState<string | null>(initial.unsubscribed_at);
  const [loading, setLoading] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const [confirmingUnsub, setConfirmingUnsub] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setSmsUrgent(initial.sms_urgent);
    setWhatsappUrgent(initial.whatsapp_urgent ?? true);
    setEmailDigest(initial.email_digest);
    setEmailDigestWeekly(initial.email_digest_weekly);
    setEmailUrgent(initial.email_urgent);
    setDashboardAlerts(initial.dashboard_alerts);
    setSmsWarmTransfer(initial.sms_warm_transfer);
    setImageLimitAlerts(initial.image_limit_alerts);
    setAiflowFailureAlerts(initial.aiflow_failure_alerts ?? false);
    setCategoryLeads(initial.category_leads ?? true);
    setCategoryTeam(initial.category_team ?? true);
    setCategorySystem(initial.category_system ?? true);
    setPhone(initial.phone_number ?? "");
    setAlertEmail(initial.alert_email ?? "");
    setDigestEmailDaily(initial.digest_email_daily ?? "");
    setDigestEmailWeekly(initial.digest_email_weekly ?? "");
    setUnsubscribedAt(initial.unsubscribed_at);
  }, [initial]);

  function applyResponse(prefs: NotificationPreferencesRow) {
    setSmsUrgent(prefs.sms_urgent);
    setWhatsappUrgent(prefs.whatsapp_urgent ?? true);
    setEmailDigest(prefs.email_digest);
    setEmailDigestWeekly(prefs.email_digest_weekly);
    setEmailUrgent(prefs.email_urgent);
    setDashboardAlerts(prefs.dashboard_alerts);
    setSmsWarmTransfer(prefs.sms_warm_transfer);
    setImageLimitAlerts(prefs.image_limit_alerts);
    setAiflowFailureAlerts(prefs.aiflow_failure_alerts ?? false);
    setCategoryLeads(prefs.category_leads ?? true);
    setCategoryTeam(prefs.category_team ?? true);
    setCategorySystem(prefs.category_system ?? true);
    setPhone(prefs.phone_number ?? "");
    setAlertEmail(prefs.alert_email ?? "");
    setDigestEmailDaily(prefs.digest_email_daily ?? "");
    setDigestEmailWeekly(prefs.digest_email_weekly ?? "");
    setUnsubscribedAt(prefs.unsubscribed_at);
  }

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
          whatsapp_urgent: whatsappUrgent,
          email_digest: emailDigest,
          email_digest_weekly: emailDigestWeekly,
          email_urgent: emailUrgent,
          dashboard_alerts: dashboardAlerts,
          sms_warm_transfer: smsWarmTransfer,
          image_limit_alerts: imageLimitAlerts,
          aiflow_failure_alerts: aiflowFailureAlerts,
          category_leads: categoryLeads,
          category_team: categoryTeam,
          category_system: categorySystem,
          phone_number: phone.trim() || null,
          alert_email: alertEmail.trim() || "",
          digest_email_daily: digestEmailDaily.trim() || "",
          digest_email_weekly: digestEmailWeekly.trim() || ""
        })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setMessage(json.error?.message ?? "Save failed");
        return;
      }
      applyResponse(json.data as NotificationPreferencesRow);
      setMessage("Saved");
      setTimeout(() => setMessage(null), 2500);
    } catch {
      setMessage("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function unsubscribeAll() {
    setUnsubscribing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          sms_urgent: false,
          whatsapp_urgent: false,
          email_digest: false,
          email_digest_weekly: false,
          email_urgent: false,
          dashboard_alerts: false,
          sms_warm_transfer: false,
          image_limit_alerts: false,
          aiflow_failure_alerts: false,
          unsubscribed_at: "now"
        })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setMessage(json.error?.message ?? "Unsubscribe failed");
        return;
      }
      applyResponse(json.data as NotificationPreferencesRow);
      setConfirmingUnsub(false);
      setMessage("Unsubscribed from all notifications");
      setTimeout(() => setMessage(null), 4000);
    } catch {
      setMessage("Network error");
    } finally {
      setUnsubscribing(false);
    }
  }

  return (
    <div className="space-y-6">
      {unsubscribedAt && (
        <div
          data-testid="unsubscribed-banner"
          className="rounded-lg border border-spark-orange/30 bg-spark-orange/10 px-4 py-3 text-sm text-parchment/80"
        >
          You unsubscribed on {new Date(unsubscribedAt).toLocaleDateString()}. Re-enable any
          channel below to start receiving notifications again.
        </div>
      )}

      <div className="space-y-4">
        <ToggleRow
          label="SMS: urgent alerts"
          description="Text when your coworker flags something critical."
          checked={smsUrgent}
          onChange={setSmsUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="WhatsApp: urgent alerts"
          description="Also deliver urgent alerts on WhatsApp (requires the WhatsApp integration under Integrations)."
          checked={whatsappUrgent}
          onChange={setWhatsappUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Email: daily digest"
          description="Summary of activity sent to your inbox each morning."
          checked={emailDigest}
          onChange={setEmailDigest}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Email: weekly digest"
          description="Roll-up of the past week's activity, sent Monday mornings."
          checked={emailDigestWeekly}
          onChange={setEmailDigestWeekly}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Email: urgent alerts"
          description="Immediate email for high-priority events."
          checked={emailUrgent}
          onChange={setEmailUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Dashboard alerts"
          description="Show notifications inside this dashboard."
          checked={dashboardAlerts}
          onChange={setDashboardAlerts}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Warm transfer SMS"
          description="Text the recipient (and you) when a call is warm-transferred to a person."
          checked={smsWarmTransfer}
          onChange={setSmsWarmTransfer}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Image limit alerts"
          description="Alert you when a coworker hits its image generation limit (3 per conversation)."
          checked={imageLimitAlerts}
          onChange={setImageLimitAlerts}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="AiFlow failure alerts"
          description="Alert you when a lead-intake AiFlow run fails permanently, so a dead automation is never silent. Off unless you opt in."
          checked={aiflowFailureAlerts}
          onChange={setAiflowFailureAlerts}
          disabled={loading || unsubscribing}
        />
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Alert categories</h3>
          <p className="text-xs text-parchment/45">
            Choose which kinds of events reach you. Generic urgent alerts always come through.
          </p>
        </div>
        <ToggleRow
          label="New leads"
          description="When your coworker captures a new lead's contact details."
          checked={categoryLeads}
          onChange={setCategoryLeads}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Team activity"
          description="When your coworker notifies or routes work to a team member."
          checked={categoryTeam}
          onChange={setCategoryTeam}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="System events"
          description="Platform events like number-port progress."
          checked={categorySystem}
          onChange={setCategorySystem}
          disabled={loading || unsubscribing}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Alert phone (SMS)"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1…"
          disabled={loading || unsubscribing}
        />
        <Input
          label="Alert email"
          type="email"
          value={alertEmail}
          onChange={(e) => setAlertEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={loading || unsubscribing}
        />
        <Input
          label="Daily digest email (optional)"
          type="email"
          value={digestEmailDaily}
          onChange={(e) => setDigestEmailDaily(e.target.value)}
          placeholder={alertEmail.trim() || "defaults to alert email"}
          disabled={loading || unsubscribing}
        />
        <Input
          label="Weekly digest email (optional)"
          type="email"
          value={digestEmailWeekly}
          onChange={(e) => setDigestEmailWeekly(e.target.value)}
          placeholder={alertEmail.trim() || "defaults to alert email"}
          disabled={loading || unsubscribing}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} loading={loading} disabled={unsubscribing}>
          Save preferences
        </Button>
        {!confirmingUnsub ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmingUnsub(true)}
            disabled={loading || unsubscribing}
          >
            Unsubscribe from all
          </Button>
        ) : (
          <div
            data-testid="unsubscribe-confirm"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-parchment"
          >
            <span>Stop all email and SMS alerts?</span>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={unsubscribeAll}
              loading={unsubscribing}
            >
              Yes, unsubscribe
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingUnsub(false)}
              disabled={unsubscribing}
            >
              Cancel
            </Button>
          </div>
        )}
        {message && (
          <span
            className={
              message === "Saved" || message.startsWith("Unsubscribed")
                ? "text-sm text-claw-green"
                : "text-sm text-spark-orange"
            }
          >
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
