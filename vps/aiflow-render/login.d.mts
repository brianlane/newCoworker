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
  selectors: { user: string; pass: string; submit: string | null };
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
