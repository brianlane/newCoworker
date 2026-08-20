"use client";

/**
 * Bookings dashboard manager: the public booking link (create, enable,
 * copy, rotate), its availability policy knobs, and the upcoming-bookings
 * list from the booking ledger.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarFeedCard } from "@/components/dashboard/CalendarFeedCard";
import { type IntakeQuestion } from "@/components/dashboard/IntakeQuestionsEditor";
import { MeetingTypesCard } from "@/components/dashboard/MeetingTypesCard";
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
  slug: string | null;
  send_confirmation_email: boolean;
  reminders_enabled: boolean;
  reminder_email_hours: number;
  reminder_sms_hours: number;
  assignment_mode: string;
  employee_id: string | null;
  notify_assignee: boolean;
  intake_questions: IntakeQuestion[];
};



type RosterMember = { id: string; name: string };

type UpcomingRow = {
  attendee_key: string;
  start_at: string;
  zoom_meeting_id: string | null;
  meet_join_url: string | null;
};

type LoadState = {
  page: PageRow | null;
  calendarProvider: string | null;
  availability: "ok" | "unreadable" | "unsupported" | "not_connected";
  upcoming: UpcomingRow[];
  roster: RosterMember[];
  /**
   * Set when the roster is exactly one ACTIVE member who is provably the
   * business owner (the #1500 implicit-owner rule). Display-only: it swaps
   * the assignment hint to say every booking lands with them; the stored
   * mode is never auto-changed.
   */
  implicitOwner: { id: string; name: string } | null;
};

const NOTICE_CHOICES = [0, 60, 120, 240, 1440];
const ADVANCE_CHOICES = [7, 14, 30, 60];
const BUFFER_CHOICES = [0, 10, 15, 30];
const WAITLIST_TTL_CHOICES = [15, 30, 60, 120, 240];
/** Reminder lead times, in hours. 0 turns that channel off. */
const REMINDER_HOUR_CHOICES = [0, 2, 4, 24, 48];

export function BookingPageManager({ businessId }: { businessId: string }) {
  const t = useTranslations("dashboard.bookings");
  const [state, setState] = useState<LoadState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Both start closed: the meetings list IS the page, and these are
  // settings an owner visits rarely.
  const [linkOpen, setLinkOpen] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [meetingsKey, setMeetingsKey] = useState(0);

  const api = `/api/dashboard/booking-page?businessId=${encodeURIComponent(businessId)}`;

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetch(api);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error("load failed");
      setState(body.data as LoadState);
      // This load is where a first-view page and its default meeting are
      // provisioned, so the meetings list has to re-read after it: its own
      // fetch runs in parallel and can answer before the provision lands.
      setMeetingsKey((n) => n + 1);
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
          return false;
        }
        setState((prev) => (prev ? { ...prev, page: body.data.page as PageRow } : prev));
        return true;
      } catch {
        setSaveError(t("saveFailed"));
        return false;
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
    // The vanity slug is the shareable link when set; the token URL keeps
    // working either way.
    return `${origin}/book/${state.page.slug ?? state.page.token}`;
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
      <div className="space-y-6">
        <Card>
          <p className="text-sm text-red-400">{t("loadFailed")}</p>
        </Card>
        {/* The feed is served by its own endpoint; a failed booking-page
            read must not hide the one bookings surface that works for
            every tenant. */}
        <CalendarFeedCard businessId={businessId} />
      </div>
    );
  }
  if (!state) {
    return (
      <Card>
        <p className="text-sm text-parchment/50">{t("loading")}</p>
      </Card>
    );
  }

  // Only Vagaro/Calendly are unsupported (their real book lives on their
  // own pages). NO connection is fully supported: platform mode, where the
  // booking ledger is the calendar of record.
  const unsupportedProvider =
    state.calendarProvider === "vagaro" ||
    state.calendarProvider === "acuity" ||
    state.calendarProvider === "calendly";
  const platformMode = state.calendarProvider === null;
  const page = state.page;
  const roster = state.roster ?? [];

  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const select =
    "mt-1 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment";
  const textField =
    "mt-1 w-full rounded-md border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment placeholder:text-parchment/30";

  return (
    <div className="space-y-6">
      {!unsupportedProvider && !platformMode && state.availability === "unreadable" ? (
        <Card>
          <h2 className="text-base font-semibold text-red-400">
            {t("calendarUnreadableTitle")}
          </h2>
          <p className="mt-2 text-sm text-parchment/60">{t("calendarUnreadableBody")}</p>
          <Link
            // Straight to the tile that owns the unreadable calendar. Google
            // and Microsoft split off the old combined workspace page, so
            // sending both there would land half of these owners on a page
            // that no longer lists their connection.
            href={`/dashboard/integrations/${
              state.calendarProvider === "caldav"
                ? "caldav"
                : state.calendarProvider === "microsoft"
                  ? "microsoft"
                  : "google"
            }`}
            className="mt-3 inline-block text-sm text-claw-green hover:underline"
          >
            {t("calendarUnreadableAction")}
          </Link>
        </Card>
      ) : null}

      {unsupportedProvider ? (
        <Card>
          <h2 className="text-base font-semibold text-parchment">{t("connectFirstTitle")}</h2>
          <p className="mt-2 text-sm text-parchment/60">
            {state.calendarProvider === "vagaro"
              ? t("vagaroNote")
              : state.calendarProvider === "acuity"
                ? t("acuityNote")
                : t("calendlyNote")}
          </p>
          <Link
            href="/dashboard/integrations"
            className="mt-3 inline-block text-sm text-claw-green hover:underline"
          >
            {t("goToIntegrations")}
          </Link>
        </Card>
      ) : null}

      {platformMode ? (
        <Card>
          <h2 className="text-base font-semibold text-parchment">{t("platformModeTitle")}</h2>
          <p className="mt-2 text-sm text-parchment/60">{t("platformModeBody")}</p>
          <Link
            href="/dashboard/integrations"
            className="mt-3 inline-block text-sm text-claw-green hover:underline"
          >
            {t("goToIntegrations")}
          </Link>
        </Card>
      ) : null}

      {/* The scheduling link itself, on one line: the meetings below are
          what owners actually manage. Slug, blurb, and the rotate button sit
          behind Customize so they stop competing with them. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-parchment">{t("linkTitle")}</h2>
            <p className="mt-1 text-sm text-parchment/60">{t("linkSubtitle")}</p>
          </div>
          {page ? (
            <label className="flex items-center gap-2 text-sm text-parchment/70">
              <input
                type="checkbox"
                checked={page.enabled}
                disabled={saving || unsupportedProvider}
                onChange={(e) => void patch({ enabled: e.target.checked })}
              />
              {t("enabledToggle")}
            </label>
          ) : null}
        </div>

        {/* The dashboard endpoint auto-provisions the page on first view,
            so `page` is only null for Vagaro/Calendly tenants; the
            connect-first card above already explains that state. */}
        {page ? (
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
                onClick={() => setLinkOpen(!linkOpen)}
                className="rounded-md border border-parchment/20 px-3 py-2 text-xs text-parchment/60 hover:border-parchment/40"
              >
                {linkOpen ? t("customizeDone") : t("customizeLink")}
              </button>
            </div>

            {linkOpen ? (
              <div className="space-y-4 border-t border-parchment/10 pt-4">
                {/* No heading field: visitors read the business name and the
                    meeting's own name, so a page-level heading had nowhere
                    left to render. */}
                <div>
                  <label className={label} htmlFor="bp-slug">
                    {t("slugLabel")}
                  </label>
                  <input
                    id="bp-slug"
                    type="text"
                    maxLength={60}
                    placeholder={t("slugPlaceholder")}
                    className={textField}
                    defaultValue={page.slug ?? ""}
                    disabled={saving}
                    onBlur={(e) => {
                      const raw = e.target.value.trim().toLowerCase();
                      if (raw === (page.slug ?? "")) return;
                      void patch({ slug: raw === "" ? null : raw });
                    }}
                  />
                  <p className="mt-1 text-xs text-parchment/40">{t("slugHint")}</p>
                </div>
                <div>
                  <label className={label} htmlFor="bp-desc">
                    {t("descriptionLabel")}
                  </label>
                  <textarea
                    id="bp-desc"
                    rows={2}
                    maxLength={500}
                    placeholder={t("descriptionPlaceholder")}
                    className={textField}
                    defaultValue={page.description ?? ""}
                    disabled={saving}
                    onBlur={(e) => void patch({ description: e.target.value })}
                  />
                </div>
                <div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void rotate()}
                    className="rounded-md border border-parchment/20 px-3 py-2 text-xs text-parchment/60 hover:border-parchment/40"
                  >
                    {t("rotateLink")}
                  </button>
                  <p className="mt-1 text-xs text-parchment/40">{t("rotateHint")}</p>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
      </Card>

      {/* The meetings themselves: each one its own shareable link showing
          only that meeting. This is what owners came here to manage. */}
      <MeetingTypesCard
        businessId={businessId}
        pageRef={page ? (page.slug ?? page.token) : null}
        roster={roster}
        inheritedQuestions={page?.intake_questions ?? []}
        refreshKey={meetingsKey}
      />

      {/* Everything below applies to EVERY meeting, which is why it is one
          collapsed section instead of four cards competing with the list
          above. */}
      <div className="rounded-lg border border-parchment/15 bg-ink-800/40">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
          onClick={() => setSharedOpen(!sharedOpen)}
        >
          <span>
            <span className="block text-base font-semibold text-parchment">
              {t("sharedTitle")}
            </span>
            <span className="mt-1 block text-sm text-parchment/60">{t("sharedSubtitle")}</span>
          </span>
          <span className="whitespace-nowrap text-xs text-parchment/50">
            {sharedOpen ? t("sharedHide") : t("sharedShow")}
          </span>
        </button>
        {sharedOpen ? (
          <div className="space-y-6 px-5 pb-5">
            {/* When people can book: the window every meeting is offered in. */}
            <Card>
              <h2 className="text-base font-semibold text-parchment">{t("rulesTitle")}</h2>
              <p className="mt-1 text-sm text-parchment/60">{t("rulesSubtitle")}</p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className={label} htmlFor="bp-notice">
                    {t("noticeLabel")}
                  </label>
                  <select
                    id="bp-notice"
                    className={select}
                    disabled={saving}
                    value={page?.min_notice_minutes ?? 120}
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
                    value={page?.max_advance_days ?? 14}
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
                    value={page?.buffer_minutes ?? 0}
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
                    // Number inputs get a narrow intrinsic width that clips
                    // the "Unlimited" placeholder; fill the grid cell.
                    className={`${select} w-full`}
                    disabled={saving}
                    defaultValue={page?.max_daily_bookings ?? ""}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      void patch({ maxDailyBookings: raw === "" ? null : Number(raw) });
                    }}
                  />
                </div>
                <div className="flex items-end sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm text-parchment/70">
                    <input
                      type="checkbox"
                      checked={page?.require_staff_on_shift ?? false}
                      disabled={saving}
                      onChange={(e) => void patch({ requireStaffOnShift: e.target.checked })}
                    />
                    {t("staffGateLabel")}
                  </label>
                </div>
              </div>
            </Card>

            {/* Who bookings go to. Availability follows the answer: an
                assigned page must never offer a time nobody who could take
                it is working. */}
            <Card>
              <h2 className="text-base font-semibold text-parchment">{t("assignTitle")}</h2>
              <p className="mt-1 text-sm text-parchment/60">{t("assignSubtitle")}</p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="bp-assign-mode">
                    {t("assignModeLabel")}
                  </label>
                  <select
                    id="bp-assign-mode"
                    className={select}
                    disabled={saving}
                    value={page?.assignment_mode ?? "any"}
                    onChange={(e) => {
                      const mode = e.target.value;
                      // A fixed page needs a name, so default to the first
                      // teammate rather than saving a mode that cannot work.
                      const employeeId =
                        mode === "fixed" && !page?.employee_id ? (roster[0]?.id ?? null) : undefined;
                      void patch({
                        assignmentMode: mode,
                        ...(employeeId === undefined ? {} : { employeeId })
                      });
                    }}
                  >
                    <option value="any">{t("assignModeAny")}</option>
                    <option value="round_robin" disabled={roster.length === 0}>
                      {t("assignModeRoundRobin")}
                    </option>
                    <option value="fixed" disabled={roster.length === 0}>
                      {t("assignModeFixed")}
                    </option>
                  </select>
                </div>
                {page?.assignment_mode === "fixed" ? (
                  <div>
                    <label className={label} htmlFor="bp-assign-employee">
                      {t("assignEmployeeLabel")}
                    </label>
                    <select
                      id="bp-assign-employee"
                      className={select}
                      disabled={saving}
                      value={page.employee_id ?? ""}
                      onChange={(e) => void patch({ employeeId: e.target.value || null })}
                    >
                      {roster.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
              {page && page.assignment_mode !== "any" ? (
                <label className="mt-4 flex items-center gap-2 text-sm text-parchment/70">
                  <input
                    type="checkbox"
                    checked={page.notify_assignee}
                    disabled={saving}
                    onChange={(e) => void patch({ notifyAssignee: e.target.checked })}
                  />
                  {t("assignNotifyLabel")}
                </label>
              ) : null}
              <p className="mt-3 text-xs text-parchment/40">
                {roster.length === 0
                  ? t("assignNoRoster")
                  : state.implicitOwner
                    ? t("assignSoloHint")
                    : t("assignHint")}
              </p>
            </Card>

            {/* Confirmations and reminders: what the visitor hears after booking.
                The confirmation carries what a bare calendar invite cannot (both
                clocks, the video link, the manage link), and the reminders are the
                part that actually reduces no-shows. */}
            <Card>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-parchment">{t("remindersTitle")}</h2>
                  <p className="mt-1 text-sm text-parchment/60">{t("remindersSubtitle")}</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-parchment/70">
                  <input
                    type="checkbox"
                    checked={page ? page.reminders_enabled : true}
                    disabled={saving}
                    onChange={(e) => void patch({ remindersEnabled: e.target.checked })}
                  />
                  {t("remindersToggle")}
                </label>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-parchment/70">
                    <input
                      type="checkbox"
                      checked={page ? page.send_confirmation_email : true}
                      disabled={saving}
                      onChange={(e) => void patch({ sendConfirmationEmail: e.target.checked })}
                    />
                    {t("confirmationEmailLabel")}
                  </label>
                </div>
                <div>
                  <label className={label} htmlFor="bp-reminder-email">
                    {t("reminderEmailLabel")}
                  </label>
                  <select
                    id="bp-reminder-email"
                    className={select}
                    disabled={saving || (page ? !page.reminders_enabled : false)}
                    value={page?.reminder_email_hours ?? 24}
                    onChange={(e) => void patch({ reminderEmailHours: Number(e.target.value) })}
                  >
                    {REMINDER_HOUR_CHOICES.map((h) => (
                      <option key={h} value={h}>
                        {h === 0 ? t("reminderOff") : t("reminderHoursBefore", { hours: h })}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="bp-reminder-sms">
                    {t("reminderSmsLabel")}
                  </label>
                  <select
                    id="bp-reminder-sms"
                    className={select}
                    disabled={saving || (page ? !page.reminders_enabled : false)}
                    value={page?.reminder_sms_hours ?? 2}
                    onChange={(e) => void patch({ reminderSmsHours: Number(e.target.value) })}
                  >
                    {REMINDER_HOUR_CHOICES.map((h) => (
                      <option key={h} value={h}>
                        {h === 0 ? t("reminderOff") : t("reminderHoursBefore", { hours: h })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="mt-3 text-xs text-parchment/40">{t("remindersHint")}</p>
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
          </div>
        ) : null}
      </div>

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
                  {/* Which video product, not merely that there is one: the
                      owner joining the call needs to know which app opens.
                      Mutually exclusive by construction, since a booking gets
                      Zoom or Meet, never both. */}
                  {b.zoom_meeting_id || b.meet_join_url ? (
                    <span className="rounded-full border border-claw-green/40 px-2 py-0.5 text-[10px] uppercase text-claw-green">
                      {b.zoom_meeting_id ? t("zoomBadge") : t("meetBadge")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Provider-agnostic on purpose: Vagaro/Acuity tenants see the
          connect-first card above INSTEAD of the page manager, and this
          subscribable link is exactly what still works for them. */}
      <CalendarFeedCard businessId={businessId} />
    </div>
  );
}
