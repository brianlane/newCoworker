"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { NotificationPreferencesRow } from "@/lib/db/notification-preferences";
import { smsReachability } from "@/lib/phone/deliverability";

type Props = {
  businessId: string;
  initial: NotificationPreferencesRow;
  /**
   * Whether the business has a WhatsApp integration connected. Gates the
   * "WhatsApp instead of SMS" toggle (the dispatcher ignores the preference
   * without a connection, so the UI disables it rather than pretend).
   */
  whatsappConnected: boolean;
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

export function NotificationPreferences({ businessId, initial, whatsappConnected }: Props) {
  const [smsUrgent, setSmsUrgent] = useState(initial.sms_urgent);
  const [whatsappUrgent, setWhatsappUrgent] = useState(initial.whatsapp_urgent ?? true);
  const [whatsappReplacesSms, setWhatsappReplacesSms] = useState(
    initial.whatsapp_replaces_sms ?? false
  );
  const [slackUrgent, setSlackUrgent] = useState(initial.slack_urgent ?? true);
  const [telegramUrgent, setTelegramUrgent] = useState(initial.telegram_urgent ?? true);
  const [teamsUrgent, setTeamsUrgent] = useState(initial.teams_urgent ?? true);
  const [googleChatUrgent, setGoogleChatUrgent] = useState(initial.google_chat_urgent ?? true);
  const [slackDigest, setSlackDigest] = useState(initial.slack_digest ?? true);
  const [emailDigest, setEmailDigest] = useState(initial.email_digest);
  const [emailDigestWeekly, setEmailDigestWeekly] = useState(initial.email_digest_weekly);
  const [digestCustomerFacingOnly, setDigestCustomerFacingOnly] = useState(
    initial.digest_customer_facing_only ?? false
  );
  const [emailUrgent, setEmailUrgent] = useState(initial.email_urgent);
  const [dashboardAlerts, setDashboardAlerts] = useState(initial.dashboard_alerts);
  const [smsWarmTransfer, setSmsWarmTransfer] = useState(initial.sms_warm_transfer);
  const [imageLimitAlerts, setImageLimitAlerts] = useState(initial.image_limit_alerts);
  const [aiflowFailureAlerts, setAiflowFailureAlerts] = useState(
    initial.aiflow_failure_alerts ?? false
  );
  const [customerReplyAlerts, setCustomerReplyAlerts] = useState(
    initial.customer_reply_alerts ?? false
  );
  const [unassignedBookingAlerts, setUnassignedBookingAlerts] = useState(
    initial.unassigned_booking_alerts ?? true
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
  const tDeliverability = useTranslations("dashboard.phoneDeliverability");

  // The alert phone is exactly the number that silently goes dark when it
  // is outside NANP (our long codes cannot originate international SMS),
  // so warn as the owner types instead of letting the save succeed quietly.
  const phoneReachability = smsReachability(phone);
  const phoneWarning =
    phoneReachability === "mx"
      ? tDeliverability("smsUnreachableMx")
      : phoneReachability === "international"
        ? tDeliverability("smsUnreachable")
        : null;

  useEffect(() => {
    setSmsUrgent(initial.sms_urgent);
    setWhatsappUrgent(initial.whatsapp_urgent ?? true);
    setWhatsappReplacesSms(initial.whatsapp_replaces_sms ?? false);
    setSlackUrgent(initial.slack_urgent ?? true);
    setTelegramUrgent(initial.telegram_urgent ?? true);
    setTeamsUrgent(initial.teams_urgent ?? true);
    setGoogleChatUrgent(initial.google_chat_urgent ?? true);
    setSlackDigest(initial.slack_digest ?? true);
    setEmailDigest(initial.email_digest);
    setEmailDigestWeekly(initial.email_digest_weekly);
    setDigestCustomerFacingOnly(initial.digest_customer_facing_only ?? false);
    setEmailUrgent(initial.email_urgent);
    setDashboardAlerts(initial.dashboard_alerts);
    setSmsWarmTransfer(initial.sms_warm_transfer);
    setImageLimitAlerts(initial.image_limit_alerts);
    setAiflowFailureAlerts(initial.aiflow_failure_alerts ?? false);
    setCustomerReplyAlerts(initial.customer_reply_alerts ?? false);
    setUnassignedBookingAlerts(initial.unassigned_booking_alerts ?? true);
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
    setWhatsappReplacesSms(prefs.whatsapp_replaces_sms ?? false);
    setSlackUrgent(prefs.slack_urgent ?? true);
    setTelegramUrgent(prefs.telegram_urgent ?? true);
    setTeamsUrgent(prefs.teams_urgent ?? true);
    setGoogleChatUrgent(prefs.google_chat_urgent ?? true);
    setSlackDigest(prefs.slack_digest ?? true);
    setEmailDigest(prefs.email_digest);
    setEmailDigestWeekly(prefs.email_digest_weekly);
    setDigestCustomerFacingOnly(prefs.digest_customer_facing_only ?? false);
    setEmailUrgent(prefs.email_urgent);
    setDashboardAlerts(prefs.dashboard_alerts);
    setSmsWarmTransfer(prefs.sms_warm_transfer);
    setImageLimitAlerts(prefs.image_limit_alerts);
    setAiflowFailureAlerts(prefs.aiflow_failure_alerts ?? false);
    setCustomerReplyAlerts(prefs.customer_reply_alerts ?? false);
    setUnassignedBookingAlerts(prefs.unassigned_booking_alerts ?? true);
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
          whatsapp_replaces_sms: whatsappReplacesSms,
          slack_urgent: slackUrgent,
          telegram_urgent: telegramUrgent,
          teams_urgent: teamsUrgent,
          google_chat_urgent: googleChatUrgent,
          slack_digest: slackDigest,
          email_digest: emailDigest,
          email_digest_weekly: emailDigestWeekly,
          digest_customer_facing_only: digestCustomerFacingOnly,
          email_urgent: emailUrgent,
          dashboard_alerts: dashboardAlerts,
          sms_warm_transfer: smsWarmTransfer,
          image_limit_alerts: imageLimitAlerts,
          aiflow_failure_alerts: aiflowFailureAlerts,
          customer_reply_alerts: customerReplyAlerts,
          unassigned_booking_alerts: unassignedBookingAlerts,
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
          slack_urgent: false,
          telegram_urgent: false,
          teams_urgent: false,
          google_chat_urgent: false,
          slack_digest: false,
          email_digest: false,
          email_digest_weekly: false,
          email_urgent: false,
          dashboard_alerts: false,
          sms_warm_transfer: false,
          image_limit_alerts: false,
          aiflow_failure_alerts: false,
          customer_reply_alerts: false,
          unassigned_booking_alerts: false,
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
          label="WhatsApp instead of SMS"
          description={
            whatsappConnected
              ? "Urgent alerts skip the SMS text and arrive on WhatsApp only. The SMS leg returns automatically if WhatsApp is ever disconnected or its urgent toggle is off."
              : "Connect WhatsApp under Integrations first; until then urgent alerts keep arriving by SMS."
          }
          checked={whatsappReplacesSms}
          onChange={setWhatsappReplacesSms}
          disabled={loading || unsubscribing || !whatsappConnected}
        />
        <ToggleRow
          label="Slack: urgent alerts"
          description="Post urgent alerts to your picked Slack channel (requires the Slack integration under Integrations)."
          checked={slackUrgent}
          onChange={setSlackUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Slack: digests"
          description="Post the daily and weekly digests to the same Slack channel."
          checked={slackDigest}
          onChange={setSlackDigest}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Telegram: urgent alerts"
          description="Send urgent alerts to your business's Telegram bot (requires the Telegram integration under Integrations)."
          checked={telegramUrgent}
          onChange={setTelegramUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Microsoft Teams: urgent alerts"
          description="Send urgent alerts to your Teams conversation (requires the Microsoft Teams integration under Integrations)."
          checked={teamsUrgent}
          onChange={setTeamsUrgent}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Google Chat: urgent alerts"
          description="Send urgent alerts to your Google Chat space (requires the Google Chat integration under Integrations)."
          checked={googleChatUrgent}
          onChange={setGoogleChatUrgent}
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
          label="Digests: customer activity only"
          description="Only send a summary email when customers actually reached your business (texts, calls, new customers, urgent alerts). Skips summaries of routine background work. Off unless you opt in."
          checked={digestCustomerFacingOnly}
          onChange={setDigestCustomerFacingOnly}
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
        <ToggleRow
          label="Client reply alerts"
          description="Alert you the moment a client texts your business number, with a preview of what they said. At most one alert per client every few minutes. Off unless you opt in."
          checked={customerReplyAlerts}
          onChange={setCustomerReplyAlerts}
          disabled={loading || unsubscribing}
        />
        <ToggleRow
          label="Unassigned booking alerts"
          description="Alert you when your AI coworker books an appointment for a lead no teammate owns yet, so someone always shows up. On by default."
          checked={unassignedBookingAlerts}
          onChange={setUnassignedBookingAlerts}
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
        <div>
          <Input
            label="Alert phone (SMS)"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1…"
            disabled={loading || unsubscribing}
          />
          {phoneWarning && (
            <p className="text-xs text-spark-orange mt-1" role="alert">
              {phoneWarning}
            </p>
          )}
          {phoneWarning && !whatsappConnected && (
            <p className="text-xs text-parchment/60 mt-1">
              <Link
                href="/dashboard/integrations/whatsapp"
                className="text-signal-teal hover:underline"
              >
                {tDeliverability("connectWhatsAppCta")}
              </Link>
            </p>
          )}
          {phoneWarning && whatsappConnected && !whatsappReplacesSms && (
            <p className="text-xs text-parchment/60 mt-1">
              {tDeliverability("preferWhatsAppTip")}
            </p>
          )}
        </div>
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
