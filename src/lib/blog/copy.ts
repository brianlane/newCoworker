/**
 * Blog copy policy: NO EM DASHES, ever (operator rule, Jul 2026 — matches
 * the marketing-copy stance of PR #716). Enforced in code on every path
 * that writes post copy — the AI composers (digest, rotation topics,
 * admin draft/translate) and the admin editor's save routes — because a
 * prompt instruction alone cannot guarantee it.
 */

/**
 * Em dash and horizontal bar; en dash stays (legitimate in ranges like
 * 9–5). Only HORIZONTAL whitespace is consumed around the dash so line
 * structure (markdown paragraphs/lists) survives the rewrite.
 */
const EM_DASH_RE = /[^\S\n]*[\u2014\u2015]+[^\S\n]*/g;

/**
 * Replace em dashes with a comma joint ("word — word" → "word, word"),
 * then clean the punctuation artifacts a leading/trailing dash leaves.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(EM_DASH_RE, ", ")
    .replace(/, ([.,;:!?])/g, "$1")
    .replace(/^, /gm, "")
    .replace(/, $/gm, "");
}

/** Convenience for the composers' {title, excerpt, content} drafts. */
export function stripEmDashesFromDraft<T extends Record<string, string>>(draft: T): T {
  const out = { ...draft };
  for (const key of Object.keys(out) as Array<keyof T>) {
    out[key] = stripEmDashes(out[key]) as T[keyof T];
  }
  return out;
}

/** The admin editor's copy fields, normalized on save (create + patch). */
const COPY_FIELDS = ["title", "excerpt", "content", "title_es", "excerpt_es", "content_es"];

export function sanitizeBlogCopyFields<T extends Record<string, unknown>>(body: T): T {
  const out = { ...body };
  for (const key of COPY_FIELDS) {
    const value = out[key as keyof T];
    if (typeof value === "string") {
      out[key as keyof T] = stripEmDashes(value) as T[keyof T];
    }
  }
  return out;
}
