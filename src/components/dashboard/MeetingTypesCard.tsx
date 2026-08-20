"use client";

/**
 * The meetings a business offers: "Discovery call, 45 min", "Support call,
 * 30 min, always Ana".
 *
 * This is the centerpiece of the Bookings page, modeled on Calendly's event
 * types list: a scannable row per meeting carrying the actions owners reach
 * for (copy its link, view it, turn it off), with everything else behind an
 * inline expand. Each meeting is its own shareable link showing only that
 * meeting, so copying is the primary action, not a detail.
 *
 * Questions live HERE, per meeting, with no inheritance switch to reason
 * about: a meeting has a list, and an empty list means it asks nothing.
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
  /** Null only on rows predating this UI; the dashboard always writes a list. */
  intake_questions: IntakeQuestion[] | null;
  /** Null = whoever the shared setting names. */
  assignment_mode: string | null;
  employee_id: string | null;
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
  roster,
  inheritedQuestions,
  refreshKey = 0
}: {
  businessId: string;
  /** The page's vanity slug or token: the first segment of every meeting URL. */
  pageRef: string | null;
  roster: RosterMember[];
  /**
   * What a meeting with a null list is actually asking today: storage keeps
   * null for rows that predate per-meeting questions, and the public page
   * resolves those from the page. Showing them empty would let the first
   * edit drop questions the owner never saw.
   */
  inheritedQuestions: IntakeQuestion[];
  /**
   * Bumped by the Bookings page once its own load finishes, which is where
   * a first-view page and its default meeting are provisioned. Without it
   * this list can answer before that provision lands and show the empty
   * state until a manual refresh.
   */
  refreshKey?: number;
}) {
  const t = useTranslations("dashboard.bookings");
  const [types, setTypes] = useState<MeetingTypeRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const api = `/api/dashboard/booking-page/meeting-types?businessId=${encodeURIComponent(businessId)}`;

  // Reads can overlap (the first mount, then the refreshKey bump, then a
  // save), and the older one is not always the first to answer. Only the
  // newest read may paint, or an empty pre-provision response could land
  // last and blank a list that really has meetings in it.
  const readSeq = useRef(0);
  const paintedSeq = useRef(0);
  /** Answers the fetched list, since React state is not readable yet. */
  const load = useCallback(async (): Promise<MeetingTypeRow[] | null> => {
    const seq = ++readSeq.current;
    try {
      const res = await fetch(api);
      const body = await res.json();
      if (!res.ok || !body.ok) {
        if (seq >= paintedSeq.current) setError(t("saveFailed"));
        return null;
      }
      const fetched = body.data.meetingTypes as MeetingTypeRow[];
      if (seq >= paintedSeq.current) {
        paintedSeq.current = seq;
        setTypes(fetched);
        // A good read clears whatever the last bad one complained about.
        setError(null);
      }
      return fetched;
    } catch {
      if (seq >= paintedSeq.current) setError(t("saveFailed"));
      return null;
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** One write, answering the list it produced (null when it was refused). */
  const send = useCallback(
    async (init: RequestInit, url = api): Promise<MeetingTypeRow[] | null> => {
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
          return null;
        }
        return await load();
      } catch {
        setError(t("saveFailed"));
        return null;
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

  // Question edits are serialized per meeting and expressed as MUTATIONS of
  // the latest acknowledged list: two blur saves in flight must compose
  // rather than clobber each other.
  const typesRef = useRef<MeetingTypeRow[] | null>(null);
  typesRef.current = types;
  const pendingRef = useRef<Record<string, IntakeQuestion[]>>({});
  const inheritedRef = useRef<IntakeQuestion[]>(inheritedQuestions);
  inheritedRef.current = inheritedQuestions;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const patchQuestionsFor = useCallback(
    (id: string) => (mutate: (questions: IntakeQuestion[]) => IntakeQuestion[]) => {
      queueRef.current = queueRef.current.then(async () => {
        const stored = typesRef.current?.find((x) => x.id === id);
        const base =
          pendingRef.current[id] ?? stored?.intake_questions ?? inheritedRef.current;
        const next = mutate(base);
        pendingRef.current[id] = next;
        const saved = await patchType(id, { intakeQuestions: next });
        // A refused save resyncs the next edit from what the server holds.
        if (!saved) delete pendingRef.current[id];
      });
    },
    [patchType]
  );

  const meetingUrl = useCallback(
    (type: MeetingTypeRow) => {
      const origin = typeof window === "undefined" ? "" : window.location.origin;
      return `${origin}/book/${pageRef}/${type.slug}`;
    },
    [pageRef]
  );

  const copyLink = useCallback(
    async (type: MeetingTypeRow) => {
      if (!pageRef) return;
      try {
        await navigator.clipboard.writeText(meetingUrl(type));
        setCopiedId(type.id);
        window.setTimeout(() => setCopiedId(null), 1500);
      } catch {
        // Clipboard denied: the full link is visible in the expanded row.
      }
    },
    [pageRef, meetingUrl]
  );

  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const field =
    "mt-1 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment";
  const action =
    "rounded-md border border-parchment/25 px-2.5 py-1 text-xs text-parchment/80 transition-colors hover:border-parchment/50 disabled:opacity-40";

  const list = types ?? [];

  return (
    <div className="rounded-lg border border-parchment/15 bg-ink-800/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-parchment">{t("meetingsTitle")}</h2>
        <p className="text-xs text-parchment/40">{t("meetingsHint")}</p>
      </div>
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

      {types !== null && list.length === 0 ? (
        <p className="mt-4 rounded-md border border-parchment/15 bg-deep-ink/40 px-4 py-6 text-center text-sm text-parchment/50">
          {t("meetingsEmpty")}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {list.map((type) => {
          const open = openId === type.id;
          return (
            <li
              key={type.id}
              className={`rounded-md border border-parchment/15 bg-deep-ink/60 ${type.enabled ? "" : "opacity-60"}`}
            >
              {/* The scannable row: what the meeting is, then the actions
                  owners reach for. Everything else is behind Edit. */}
              <div className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-semibold text-parchment">{type.name}</p>
                  <p className="mt-0.5 text-xs text-parchment/50">
                    {type.duration_minutes} {t("minutes")}
                    {type.hidden ? ` · ${t("meetingHiddenBadge")}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={action}
                  disabled={saving || !pageRef}
                  onClick={() => void copyLink(type)}
                >
                  {copiedId === type.id ? t("copied") : t("meetingCopyLink")}
                </button>
                {pageRef ? (
                  <a
                    className={action}
                    href={`/book/${pageRef}/${type.slug}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("meetingView")}
                  </a>
                ) : null}
                <button
                  type="button"
                  className={action}
                  onClick={() => setOpenId(open ? null : type.id)}
                >
                  {open ? t("meetingDone") : t("meetingEdit")}
                </button>
                <label className="flex items-center gap-2 text-xs text-parchment/70">
                  <input
                    type="checkbox"
                    checked={type.enabled}
                    disabled={saving}
                    onChange={(e) => void patchType(type.id, { enabled: e.target.checked })}
                  />
                  {t("meetingEnabled")}
                </label>
              </div>

              {open ? (
                <div className="border-t border-parchment/10 p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-48 flex-1">
                      <label className={label} htmlFor={`mt-name-${type.id}`}>
                        {t("meetingNameLabel")}
                      </label>
                      <input
                        id={`mt-name-${type.id}`}
                        key={type.name}
                        className={`${field} w-full`}
                        maxLength={120}
                        defaultValue={type.name}
                        disabled={saving}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          // A blank name cannot save; show the stored one.
                          if (!name) e.target.value = type.name;
                          else if (name !== type.name) void patchType(type.id, { name });
                        }}
                      />
                    </div>
                    <div>
                      <label className={label} htmlFor={`mt-duration-${type.id}`}>
                        {t("meetingDurationLabel")}
                      </label>
                      <select
                        id={`mt-duration-${type.id}`}
                        className={field}
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
                            {d} {t("minutes")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label} htmlFor={`mt-assign-${type.id}`}>
                        {t("meetingAssignLabel")}
                      </label>
                      <select
                        id={`mt-assign-${type.id}`}
                        className={field}
                        disabled={saving}
                        value={type.assignment_mode ?? "inherit"}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const assignmentMode = raw === "inherit" ? null : raw;
                          // A fixed meeting needs a name, so default to the
                          // first teammate rather than saving a mode that
                          // cannot work.
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
                        <option value="broadcast" disabled={roster.length === 0}>
                          {t("assignModeBroadcast")}
                        </option>
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
                          className={field}
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
                  </div>

                  <div className="mt-3">
                    <label className={label} htmlFor={`mt-desc-${type.id}`}>
                      {t("meetingDescriptionLabel")}
                    </label>
                    <textarea
                      id={`mt-desc-${type.id}`}
                      key={type.description ?? ""}
                      className={`${field} w-full`}
                      rows={2}
                      maxLength={500}
                      placeholder={t("meetingDescriptionPlaceholder")}
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
                    <div className="min-w-48 flex-1">
                      <label className={label} htmlFor={`mt-slug-${type.id}`}>
                        {t("meetingLinkLabel")}
                      </label>
                      <input
                        id={`mt-slug-${type.id}`}
                        key={type.slug}
                        className={`${field} w-full`}
                        maxLength={60}
                        defaultValue={type.slug}
                        disabled={saving}
                        onBlur={(e) => {
                          const slug = slugify(e.target.value);
                          if (!slug) e.target.value = type.slug;
                          else if (slug !== type.slug) void patchType(type.id, { slug });
                        }}
                      />
                      {pageRef ? (
                        <p className="mt-1 truncate text-xs text-parchment/40">
                          {meetingUrl(type)}
                        </p>
                      ) : null}
                    </div>
                    {/* Hidden is the "unlisted" case: the direct link still
                        works, it just never shows on the scheduling page. */}
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

                  <div className="mt-4 border-t border-parchment/10 pt-3">
                    <p className="text-sm text-parchment/70">{t("meetingQuestionsLabel")}</p>
                    <p className="mt-0.5 text-xs text-parchment/40">{t("meetingQuestionsHint")}</p>
                    <IntakeQuestionsEditor
                      questions={type.intake_questions ?? inheritedQuestions}
                      saving={saving}
                      idPrefix={`mt-${type.id}`}
                      onChange={patchQuestionsFor(type.id)}
                    />
                  </div>

                  <div className="mt-4 border-t border-parchment/10 pt-3">
                    <button
                      type="button"
                      className="text-sm text-red-400/80 hover:text-red-400 disabled:opacity-40"
                      // The last meeting stays: deleting it would leave a
                      // scheduling page with nothing to book.
                      disabled={saving || list.length <= 1}
                      onClick={() => {
                        if (!window.confirm(t("meetingRemoveConfirm"))) return;
                        setOpenId(null);
                        void send({ method: "DELETE" }, `${api}&id=${encodeURIComponent(type.id)}`);
                      }}
                    >
                      {t("meetingRemove")}
                    </button>
                    {list.length <= 1 ? (
                      <p className="mt-1 text-xs text-parchment/40">{t("meetingRemoveLast")}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {list.length < MAX_MEETING_TYPES ? (
        <button
          type="button"
          className="mt-4 rounded-md border border-parchment/25 px-3 py-1.5 text-sm text-parchment/80 hover:border-parchment/50"
          disabled={saving}
          onClick={async () => {
            const name = t("meetingNewName");
            // Unique by construction so a second "New meeting" does not
            // collide with the first.
            const slug = `${slugify(name)}-${Date.now().toString(36).slice(-4)}`;
            const created = await send({
              method: "POST",
              body: JSON.stringify({ name, slug, durationMinutes: 30, intakeQuestions: [] })
            });
            // Open it immediately: a row called "New meeting" is not a
            // finished thought, and naming it is the next step. The id comes
            // from the response, since the state holding it is not readable
            // until React re-renders.
            if (created) setOpenId(created.find((x) => x.slug === slug)?.id ?? null);
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
