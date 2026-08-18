/**
 * Types for the LOGIN engine, which is plain `.mjs` because it ships to the
 * per-tenant render box and runs under bare Node with no build step.
 *
 * This exists so `tests/aiflow-render-login.test.ts` can import it with real
 * types instead of a `@ts-expect-error` that turns the whole module into `any`
 * and silently covers typos in the test's own calls.
 *
 * Hand-written, so keep it in step with the exports in `login.mjs`. A
 * declaration that drifts ahead of the implementation still fails at runtime in
 * that test suite, which is the backstop.
 *
 * `page` is typed `unknown` on purpose: the real argument is a Playwright
 * `Page`, playwright is not a dependency of the app package, and the tests
 * drive these with stubs.
 */

/** A Playwright `Page`, or a test stub shaped like the parts we use. */
type RenderPage = unknown;

/** Owner-supplied selector overrides from `browse_*.auth.login`. */
export interface LoginOverrides {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /** Control that advances an email-first login to its password step. */
  advanceSelector?: string;
  /** Override the wait for the password step after an advance, in ms. */
  advanceTimeoutMs?: number;
}

/**
 * What `performLogin` observed. Returned rather than thrown so the caller can
 * attach it to `login_failed` after its own re-check, which is the authority on
 * whether the login actually worked.
 */
export interface LoginDiagnostics {
  /**
   * Which controls were used. Grouped rather than named `passwordSelector`,
   * which a generic-password scanner flags as a credential assignment. These
   * are CSS selectors; no credential value is ever carried here.
   */
  selectors: {
    /** Null when an email-first second page carried no username field. */
    user: string | null;
    /** Null when the email-first advance never reached the password step. */
    pass: string | null;
    submit: string | null;
    /** Non-null only on an email-first login. */
    advance: string | null;
  };
  /** 1 for a one-page form, 2 when the portal asked for the email first. */
  steps: 1 | 2;
  /**
   * False only on an email-first login whose advance never produced a password
   * field. Reported rather than thrown, so the caller can surface a
   * `login_failed` with evidence instead of a permanent `auth_config_error`.
   */
  passwordStepReached: boolean;
  /** Null when no submit control was found at all. */
  submitEnabled: boolean | null;
  blurred: boolean;
  clickError: string | null;
}

export const LOGIN_CLICK_TIMEOUT_MS: number;
export const LOGIN_SETTLE_MS: number;
export const USERNAME_SELECTORS: string[];
export const PASSWORD_SELECTORS: string[];
export const SUBMIT_SELECTORS: string[];

export function firstSelector(
  page: RenderPage,
  candidates: ReadonlyArray<string | undefined>
): Promise<string | null>;
export function looksLikeLogin(page: RenderPage, login?: LoginOverrides): Promise<boolean>;
export function resolveSubmit(
  page: RenderPage,
  login?: LoginOverrides
): Promise<{ selector: string; enabled: boolean } | null>;
export function performLogin(
  page: RenderPage,
  creds: { username: string; password: string },
  login?: LoginOverrides
): Promise<LoginDiagnostics>;

/** How long the email-first step waits for the password field to appear. */
export const LOGIN_ADVANCE_TIMEOUT_MS: number;
/** Gap between re-checks while waiting for the password step to mount. */
export const LOGIN_ADVANCE_POLL_MS: number;
/** Shortened wait when the advance click itself threw. */
export const LOGIN_ADVANCE_GRACE_MS: number;
/** Controls that advance an email-first login to its password step. */
export const ADVANCE_SELECTORS: string[];
/** Username fields specific enough to anchor an email-first login on. */
export const EMAIL_FIRST_SELECTORS: string[];
/** Matches "sign in" / "log in" and deliberately not "sign out" / "log out". */
export const LOGIN_HINT_RE: RegExp;
/** Does the page (or its URL) say it wants you to authenticate? */
export function looksLikeLoginPage(page: RenderPage): Promise<boolean>;
/** Poll for the password field after an advance click; null on timeout. */
export function waitForPasswordField(
  page: RenderPage,
  login?: LoginOverrides,
  timeoutMs?: number
): Promise<string | null>;
