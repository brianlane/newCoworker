/**
 * Types for the DEMONSTRATION-mode engine, which is plain `.mjs` because it
 * ships to the per-tenant render box and runs under bare Node with no build
 * step.
 *
 * This exists so `tests/aiflow-render-demo.test.ts` can import it with real
 * types instead of a `@ts-expect-error` that turns the whole module into
 * `any`. Hand-written, so keep it in step with the exports in `demo.mjs`; a
 * declaration that drifts ahead of the implementation still fails at runtime
 * in that test suite, which is the backstop.
 *
 * `page` and handles are typed as `unknown` on purpose: the real arguments
 * are Playwright objects, playwright is not a dependency of the app package,
 * and the tests drive these with stubs.
 */

/** A Playwright `Page`, or a test stub shaped like the parts we use. */
type RenderPage = unknown;
/** A Playwright `ElementHandle`, or a test stub shaped like the parts we use. */
type HitElement = unknown;

export const DEMO_IDLE_TTL_MS: number;
export const DEMO_MAX_LIFETIME_MS: number;
export const DEMO_MAX_SESSIONS: number;
export const DEMO_SWEEP_INTERVAL_MS: number;
export const DEMO_TEXT_MAX_CHARS: number;
export const DEMO_POINT_MAX: number;
export const DEMO_VALUE_MAX_CHARS: number;
export const DEMO_VERIFY_TIMEOUT_MS: number;
export const CONFIRM_LABEL_RE: RegExp;
export const DEMO_TYPEABLE_INPUT_TYPES: Set<string>;
export const DEMO_ACT_KINDS: Set<string>;
export const STABLE_ID_RE: RegExp;

/** A recordable browse action, exactly the engine's wire shape. */
export interface DemoRecordedAction {
  kind: string;
  target: string;
  value: string;
  optional: boolean;
}

/** A normalized /demo/act action: a standard kind, or a point kind. */
export type DemoAction =
  | DemoRecordedAction
  | { kind: "click_point" | "fill_point"; x: number; y: number; value: string };

export function parseDemoAction(raw: unknown): DemoAction | null;
export function isConfirmRequired(action: { kind: string; target: string; value?: string }): boolean;

/** One live demonstration session (a persistent page the owner is driving). */
export interface DemoSession {
  demoId: string;
  businessId: string;
  page: RenderPage;
  close: () => Promise<void> | void;
  createdAt: number;
  lastUsed: number;
  actionsCount: number;
  released: boolean;
}

export interface DemoStore {
  create(seed: {
    demoId: string;
    businessId: string;
    page: RenderPage;
    close: () => Promise<void> | void;
  }): Promise<DemoSession | null>;
  get(demoId: string, businessId: string): DemoSession | null;
  touch(session: DemoSession): void;
  release(session: DemoSession): Promise<void>;
  sweep(): Promise<void>;
  size(): number;
}

export function createDemoStore(opts?: {
  now?: () => number;
  idleTtlMs?: number;
  maxLifetimeMs?: number;
  maxSessions?: number;
}): DemoStore;

/** Serialized description of the interactive element under a point. */
export interface DemoHit {
  tag: string;
  inputType: string;
  name: string;
  id: string;
  dataTest: string;
  dataTestId: string;
  ariaLabel: string;
  role: string;
  text: string;
  placeholder: string;
  valueAttr: string;
  disabled: boolean;
  href: string;
  options?: string[];
}

export function collectHitAtPoint(
  page: RenderPage,
  x: number,
  y: number
): Promise<{
  reason: "none" | "iframe" | "offscreen" | null;
  element: HitElement | null;
  hit: DemoHit | null;
}>;

/** A derived candidate before verification (no value yet for fills). */
export interface DemoCandidate {
  kind: string;
  target: string;
}

export type DemoDerivation =
  | { verdict: "candidates"; candidates: DemoCandidate[]; label: string }
  | { verdict: "select_needs_option"; options: string[] }
  | {
      verdict:
        | "field_use_fill"
        | "not_typeable"
        | "field_unaddressable"
        | "no_stable_selector";
    };

export function deriveDemoCandidates(hit: DemoHit, intent: "click" | "fill"): DemoDerivation;

export function pickVerifiedCandidate(
  page: RenderPage,
  candidates: readonly DemoCandidate[],
  element: HitElement,
  opts?: { timeoutMs?: number }
): Promise<DemoCandidate | null>;

export type DemoResolveFailure =
  | "not_interactive"
  | "iframe_content"
  | "select_needs_option"
  | "field_use_fill"
  | "not_typeable"
  | "field_unaddressable"
  | "no_stable_selector"
  | "ambiguous";

export function resolveDemoPointAction(
  page: RenderPage,
  action: { kind: "click_point" | "fill_point"; x: number; y: number; value: string }
): Promise<
  | { ok: true; action: DemoRecordedAction; label: string }
  | { ok: false; reason: DemoResolveFailure; detail?: string; options?: string[] }
>;

export function diagnosticsMarks(diag: unknown): Record<string, number>;
export function sliceDiagnostics(
  diag: unknown,
  marks: Record<string, number>
): Record<string, string[]> | null;
