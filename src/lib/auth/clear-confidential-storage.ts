import { clearOnboardingStorage } from "@/lib/onboarding/storage";

/**
 * Session/local keys that can hold confidential business or admin-session
 * material. UI prefs (sort order, editor mode, last-login-method) are left
 * alone on purpose. View-as keys match ViewAsBanner exports.
 */
export const CONFIDENTIAL_SESSION_STORAGE_KEYS = [
  "aiflow_adapt_draft",
  "aiflow_adapt_warnings",
  "agent_create_draft",
  "admin-view-as-banner-hidden",
  "admin-view-as-return-to"
] as const;

/**
 * CASA 6.6.1: clear confidential browser storage on logout. Safe to call
 * from the client before posting to /api/auth/signout.
 */
export function clearConfidentialBrowserStorage(): void {
  clearOnboardingStorage();
  try {
    for (const key of CONFIDENTIAL_SESSION_STORAGE_KEYS) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // sessionStorage can be unavailable in private mode.
  }
}
