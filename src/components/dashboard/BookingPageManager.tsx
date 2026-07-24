"use client";

/**
 * Bookings dashboard manager: the public booking link (create, enable,
 * copy, rotate), its availability policy knobs, and the upcoming-bookings
 * list from the booking ledger.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";

type PageRow = {
  token: string;
  enabled: boolean;
  allowed_durations: number[];
  min_notice_minutes: number;
  max_advance_days: number;
  buffer_minutes: number;
  max_daily_bookings: number | null;
  require_staff_on_shift: boolean;
  description: string | null;
  waitlist_enabled: boolean;
  waitlist_offer_ttl_minutes: number;
};

type UpcomingRow = {
  attendee_key: string;
  start_at: string;
  zoom_meeting_id: string | null;
};

type LoadState = {
  page: PageRow | null;
  calendarProvider: string | null;
  upcoming: UpcomingRow[];
};

const DURATION_CHOICES = [15, 30, 60];
const NOTICE_CHOICES = [0, 60, 120, 240, 1440];
const ADVANCE_CHOICES = [7, 14, 30, 60];
const BUFFER_CHOICES = [0, 10, 15, 30];
const WAITLIST_TTL_CHOICES = [15, 30, 60, 120, 240];

export function BookingPageManager({ businessId }: { businessId: string }) {
  const t = useTranslations("dashboard.bookings");
  const [state, setState] = useState<LoadState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const api = `/api/dashboard/booking-page?businessId=${encodeURIComponent(businessId)}`;

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetch(api);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error("load failed");
      setState(body.data as LoadState);
    } catch {
      setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (fields: Record<string, unknown>) => {
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(api, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields)
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          setSaveError(body?.error?.message ?? t("saveFailed"));
          return;
        }
        setState((prev) => (prev ? { ...prev, page: body.data.page as PageRow } : prev));
      } catch {
        setSaveError(t("saveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [api, t]
  );

  const rotate = useCallback(async () => {
    if (!window.confirm(t("rotateConfirm"))) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate" })
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setSaveError(body?.error?.message ?? t("saveFailed"));
        return;
      }
      setState((prev) => (prev ? { ...prev, page: body.data.page as PageRow } : prev));
    } catch {
      setSaveError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [api, t]);

  const publicUrl = useMemo(() => {
    if (!state?.page) return null;
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}/book/${state.page.token}`;
  }, [state?.page]);

  const copyLink = useCallback(async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the URL is visible and selectable next to the button.
    }
  }, [publicUrl]);

  if (loadFailed) {
    return (
      <Card>
        <p className="text-sm text-red-400">{t("loadFailed")}</p>
      </Card>
    );
  }
  if (!state) {
    return (
      <Card>
        <p className="text-sm text-parchment/50">{t("loading")}</p>
      </Card>
    );
  }

  const directBooking =
    state.calendarProvider !== null &&
    state.calendarProvider !== "vagaro" &&
    state.calendarProvider !== "calendly";
  const page = state.page;

  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const select =
    "mt-1 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment";

  return (
    <div className="space-y-6">
      {!directBooking ? (
        <Card>
          <h2 className="text-base font-semibold text-parchment">{t("connectFirstTitle")}</h2>
          <p className="mt-2 text-sm text-parchment/60">
            {state.calendarProvider === "vagaro"
              ? t("vagaroNote")
              : state.calendarProvider === "calendly"
                ? t("calendlyNote")
                : t("connectFirstBody")}
          </p>
          <Link
            href="/dashboard/integrations"
            className="mt-3 inline-block text-sm text-claw-green hover:underline"
          >
            {t("goToIntegrations")}
          </Link>
        </Card>
      ) : null}

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-parchment">{t("linkTitle")}</h2>
            <p className="mt-1 text-sm text-parchment/60">{t("linkSubtitle")}</p>
          </div>
          {page ? (
            <label className="flex items-center gap-2 text-sm text-parchment/70">
              <input
                type="checkbox"
                checked={page.enabled}
                disabled={saving || !directBooking}
                onChange={(e) => void patch({ enabled: e.target.checked })}
              />
              {t("enabledToggle")}
            </label>
          ) : null}
        </div>

        {!page ? (
          <button
            type="button"
            disabled={saving || !directBooking}
            onClick={() => void patch({ enabled: true })}
            className="mt-4 rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink hover:bg-opacity-90 disabled:opacity-50"
          >
            {t("createLink")}
          </button>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-parchment/15 bg-deep-ink px-3 py-2 text-xs text-parchment/80">
                {publicUrl}
              </code>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="rounded-md border border-claw-green/50 px-3 py-2 text-xs text-claw-green hover:bg-claw-green/10"
              >
                {copied ? t("copied") : t("copyLink")}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void rotate()}
                className="rounded-md border border-parchment/20 px-3 py-2 text-xs text-parchment/60 hover:border-parchment/40"
              >
                {t("rotateLink")}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <span className={label}>{t("durationsLabel")}</span>
                <div className="mt-1 flex gap-3">
                  {DURATION_CHOICES.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-sm text-parchment/70">
                      <input
                        type="checkbox"
                        checked={page.allowed_durations.includes(d)}
                        disabled={saving}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...page.allowed_durations, d].sort((a, b) => a - b)
                            : page.allowed_durations.filter((x) => x !== d);
                          if (next.length === 0) return;
                          void patch({ allowedDurations: next });
                        }}
                      />
                      {d} {t("minutes")}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className={label} htmlFor="bp-notice">
                  {t("noticeLabel")}
                </label>
                <select
                  id="bp-notice"
                  className={select}
                  disabled={saving}
                  value={page.min_notice_minutes}
                  onChange={(e) => void patch({ minNoticeMinutes: Number(e.target.value) })}
                >
                  {NOTICE_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {m === 0
                        ? t("noticeNone")
                        : m < 1440
                          ? t("noticeHours", { hours: m / 60 })
                          : t("noticeDay")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="bp-advance">
                  {t("advanceLabel")}
                </label>
                <select
                  id="bp-advance"
                  className={select}
                  disabled={saving}
                  value={page.max_advance_days}
                  onChange={(e) => void patch({ maxAdvanceDays: Number(e.target.value) })}
                >
                  {ADVANCE_CHOICES.map((d) => (
                    <option key={d} value={d}>
                      {t("advanceDays", { days: d })}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="bp-buffer">
                  {t("bufferLabel")}
                </label>
                <select
                  id="bp-buffer"
                  className={select}
                  disabled={saving}
                  value={page.buffer_minutes}
                  onChange={(e) => void patch({ bufferMinutes: Number(e.target.value) })}
                >
                  {BUFFER_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t("bufferNone") : `${m} ${t("minutes")}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="bp-cap">
                  {t("dailyCapLabel")}
                </label>
                <input
                  id="bp-cap"
                  type="number"
                  min={1}
                  max={100}
                  placeholder={t("dailyCapUnlimited")}
                  className={select}
                  disabled={saving}
                  defaultValue={page.max_daily_bookings ?? ""}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    void patch({ maxDailyBookings: raw === "" ? null : Number(raw) });
                  }}
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-parchment/70">
                  <input
                    type="checkbox"
                    checked={page.require_staff_on_shift}
                    disabled={saving}
                    onChange={(e) => void patch({ requireStaffOnShift: e.target.checked })}
                  />
                  {t("staffGateLabel")}
                </label>
              </div>
            </div>

            <div>
              <label className={label} htmlFor="bp-desc">
                {t("descriptionLabel")}
              </label>
              <textarea
                id="bp-desc"
                rows={2}
                maxLength={500}
                className="mt-1 w-full rounded-md border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment"
                defaultValue={page.description ?? ""}
                disabled={saving}
                onBlur={(e) => void patch({ description: e.target.value })}
              />
            </div>
          </div>
        )}
        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
      </Card>

      {/* Cancellation waitlist: independent of the public link, it also
          covers waitlist entries the AI coworker takes over SMS/voice.
          A missing settings row reads as the defaults (on, 60 min hold);
          the first toggle write creates the row. */}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-parchment">{t("waitlistTitle")}</h2>
            <p className="mt-1 text-sm text-parchment/60">{t("waitlistSubtitle")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={page ? page.waitlist_enabled : true}
              disabled={saving}
              onChange={(e) => void patch({ waitlistEnabled: e.target.checked })}
            />
            {t("waitlistToggle")}
          </label>
        </div>
        <div className="mt-4">
          <label className={label} htmlFor="bp-waitlist-ttl">
            {t("waitlistTtlLabel")}
          </label>
          <select
            id="bp-waitlist-ttl"
            className={select}
            disabled={saving || (page ? !page.waitlist_enabled : false)}
            value={page?.waitlist_offer_ttl_minutes ?? 60}
            onChange={(e) => void patch({ waitlistOfferTtlMinutes: Number(e.target.value) })}
          >
            {WAITLIST_TTL_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} ${t("minutes")}` : t("waitlistTtlHours", { hours: m / 60 })}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-parchment/40">{t("waitlistHint")}</p>
        </div>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-parchment">{t("upcomingTitle")}</h2>
        {state.upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-parchment/50">{t("upcomingEmpty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-parchment/10">
            {state.upcoming.map((b) => (
              <li
                key={`${b.attendee_key}-${b.start_at}`}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="truncate text-parchment/80">
                  {b.attendee_key.replace(/^(phone|email):/, "")}
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap text-parchment/60">
                  {new Date(b.start_at).toLocaleString()}
                  {b.zoom_meeting_id ? (
                    <span className="rounded-full border border-claw-green/40 px-2 py-0.5 text-[10px] uppercase text-claw-green">
                      {t("zoomBadge")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
