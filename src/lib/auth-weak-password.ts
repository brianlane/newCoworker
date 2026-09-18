/**
 * Detect Supabase Auth / GoTrue "this password is too common / HIBP / weak"
 * rejections so routes can return a 400 instead of a generic 500.
 *
 * GoTrue's HaveIBeenPwned check (BA Fitness LLC, 2026-09-18) answers
 * POST /auth/v1/admin/users with HTTP 422:
 *   "Password is known to be weak and easy to guess, please choose a different one."
 * The JS SDK wraps that as AuthWeakPasswordError with `code: "weak_password"`.
 * Older GoTrue or a thin `{ message }` mock may only carry the string, so
 * the known wording is a fallback.
 */

export const WEAK_PASSWORD_USER_MESSAGE =
  "That password is too common or easy to guess. Please choose a different one.";

const WEAK_PASSWORD_CODE = "weak_password";

/**
 * Phrases GoTrue / HIBP actually emit. Kept tighter than a bare "weak" so an
 * unrelated 422 (invalid email, bad JSON) does not get treated as a password
 * the customer can simply retype.
 */
const WEAK_PASSWORD_MESSAGE_RE =
  /known to be weak|easy to guess|password is too weak|have.?i.?been.?pwned|pwned password|compromised password|found in a (data )?breach|password.*(too common|leaked|breached)/i;

function asRecord(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  return error as Record<string, unknown>;
}

function errorText(error: unknown, rec: Record<string, unknown> | null): string {
  if (typeof error === "string") return error;
  if (!rec) return "";
  if (typeof rec.message === "string") return rec.message;
  if (typeof rec.msg === "string") return rec.msg;
  return "";
}

export function isWeakPasswordAuthError(error: unknown): boolean {
  const rec = asRecord(error);
  if (rec) {
    if (rec.code === WEAK_PASSWORD_CODE || rec.error_code === WEAK_PASSWORD_CODE) {
      return true;
    }
    if (rec.name === "AuthWeakPasswordError") return true;
    if (Array.isArray(rec.reasons) && rec.reasons.includes("pwned")) return true;
  }

  return WEAK_PASSWORD_MESSAGE_RE.test(errorText(error, rec));
}
