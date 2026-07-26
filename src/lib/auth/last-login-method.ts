/**
 * Remembers which method an owner last signed in with so /login can badge it
 * "Last used". Purely a convenience hint: it is written from the browser,
 * carries no identity, and a missing or corrupt value just means no badge.
 *
 * Stored per browser (not per account) because it has to be readable BEFORE
 * anyone is authenticated, which is the whole point of the badge.
 */
export const LOGIN_METHODS = ["password", "magic-link", "google", "passkey"] as const;

export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const LAST_LOGIN_METHOD_STORAGE_KEY = "ncw:last-login-method";

function isLoginMethod(value: string | null): value is LoginMethod {
  return value !== null && (LOGIN_METHODS as readonly string[]).includes(value);
}

export function readLastLoginMethod(): LoginMethod | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LAST_LOGIN_METHOD_STORAGE_KEY);
    return isLoginMethod(stored) ? stored : null;
  } catch {
    // Storage can throw outright (Safari private mode, storage disabled by
    // policy). No badge is a fine outcome; a broken login page is not.
    return null;
  }
}

export function rememberLastLoginMethod(method: LoginMethod): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_LOGIN_METHOD_STORAGE_KEY, method);
  } catch {
    // Ignore: see readLastLoginMethod.
  }
}
