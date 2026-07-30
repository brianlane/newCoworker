/**
 * CASA 3.3.1: application admin interfaces must enforce MFA.
 * Supabase encodes the current authenticator assurance level on the JWT
 * as `aal` (`aal1` password/passkey only, `aal2` after a verified MFA factor).
 */

export const ADMIN_MFA_PATH = "/admin/mfa";
export const ADMIN_LOGIN_PATH = "/admin/login";

export type AuthenticatorAssuranceLevel = "aal1" | "aal2";

export function isAdminEmail(
  email: string | null | undefined,
  adminEmail: string | null | undefined = process.env.ADMIN_EMAIL
): boolean {
  if (!email || !adminEmail) return false;
  return email.toLowerCase() === adminEmail.toLowerCase();
}

export function isAal2(aal: string | null | undefined): boolean {
  return aal === "aal2";
}

/** True when the caller is the configured admin AND has completed MFA. */
export function hasAdminMfa(
  email: string | null | undefined,
  aal: string | null | undefined,
  adminEmail: string | null | undefined = process.env.ADMIN_EMAIL
): boolean {
  return isAdminEmail(email, adminEmail) && isAal2(aal);
}

/** Same-origin admin path only; never returns `/admin/mfa` itself. */
export function safeAdminNextPath(nextPath?: string | null): string {
  if (
    nextPath &&
    nextPath.startsWith("/") &&
    !nextPath.startsWith("//") &&
    nextPath !== ADMIN_MFA_PATH &&
    !nextPath.startsWith(`${ADMIN_MFA_PATH}?`)
  ) {
    return nextPath;
  }
  return "/admin/dashboard";
}

export function adminMfaRedirectPath(nextPath?: string | null): string {
  const next = safeAdminNextPath(nextPath);
  return `${ADMIN_MFA_PATH}?next=${encodeURIComponent(next)}`;
}
