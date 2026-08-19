/**
 * Types for the ACTION-mode engine, which is plain `.mjs` because it ships to
 * the per-tenant render box and runs under bare Node with no build step.
 *
 * This exists so `tests/aiflow-render-actions.test.ts` can import it with real
 * types instead of a `@ts-expect-error` that turns the whole module into `any`.
 * A suppression there also silently covered typos in the test's own calls; this
 * checks them.
 *
 * Hand-written, so keep it in step with the exports in `actions.mjs`. A
 * declaration that drifts ahead of the implementation still fails at runtime in
 * that test suite, which is the backstop.
 *
 * `page` and `locator` are typed as `unknown`-ish structural values on purpose:
 * the real arguments are Playwright objects, playwright is not a dependency of
 * the app package, and the tests drive these with stubs.
 */

/** A Playwright `Page`, or a test stub shaped like the parts we use. */
type RenderPage = unknown;

/** One normalized action from the worker's browse_action step. */
export interface RenderAction {
  kind: string;
  target: string;
  value: string;
}

export const NAV_TIMEOUT_MS: number;
export const ACTION_TIMEOUT_MS: number;
export const MAX_ACTIONS: number;
export const MAX_WHILE_PRESENT_CLICKS: number;
export const WHILE_PRESENT_PROBE_MS: number;
export const MAX_FOREACH_ITEMS: number;
export function capForEachList(hrefs: string[]): {
  kept: string[];
  remaining: number;
  capNote: string | null;
};
export const CLICK_TEXT_APPEAR_MS: number;
export const CHECK_TOTAL_APPEAR_MS: number;
export const CLICK_TEXT_APPEAR_POLL_MS: number;
export const EXPECT_TEXT_TIMEOUT_MS: number;
export const MAX_OVERLAY_DISMISS_ROUNDS: number;
export const ACTION_KINDS: Set<string>;
export const ERROR_DETAIL_MAX: number;

/** Overlay-dismissal safelists. See actions.mjs for why they are module-level. */
export const CLOSE_NAME_RE: RegExp;
export const AGREE_NAME_RE: RegExp;
export const CLOSE_ATTR_RE: RegExp;
export const CLOSE_ICON_RE: RegExp;

export function condenseError(msg: unknown): string;
export function parseActions(raw: unknown): RenderAction[] | null;
export function resolveClickTarget(
  page: RenderPage,
  target: string,
  opts?: { allowExactTextAnywhere?: boolean; appearTimeoutMs?: number }
): Promise<unknown>;
export function dismissBlockingOverlays(page: RenderPage, protectTarget?: string): Promise<number>;
export function performActions(
  page: RenderPage,
  actions: readonly RenderAction[]
): Promise<{ completed: number; error?: string }>;
export function runAction(
  page: RenderPage,
  action: RenderAction,
  opts?: { appearTimeoutMs?: number }
): Promise<void>;
export function waitForExpectedText(
  page: RenderPage,
  text: unknown,
  timeoutMs?: number
): Promise<boolean>;

/**
 * One action's dry-run verdict. `options` is present only on
 * `missing_option`, listing what the matched <select> does offer.
 */
export interface ActionCheck {
  kind: string;
  target: string;
  state: "ready" | "blocked" | "absent" | "missing_option";
  detail?: string;
  options?: string[];
}

export function checkAction(
  page: RenderPage,
  action: RenderAction,
  opts?: { appearTimeoutMs?: number }
): Promise<ActionCheck>;
export function checkActions(
  page: RenderPage,
  actions: readonly RenderAction[],
  opts?: { totalAppearMs?: number }
): Promise<ActionCheck[]>;
