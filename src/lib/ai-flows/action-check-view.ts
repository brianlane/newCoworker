/**
 * Client-safe view helpers for a browse-step dry run: the result types, and
 * the owner-facing wording for each verdict. No server imports.
 *
 * Split from action-check.ts for the same reason browse-action-tree.ts is
 * split from browse-action-steps.ts: the sidecar client reaches the URL guard
 * in page-probe.ts, which reaches custom-integrations, which reaches the
 * Supabase server client and `next/headers`. A "use client" panel importing
 * any VALUE from that chain fails the build, so the strings it renders live
 * here instead.
 */

/** What the sidecar found for one action. */
export type ActionCheckState = "ready" | "blocked" | "absent" | "missing_option";

export type ActionCheck = {
  kind: string;
  target: string;
  state: ActionCheckState;
  /** Why it could not be located, when the sidecar could say. */
  detail?: string;
  /** For `missing_option`: what the matched dropdown does offer. */
  options?: string[];
};

/** One action as the sidecar expects it (the step's shape, flattened). */
export type CheckableAction = { kind: string; target: string; value?: string };

/** Mirrors the sidecar's own cap (MAX_ACTIONS in vps/aiflow-render/actions.mjs). */
export const MAX_CHECKABLE_ACTIONS = 15;

/**
 * Owner-facing wording for one verdict. Deliberately says what to DO about
 * it: a bare "not found" sends people re-reading their selector when the real
 * answer is usually "this one only appears after the click above it".
 */
export function describeActionCheck(check: ActionCheck): string {
  switch (check.state) {
    case "ready":
      return "Found it on the page.";
    case "blocked":
      return "It is on the page but not clickable right now. That is normal for a button that only wakes up once something above it is filled in.";
    case "missing_option":
      return check.options && check.options.length > 0
        ? `The dropdown is there, but it does not offer that choice. It offers: ${check.options.join(", ")}.`
        : "The dropdown is there, but it does not offer that choice.";
    case "absent":
      return check.detail
        ? `Not found on this page (${check.detail}).`
        : "Not found on this page. Either the wording changed, or this step only appears after an earlier action has run.";
  }
}

/**
 * True when nothing at all resolved. Worth calling out separately: one absent
 * action mid-sequence is usually the as-loaded limitation, while a whole
 * sequence resolving to nothing normally means the page never really loaded
 * (a login that silently failed, or the wrong address).
 */
export function noActionResolved(checks: ActionCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.state === "absent");
}
