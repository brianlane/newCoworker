"use client";

/**
 * The intake-question builder, shared by the booking page's own questions
 * and each meeting type's.
 *
 * Extracted so a meeting type's questionnaire behaves identically to the
 * page's, including the two hard-won details:
 *
 *  - edits are expressed as MUTATIONS of the latest acknowledged list and
 *    matched by question id, never by render-time index, so two blur saves
 *    in flight cannot clobber each other (the owner writes the whole list
 *    every time);
 *  - an edit that cannot save (emptied label, fewer than two options)
 *    reverts the field to what is stored, so the input can never show text
 *    the public page is not using.
 *
 * Serialization itself lives with the caller, which owns the save queue.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export type IntakeQuestion = {
  id: string;
  label: string;
  help?: string;
  type: "choice" | "multi" | "text" | "textarea";
  options?: string[];
  required: boolean;
  /** Absent on rows stored before the flag existed, which means asking. */
  enabled?: boolean;
};

/** Booking must stay short, so the builder caps the list. */
export const MAX_INTAKE_QUESTIONS = 5;

export function IntakeQuestionsEditor({
  questions,
  saving,
  idPrefix,
  onChange
}: {
  questions: IntakeQuestion[];
  saving: boolean;
  /** Keeps input ids unique when several editors share one page. */
  idPrefix: string;
  /** Receives a mutation of the CURRENT list, applied by the caller's queue. */
  onChange: (mutate: (questions: IntakeQuestion[]) => IntakeQuestion[]) => void;
}) {
  const t = useTranslations("dashboard.bookings");
  // A new question starts BLANK and local. Pre-filling it with a canned
  // label read as "this pulled in the default question", since it was the
  // same string the page's own default used. Nothing persists until the
  // owner types a label, which parseIntakeQuestions requires anyway.
  const [draft, setDraft] = useState<string | null>(null);
  // Enter commits, and removing the focused input can fire blur on the way
  // out, which would append the same question twice. The latch makes the
  // commit happen once per draft; opening a new one arms it again.
  const draftLive = useRef(false);
  const commitDraft = useCallback(
    (raw: string) => {
      if (!draftLive.current) return;
      draftLive.current = false;
      const text = raw.trim();
      setDraft(null);
      if (!text) return;
      onChange((qs) => [
        ...qs,
        { id: `q-${Date.now().toString(36)}`, label: text, type: "text" as const, required: false, enabled: true }
      ]);
    },
    [onChange]
  );
  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const select =
    "mt-1 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment";

  return (
    <>
      <div className="mt-4 space-y-3">
        {questions.map((q) => (
          <div
            key={q.id}
            className={`rounded-md border border-parchment/15 bg-deep-ink/60 p-3 ${
              q.enabled !== false ? "" : "opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label className={label} htmlFor={`${idPrefix}-q-label-${q.id}`}>
                  {t("intakeQuestionLabel")}
                </label>
                <input
                  id={`${idPrefix}-q-label-${q.id}`}
                  // Keyed on the stored value so a successful save (or a
                  // reverted one) re-renders the input from what is
                  // actually persisted.
                  key={q.label}
                  className={`${select} w-full`}
                  maxLength={160}
                  defaultValue={q.label}
                  disabled={saving}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== q.label) {
                      onChange((qs) =>
                        qs.map((it) => (it.id === q.id ? { ...it, label: next } : it))
                      );
                    } else if (!next) {
                      // An emptied label cannot save; put the stored one back.
                      e.target.value = q.label;
                    }
                  }}
                />
              </div>
              <div>
                <label className={label} htmlFor={`${idPrefix}-q-type-${q.id}`}>
                  {t("intakeTypeLabel")}
                </label>
                <select
                  id={`${idPrefix}-q-type-${q.id}`}
                  className={select}
                  disabled={saving}
                  value={q.type}
                  onChange={(e) => {
                    const type = e.target.value as IntakeQuestion["type"];
                    onChange((qs) =>
                      qs.map((it) =>
                        it.id === q.id
                          ? {
                              ...it,
                              type,
                              // A choice needs options to choose from.
                              options:
                                type === "choice" || type === "multi"
                                  ? (it.options?.length ?? 0) >= 2
                                    ? it.options
                                    : [t("intakeOptionOne"), t("intakeOptionTwo")]
                                  : undefined
                            }
                          : it
                      )
                    );
                  }}
                >
                  <option value="text">{t("intakeTypeText")}</option>
                  <option value="textarea">{t("intakeTypeTextarea")}</option>
                  <option value="choice">{t("intakeTypeChoice")}</option>
                  <option value="multi">{t("intakeTypeMulti")}</option>
                </select>
              </div>
              {/* Pause instead of delete: the question stays saved for the
                  next time it is wanted, and a paused one never reaches
                  the public form. */}
              <label className="flex items-center gap-2 pb-1.5 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  // Same normalization the parser applies: only an explicit
                  // false is paused, so legacy rows show as asking.
                  checked={q.enabled !== false}
                  disabled={saving}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    onChange((qs) =>
                      qs.map((it) => (it.id === q.id ? { ...it, enabled } : it))
                    );
                  }}
                />
                {t("intakeAsk")}
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  checked={q.required}
                  disabled={saving}
                  onChange={(e) => {
                    const required = e.target.checked;
                    onChange((qs) =>
                      qs.map((it) => (it.id === q.id ? { ...it, required } : it))
                    );
                  }}
                />
                {t("intakeRequired")}
              </label>
              <button
                type="button"
                className="pb-1.5 text-sm text-clay-red/80 hover:text-clay-red"
                disabled={saving}
                onClick={() => onChange((qs) => qs.filter((it) => it.id !== q.id))}
              >
                {t("intakeRemove")}
              </button>
            </div>
            {q.type === "choice" || q.type === "multi" ? (
              <div className="mt-2">
                <label className={label} htmlFor={`${idPrefix}-q-options-${q.id}`}>
                  {t("intakeOptionsLabel")}
                </label>
                <input
                  id={`${idPrefix}-q-options-${q.id}`}
                  key={(q.options ?? []).join(", ")}
                  className={`${select} w-full`}
                  disabled={saving}
                  defaultValue={(q.options ?? []).join(", ")}
                  placeholder={t("intakeOptionsPlaceholder")}
                  onBlur={(e) => {
                    const options = e.target.value
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean)
                      .slice(0, 8);
                    if (options.length >= 2) {
                      onChange((qs) =>
                        qs.map((it) => (it.id === q.id ? { ...it, options } : it))
                      );
                    } else {
                      // Fewer than two options is not a choice; revert.
                      e.target.value = (q.options ?? []).join(", ");
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {draft !== null ? (
        <div className="mt-3 rounded-md border border-claw-green/40 bg-deep-ink/60 p-3">
          <label className={label} htmlFor={`${idPrefix}-q-draft`}>
            {t("intakeQuestionLabel")}
          </label>
          <input
            id={`${idPrefix}-q-draft`}
            autoFocus
            className={`${select} w-full`}
            maxLength={160}
            placeholder={t("intakeNewQuestionPlaceholder")}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commitDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter saves, Escape abandons: the row never lingers as an
              // unsaved half-question.
              if (e.key === "Enter") {
                e.preventDefault();
                // The field's own value, not the state behind it: Enter can
                // land before the last keystroke has re-rendered.
                commitDraft(e.currentTarget.value);
              } else if (e.key === "Escape") {
                draftLive.current = false;
                setDraft(null);
              }
            }}
          />
          <p className="mt-1 text-xs text-parchment/40">{t("intakeNewQuestionHint")}</p>
        </div>
      ) : questions.length < MAX_INTAKE_QUESTIONS ? (
        <button
          type="button"
          className="mt-3 rounded-md border border-parchment/25 px-3 py-1.5 text-sm text-parchment/80 hover:border-parchment/50"
          disabled={saving}
          onClick={() => {
            draftLive.current = true;
            setDraft("");
          }}
        >
          {t("intakeAdd")}
        </button>
      ) : (
        <p className="mt-3 text-xs text-parchment/40">{t("intakeMax")}</p>
      )}
    </>
  );
}
