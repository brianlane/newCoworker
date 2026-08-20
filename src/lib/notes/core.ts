/**
 * Contact notes, pure domain rules.
 *
 * Notes are authored, timestamped records on a contact (table
 * `contact_notes`), the structured successor to the single
 * `contacts.pinned_md` blob (which stays untouched: pinned notes feed the AI
 * preamble, these notes are the team's running log). Validation and label
 * rules live here so the API routes stay thin and the logic sits under the
 * 100% coverage gate.
 */

/** Hard cap on a note body, enforced in app code (no DB constraint). */
export const NOTE_BODY_MAX = 4000;

/** Longest author label we store; anything longer is truncated, not refused. */
export const NOTE_AUTHOR_LABEL_MAX = 120;

export type NoteBodyValidation =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Validate a note body: trims, requires 1..{@link NOTE_BODY_MAX} chars after
 * the trim. Returns the trimmed body to write, or a human-readable refusal.
 */
export function validateNoteBody(raw: string): NoteBodyValidation {
  const body = raw.trim();
  if (body.length === 0) {
    return { ok: false, error: "Note cannot be empty." };
  }
  if (body.length > NOTE_BODY_MAX) {
    return {
      ok: false,
      error: `Note is too long (${body.length} chars; max ${NOTE_BODY_MAX}).`
    };
  }
  return { ok: true, body };
}

/**
 * Display-name snapshot for a note's author, stored at write time so the
 * note keeps reading the same after roster or account churn. Prefers the
 * caller's roster member name, then their login email, then a generic label
 * (an auth user always has one of the first two in practice; the fallback
 * keeps the column non-empty by construction).
 */
export function noteAuthorLabel(
  memberName: string | null | undefined,
  email: string | null | undefined
): string {
  const name = memberName?.trim();
  if (name) return name.slice(0, NOTE_AUTHOR_LABEL_MAX);
  const mail = email?.trim();
  if (mail) return mail.slice(0, NOTE_AUTHOR_LABEL_MAX);
  return "Teammate";
}

export type NoteRelativeTime =
  | { kind: "justNow" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number }
  | { kind: "date" };

/**
 * Coarse relative-time bucket for a note timestamp: "just now" under a
 * minute, then minutes/hours/days, and `date` (render the absolute date
 * instead) once it is 30+ days old or the timestamp is unparseable/future.
 * Pure so the i18n render site just maps `kind` to its catalog key.
 */
export function noteRelativeTime(iso: string, nowMs: number): NoteRelativeTime {
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs) || thenMs > nowMs) return { kind: "date" };
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return { kind: "justNow" };
  if (minutes < 60) return { kind: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hours", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 30) return { kind: "days", count: days };
  return { kind: "date" };
}
