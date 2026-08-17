"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  businessId: string;
  initialEnabled: boolean;
};

/**
 * Google Meet on/off, rendered inside the Google integration card.
 *
 * Deliberately not its own integration tile: Meet has nothing to connect. It
 * rides the Google Calendar grant the tenant already has, so a Connect button
 * would be a lie and a "disconnected" status would be meaningless. What the
 * owner actually decides is whether appointments booked onto that calendar
 * get a video link, which is one switch.
 *
 * Optimistic flip with rollback, matching the auto-import switch on
 * ZoomIntegrationCard: the write is a single boolean, so waiting on the round
 * trip would make the control feel broken for no added safety.
 */
export function GoogleMeetToggle({ businessId, initialEnabled }: Props) {
  const t = useTranslations("dashboard.integrationsGoogleMeet");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setError(null);
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/google-meet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enabled: next })
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setEnabled(!next);
        setError(json?.error?.message ?? t("saveFailed"));
      }
    } catch {
      setEnabled(!next);
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-parchment/10 bg-parchment/[0.02] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-parchment">{t("title")}</p>
          <p className="text-[11px] text-parchment/40 mt-0.5">{t("hint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("title")}
          disabled={saving}
          onClick={() => toggle(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-claw-green" : "bg-parchment/20"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-deep-ink transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      <p className="text-[11px] text-parchment/40 mt-3">{t("zoomPrecedence")}</p>
      {error ? <p className="text-[11px] text-red-300 mt-2">{error}</p> : null}
    </div>
  );
}
