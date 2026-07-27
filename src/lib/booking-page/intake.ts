/**
 * Owner-defined intake questions on the public booking page.
 *
 * The vocabulary is deliberately the white-glove questionnaire's
 * (`choice`, `multi`, `text`, `textarea`): owners already know it, the
 * public form renders it the same way, and there is no second question
 * grammar to maintain.
 *
 * Two validators, two trust levels:
 * - `parseIntakeQuestions` normalizes what the OWNER stored. It is lenient
 *   about junk (a malformed question is dropped, not fatal) because a bad
 *   row in the settings must never take the public page down.
 * - `validateIntakeAnswers` checks what the VISITOR submitted, strictly:
 *   unknown ids are discarded, required questions must be answered, choice
 *   answers must be one of the offered options. It answers field-level
 *   errors so the form can point at the exact question.
 */

export type BookingIntakeQuestionType = "choice" | "multi" | "text" | "textarea";

export type BookingIntakeQuestion = {
  id: string;
  label: string;
  /** Short helper line under the label. */
  help?: string;
  type: BookingIntakeQuestionType;
  /** For choice/multi. */
  options?: string[];
  required: boolean;
  /**
   * Paused questions stay saved but are not asked: an owner who does not
   * want a question before THIS week's calls should not have to retype it
   * next month. Absent on rows stored before the flag existed, which reads
   * as enabled.
   */
  enabled: boolean;
};

/** Owners get a handful, not a form builder: booking must stay short. */
export const MAX_INTAKE_QUESTIONS = 5;
export const MAX_QUESTION_LABEL_LENGTH = 160;
export const MAX_QUESTION_OPTIONS = 8;
export const MAX_OPTION_LENGTH = 80;
/** Visitor answer caps: text answers, and each selected option, fit SMS/notes. */
export const MAX_TEXT_ANSWER_LENGTH = 500;

const QUESTION_TYPES: readonly BookingIntakeQuestionType[] = [
  "choice",
  "multi",
  "text",
  "textarea"
];

const QUESTION_ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Normalize the stored questions column. Junk entries are dropped rather
 * than thrown: settings rot must never take the public page down.
 */
export function parseIntakeQuestions(raw: unknown): BookingIntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const questions: BookingIntakeQuestion[] = [];
  for (const entry of raw) {
    if (questions.length >= MAX_INTAKE_QUESTIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === "string" ? q.id : "";
    const label = typeof q.label === "string" ? q.label.trim() : "";
    const type = q.type as BookingIntakeQuestionType;
    if (!QUESTION_ID_RE.test(id) || seen.has(id)) continue;
    if (!label || label.length > MAX_QUESTION_LABEL_LENGTH) continue;
    if (!QUESTION_TYPES.includes(type)) continue;

    let options: string[] | undefined;
    if (type === "choice" || type === "multi") {
      options = (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter((o) => o.length > 0 && o.length <= MAX_OPTION_LENGTH)
        .slice(0, MAX_QUESTION_OPTIONS);
      // A choice with fewer than two options is not a question.
      if (options.length < 2) continue;
    }

    const help = typeof q.help === "string" && q.help.trim() ? q.help.trim() : undefined;
    seen.add(id);
    questions.push({
      id,
      label,
      ...(help ? { help } : {}),
      type,
      ...(options ? { options } : {}),
      required: q.required === true,
      // Only an explicit false pauses; rows stored before the flag existed
      // keep asking.
      enabled: q.enabled !== false
    });
  }
  return questions;
}

/**
 * The questions a VISITOR actually sees and must answer: paused ones stay
 * in storage for the builder but never reach the public form or its
 * validation (a paused required question must not block bookings).
 */
export function activeIntakeQuestions(
  questions: BookingIntakeQuestion[]
): BookingIntakeQuestion[] {
  return questions.filter((q) => q.enabled);
}

export type IntakeAnswers = Record<string, string | string[]>;

export type IntakeValidation =
  | { ok: true; answers: IntakeAnswers }
  | { ok: false; missing: string[] };

/**
 * Validate a visitor's answers against the page's questions.
 *
 * Strict where it protects the owner (required answered, choices from the
 * offered options, everything length-capped), silent where strictness
 * would only punish the visitor (answers to questions that no longer exist
 * are discarded, not refused: the owner may have edited the page while the
 * form sat open).
 */
export function validateIntakeAnswers(
  questions: BookingIntakeQuestion[],
  raw: unknown
): IntakeValidation {
  const input =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const answers: IntakeAnswers = {};
  const missing: string[] = [];

  for (const q of questions) {
    const value = input[q.id];
    if (q.type === "multi") {
      const picked = (Array.isArray(value) ? value : [])
        .filter((v): v is string => typeof v === "string")
        .filter((v) => (q.options ?? []).includes(v));
      if (picked.length > 0) answers[q.id] = picked;
      else if (q.required) missing.push(q.id);
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      if (q.required) missing.push(q.id);
      continue;
    }
    if (q.type === "choice") {
      // Not one of the offered options reads as unanswered: the option set
      // may have changed under an open form, and inventing answers is worse.
      if (!(q.options ?? []).includes(text)) {
        if (q.required) missing.push(q.id);
        continue;
      }
      answers[q.id] = text;
      continue;
    }
    answers[q.id] = text.slice(0, MAX_TEXT_ANSWER_LENGTH);
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, answers };
}

/**
 * The answers as lines a person reads: the event description, the owner
 * alert, the contact note. Questions the visitor did not answer are
 * omitted rather than rendered empty.
 */
export function formatIntakeAnswers(
  questions: BookingIntakeQuestion[],
  answers: IntakeAnswers
): string[] {
  const lines: string[] = [];
  for (const q of questions) {
    const value = answers[q.id];
    if (value === undefined) continue;
    const rendered = Array.isArray(value) ? value.join(", ") : value;
    if (!rendered) continue;
    lines.push(`${q.label}: ${rendered}`);
  }
  return lines;
}
