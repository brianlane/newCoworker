"use client";

/**
 * The meeting types under a booking calendar: "Discovery call, 60 min",
 * "Support call, 30 min, questionnaire, always Ana".
 *
 * Each type is its own shareable link (/book/<page>/<slug>) rendering that
 * meeting alone, so the copy-link button per row is the primary action
 * here, not a detail. Everything a type does not define inherits from the
 * page, which is why the assignment and questions controls default to an
 * explicit "same as the page" rather than to a value.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  IntakeQuestionsEditor,
  type IntakeQuestion
} from "@/components/dashboard/IntakeQuestionsEditor";

export type MeetingTypeRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  /** Null = inherit the page's questions. */
  intake_questions: IntakeQuestion[] | null;
  /** Null = inherit the page's assignment. */
  assignment_mode: string | null;
  employee_id: string | null;
  payment_required: boolean;
  payment_amount_cents: number | null;
  payment_currency: string;
  enabled: boolean;
  hidden: boolean;
  sort_order: number;
};

type RosterMember = { id: string; name: string };

const DURATION_CHOICES = [15, 20, 30, 45, 60, 90, 120];
const MAX_MEETING_TYPES = 10;

/** "Discovery call" -> "discovery-call", the link owners never have to type. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function MeetingTypesCard({
  businessId,
  pageRef,
  roster
}: {
  businessId: string;
  /** The page's vanity slug or token: the first segment of every type URL. */
  pageRef: string | null;
  roster: RosterMember[];
}) {
  const t = useTranslations("dashboard.bookings");
  const [types, setTypes] = useState<MeetingTypeRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const api = `/api/dashboard/booking-page/meeting-types?businessId=${encodeURIComponent(
    businessId
  )}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(api);
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(t("saveFailed"));
        return;
      }
      setTypes(body.data.meetingTypes as MeetingTypeRow[]);
    } catch {
      setError(t("saveFailed"));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One write. Answers whether it landed so the caller can decide whether
   * to keep building on its optimistic list.
   */
  const send = useCallback(
    async (init: RequestInit, url = api): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(url, {
          headers: { "Content-Type": "application/json" },
          ...init
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          setError(body?.error?.message ?? t("saveFailed"));
          return false;
        }
        await load();
        return true;
      } catch {
        setError(t("saveFailed"));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [api, load, t]
  );

  const patchType = useCallback(
    (id: string, patch: Record<string, unknown>) =>
      send({ method: "PATCH", body: JSON.stringify(patch) }, `${api}&id=${encodeURIComponent(id)}`),
    [api, send]
  );

  // Question edits are serialized per type and expressed as mutations of
  // the latest acknowledged list, the same rule the page's own questions
  // follow: two blur saves in flight must compose, not clobber.
  const typesRef = useRef<MeetingTypeRow[] | null>(null);
  typesRef.current = types;
  const pendingRef = useRef<Record<string, IntakeQuestion[] | null>>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const patchQuestionsFor = useCallback(
    (id: string, pageQuestions: IntakeQuestion[]) =>
      (mutate: (questions: IntakeQuestion[]) => IntakeQuestion[]) => {
        queueRef.current = queueRef.current.then(async () => {
          const stored = typesRef.current?.find((x) => x.id === id);
          const base =
            pendingRef.current[id] ?? stored?.intake_questions ?? pageQuestions;
          const next = mutate(base);
          pendingRef.current[id] = next;
          const saved = await patchType(id, { intakeQuestions: next });
          if (!saved) delete pendingRef.current[id];
        });
      },
    [patchType]
  );

  const copyLink = useCallback(
    async (type: MeetingTypeRow) => {
      if (!pageRef) return;
      const origin = typeof window === "undefined" ? "" : window.location.origin;
      try {
        await navigator.clipboard.writeText(`${origin}/book/${pageRef}/${type.slug}`);
        setCopiedId(type.id);
        window.setTimeout(() => setCopiedId(null), 1500);
      } catch {
        // Clipboard denied: the slug is visible and selectable beside it.
      }
    },
    [pageRef]
  );

  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const select =
    "mt-1 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment";

  const list = types ?? [];

  return (
    <div className="rounded-lg border border-parchment/15 bg-ink-800/60 p-5">
      <h2 className="text-base font-semibold text-parchment">{t("meetingTypesTitle")}</h2>
      <p className="mt-1 text-sm text-parchment/60">{t("meetingTypesSubtitle")}</p>
      {error ? <p className="mt-3 text-sm text-clay-red">{error}</p> : null}

      <div className="mt-4 space-y-4">
        {list.map((type) => (
          <div
            key={type.id}
            className={`rounded-md border border-parchment/15 bg-deep-ink/60 p-4 ${
              type.enabled ? "" : "opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label className={label} htmlFor={`mt-name-${type.id}`}>
                  {t("meetingNameLabel")}
                </label>
                <input
                  id={`mt-name-${type.id}`}
                  key={type.name}
                  className={`${select} w-full`}
                  maxLength={120}
                  defaultValue={type.name}
                  disabled={saving}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== type.name) void patchType(type.id, { name });
                    // A blank name cannot save; show the stored one again.
                    else if (!name) e.target.value = type.name;
                  }}
                />
              </div>
              <div>
                <label className={label} htmlFor={`mt-duration-${type.id}`}>
                  {t("meetingDurationLabel")}
                </label>
                <select
                  id={`mt-duration-${type.id}`}
                  className={select}
                  disabled={saving}
                  value={type.duration_minutes}
                  onChange={(e) =>
                    void patchType(type.id, { durationMinutes: Number(e.target.value) })
                  }
                >
                  {(DURATION_CHOICES.includes(type.duration_minutes)
                    ? DURATION_CHOICES
                    : [type.duration_minutes, ...DURATION_CHOICES]
                  ).map((d) => (
                    <option key={d} value={d}>
                      {d} {t("meetingMinutes")}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  checked={type.enabled}
                  disabled={saving}
                  onChange={(e) => void patchType(type.id, { enabled: e.target.checked })}
                />
                {t("meetingEnabled")}
              </label>
              {/* Hidden is the "secret event": the direct link still works,
                  it just never shows on the page's menu. */}
              <label className="flex items-center gap-2 pb-1.5 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  checked={type.hidden}
                  disabled={saving}
                  onChange={(e) => void patchType(type.id, { hidden: e.target.checked })}
                />
                {t("meetingHidden")}
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label className={label} htmlFor={`mt-slug-${type.id}`}>
                  {t("meetingLinkLabel")}
                </label>
                <input
                  id={`mt-slug-${type.id}`}
                  key={type.slug}
                  className={`${select} w-full`}
                  maxLength={60}
                  defaultValue={type.slug}
                  disabled={saving}
                  onBlur={(e) => {
                    const slug = slugify(e.target.value);
                    if (slug && slug !== type.slug) void patchType(type.id, { slug });
                    else if (!slug) e.target.value = type.slug;
                  }}
                />
              </div>
              <button
                type="button"
                className="rounded-md border border-parchment/25 px-3 py-1.5 text-sm text-parchment/80 hover:border-parchment/50"
                disabled={saving || !pageRef}
                onClick={() => void copyLink(type)}
              >
                {copiedId === type.id ? t("copied") : t("meetingCopyLink")}
              </button>
              <button
                type="button"
                className="pb-1.5 text-sm text-clay-red/80 hover:text-clay-red"
                disabled={saving}
                onClick={() => {
                  if (!window.confirm(t("meetingRemoveConfirm"))) return;
                  void send(
                    { method: "DELETE" },
                    `${api}&id=${encodeURIComponent(type.id)}`
                  );
                }}
              >
                {t("meetingRemove")}
              </button>
            </div>

            <div className="mt-3">
              <label className={label} htmlFor={`mt-desc-${type.id}`}>
                {t("meetingDescriptionLabel")}
              </label>
              <textarea
                id={`mt-desc-${type.id}`}
                key={type.description ?? ""}
                className={`${select} w-full`}
                rows={2}
                maxLength={500}
                defaultValue={type.description ?? ""}
                disabled={saving}
                onBlur={(e) => {
                  const description = e.target.value.trim() || null;
                  if (description !== type.description) {
                    void patchType(type.id, { description });
                  }
                }}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label className={label} htmlFor={`mt-assign-${type.id}`}>
                  {t("meetingAssignLabel")}
                </label>
                <select
                  id={`mt-assign-${type.id}`}
                  className={select}
                  disabled={saving}
                  value={type.assignment_mode ?? "inherit"}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const assignmentMode = raw === "inherit" ? null : raw;
                    // A fixed meeting needs a name, so default to the first
                    // teammate rather than saving a mode that cannot work.
                    const employeeId =
                      assignmentMode === "fixed" && !type.employee_id
                        ? (roster[0]?.id ?? null)
                        : undefined;
                    void patchType(type.id, {
                      assignmentMode,
                      ...(employeeId === undefined ? {} : { employeeId })
                    });
                  }}
                >
                  <option value="inherit">{t("meetingAssignInherit")}</option>
                  <option value="any">{t("assignModeAny")}</option>
                  <option value="round_robin" disabled={roster.length === 0}>
                    {t("assignModeRoundRobin")}
                  </option>
                  <option value="fixed" disabled={roster.length === 0}>
                    {t("assignModeFixed")}
                  </option>
                </select>
              </div>
              {type.assignment_mode === "fixed" ? (
                <div>
                  <label className={label} htmlFor={`mt-employee-${type.id}`}>
                    {t("assignEmployeeLabel")}
                  </label>
                  <select
                    id={`mt-employee-${type.id}`}
                    className={select}
                    disabled={saving}
                    value={type.employee_id ?? ""}
                    onChange={(e) =>
                      void patchType(type.id, { employeeId: e.target.value || null })
                    }
                  >
                    {roster.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label className={label} htmlFor={`mt-price-${type.id}`}>
                  {t("meetingPriceLabel")}
                </label>
                <input
                  id={`mt-price-${type.id}`}
                  key={String(type.payment_amount_cents ?? "")}
                  className={select}
                  inputMode="decimal"
                  placeholder={t("meetingPriceFree")}
                  defaultValue={
                    type.payment_amount_cents === null
                      ? ""
                      : (type.payment_amount_cents / 100).toFixed(2)
                  }
                  disabled={saving}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    if (!raw) {
                      // Clearing the price also turns payment off, or the
                      // pair rule would refuse the write.
                      if (type.payment_amount_cents !== null) {
                        void patchType(type.id, {
                          paymentRequired: false,
                          paymentAmountCents: null
                        });
                      }
                      return;
                    }
                    const cents = Math.round(Number(raw) * 100);
                    if (!Number.isFinite(cents) || cents <= 0) {
                      e.target.value =
                        type.payment_amount_cents === null
                          ? ""
                          : (type.payment_amount_cents / 100).toFixed(2);
                      return;
                    }
                    if (cents !== type.payment_amount_cents) {
                      void patchType(type.id, {
                        paymentAmountCents: cents,
                        paymentRequired: true
                      });
                    }
                  }}
                />
              </div>
            </div>

            <div className="mt-4 border-t border-parchment/10 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-parchment/70">{t("meetingQuestionsLabel")}</p>
                <label className="flex items-center gap-2 text-sm text-parchment/70">
                  <input
                    type="checkbox"
                    checked={type.intake_questions !== null}
                    disabled={saving}
                    onChange={(e) =>
                      void patchType(type.id, {
                        // Unchecking restores inheritance of the page's
                        // questions rather than deleting anything.
                        intakeQuestions: e.target.checked ? [] : null
                      })
                    }
                  />
                  {t("meetingQuestionsOwn")}
                </label>
              </div>
              {type.intake_questions === null ? (
                <p className="mt-2 text-xs text-parchment/40">{t("meetingQuestionsInherit")}</p>
              ) : (
                <IntakeQuestionsEditor
                  questions={type.intake_questions}
                  saving={saving}
                  idPrefix={`mt-${type.id}`}
                  onChange={patchQuestionsFor(type.id, [])}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {list.length < MAX_MEETING_TYPES ? (
        <button
          type="button"
          className="mt-4 rounded-md border border-parchment/25 px-3 py-1.5 text-sm text-parchment/80 hover:border-parchment/50"
          disabled={saving}
          onClick={() => {
            const name = t("meetingNewName");
            // Unique by construction so a second "New meeting" does not
            // collide with the first.
            const slug = `${slugify(name)}-${Date.now().toString(36).slice(-4)}`;
            void send({
              method: "POST",
              body: JSON.stringify({ name, slug, durationMinutes: 30 })
            });
          }}
        >
          {t("meetingAdd")}
        </button>
      ) : (
        <p className="mt-4 text-xs text-parchment/40">{t("meetingMax")}</p>
      )}
    </div>
  );
}
