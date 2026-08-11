/**
 * The frozen Google Workspace OAuth scope set.
 *
 * READ THIS BEFORE CHANGING THE ARRAY BELOW.
 *
 * Our Google OAuth client (`354099628168-...`, GCP project `new-coworker`) is
 * verified. Verification was granted 2026-08-10 and cost an ADA-CASA AL1
 * security assessment: a DAST scan, a 54-question SAQ accepted at 49 Yes and 5
 * honest No, seven merged remediation pull requests, and a Letter of Validation
 * filed with Google. It is renewable annually, and the next cycle is due around
 * August 2027 (`.github/workflows/casa-recert-reminder.yml` fires the reminder
 * each June).
 *
 * `google-oauth-assets/casa/recert-runbook.md:129-131` states the rule that
 * governs this file:
 *
 *   > Any new sensitive or restricted scope, or any change to the OAuth consent
 *   > screen configuration, requires a fresh verification request. Verification
 *   > cannot be inherited.
 *
 * So adding a scope here is not a code change, it is a compliance event. Two of
 * these seven are the ones Google actually reviewed:
 *
 *   - `gmail.modify` is RESTRICTED. It alone is what triggers the CASA
 *     requirement. Losing it is a production outage for every tenant with a
 *     connected Gmail, not a paperwork problem.
 *   - `calendar.events` is SENSITIVE.
 *
 * The rest are non-sensitive or identity scopes and do not appear in an
 * approval.
 *
 * Narrowing the set is safe (removing a scope never needs re-verification), but
 * do not narrow casually either: `calendar.app.created` backs the app-created
 * "NewCoworker" calendar the public booking page depends on.
 *
 * Deliberately absent, and to stay absent:
 *
 *   - `gmail.settings.basic`, removed during the Jul 2026 verification restart
 *     because nothing in the codebase ever called a Gmail settings endpoint. It
 *     is restricted, so it was review surface bought for no feature.
 *   - `drive.readonly`, which the direct-Google code deleted in Apr 2026 used to
 *     request. It is not in the approved set and must not come back with it.
 *
 * The values below were read from the live Nango integration config on
 * 2026-08-11 via `debug/google-nango-export-audit.ts` and cross-checked against
 * the Cloud Console, rather than retyped from a doc. `tests/google-workspace-scopes.test.ts`
 * freezes them so a well-meaning edit fails CI instead of quietly invalidating
 * the verification.
 */

/** Ordered exactly as declared on the consent screen. Order is not significant to Google, but keeping it stable makes diffs meaningful. */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/gmail.modify"
] as const;

export type GoogleWorkspaceScope = (typeof GOOGLE_WORKSPACE_SCOPES)[number];

/** The two scopes Google's verification actually covers. */
export const GOOGLE_VERIFIED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.modify"
] as const;

/** Space-delimited, the form the authorize URL and token responses use. */
export function googleWorkspaceScopeParam(): string {
  return GOOGLE_WORKSPACE_SCOPES.join(" ");
}

/**
 * Whether a grant actually carries `scope`.
 *
 * Google's granular consent lets an owner untick individual boxes, so a grant
 * can come back with the calendar scopes but not `gmail.modify`. Nothing else
 * notices: every Gmail call would just 403 forever. Gate on the scope string the
 * TOKEN EXCHANGE returned, never on this list, which says what we asked for
 * rather than what we got.
 */
export function googleGrantCovers(grantedScope: string | null | undefined, scope: string): boolean {
  if (typeof grantedScope !== "string" || grantedScope.length === 0) return false;
  return grantedScope.split(/\s+/).filter(Boolean).includes(scope);
}
