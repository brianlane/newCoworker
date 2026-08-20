/**
 * Client-safe view helpers for a browse-step DEMONSTRATION: the wire types,
 * the owner-facing wording for each outcome, and the recorded-actions-to-
 * editor translation. No server imports.
 *
 * Split from demo-session.ts for the same reason action-check-view.ts is
 * split from action-check.ts: the server lib reaches the URL guard in
 * page-probe.ts, which reaches `next/headers`, and a "use client" panel
 * importing any VALUE from that chain fails the build.
 */
import type { EditorAction } from "@/lib/ai-flows/action-check-view";
import type { PageDigest } from "@/lib/ai-flows/page-controls";
import type { PageDiagnostics } from "@/lib/ai-flows/action-check-view";

/** A recorded action, exactly the shape the step editor stores (minus templating). */
export type DemoRecordedAction = { kind: string; target: string; value?: string };

/** One /demo/act instruction: a standard engine kind, or a point on the screenshot. */
export type DemoActRequestAction =
  | { kind: string; target: string; value?: string }
  | { kind: "click_point" | "fill_point"; x: number; y: number; value?: string };

/** Mirrors the sidecar's session cap on recorded actions (MAX_ACTIONS). */
export const MAX_DEMO_ACTIONS = 15;

/**
 * Labels that commit the tenant to something. A COPY of the sidecar's
 * CONFIRM_LABEL_RE (which is itself the engineer probe's DESTRUCTIVE_TARGETS):
 * this module must stay client-safe and cannot import the .mjs, so a lockstep
 * test pins the three sources together. Used to pre-confirm LIST clicks
 * without a round trip; point clicks rely on the sidecar's own gate.
 */
export const CONFIRM_LABEL_RE =
  /decline|claim|submit|accept|delete|remove|withdraw|send|pay|confirm|cancel|sign.?out|logout/i;

/** Does this label look like it commits something, so the panel confirms first? */
export function isConfirmLabel(text: string): boolean {
  return CONFIRM_LABEL_RE.test(text);
}

/** Why a screenshot click could not become a recordable action. */
export type DemoResolveFailureReason =
  | "not_interactive"
  | "iframe_content"
  | "select_needs_option"
  | "field_use_fill"
  | "not_typeable"
  | "field_unaddressable"
  | "no_stable_selector"
  | "ambiguous";

export const DEMO_RESOLVE_FAILURE_REASONS: ReadonlySet<DemoResolveFailureReason> = new Set([
  "not_interactive",
  "iframe_content",
  "select_needs_option",
  "field_use_fill",
  "not_typeable",
  "field_unaddressable",
  "no_stable_selector",
  "ambiguous"
]);

/** The page-state fields every executed turn carries back. */
export type DemoTurnState = {
  finalUrl: string;
  digest: PageDigest;
  pageText: string;
  screenshotBase64?: string;
  diagnostics?: PageDiagnostics;
};

/** What one /demo/act turn produced. All of these are conversation turns, not errors. */
export type DemoActOutcome =
  | ({ outcome: "recorded"; recorded: DemoRecordedAction; actionsCount: number } & DemoTurnState)
  | { outcome: "needs_confirm"; resolved: DemoRecordedAction; label: string }
  | {
      outcome: "resolve_failed";
      reason: DemoResolveFailureReason;
      detail?: string;
      options?: string[];
    }
  | ({ outcome: "action_failed"; detail: string } & Partial<DemoTurnState>)
  | { outcome: "demo_gone"; detail?: string }
  | { outcome: "action_cap" };

/**
 * Owner wording for a screenshot click that could not become an action.
 * Each one says what to DO next, because "could not resolve" alone sends
 * people clicking the same pixel harder.
 */
export function describeDemoResolveFailure(
  reason: DemoResolveFailureReason,
  options?: string[]
): string {
  switch (reason) {
    case "not_interactive":
      return "That spot is not a button, link or field. Click directly on the control you want, or pick it from the list below.";
    case "iframe_content":
      return "That part of the page is an embedded frame from another site, which a step cannot reach. If the workflow lives inside it, this page cannot be taught by demonstration yet.";
    case "select_needs_option":
      return options && options.length > 0
        ? `That is a dropdown, so choose what to pick from it: ${options.join(", ")}.`
        : "That is a dropdown, so choose what to pick from it in the list below.";
    case "field_use_fill":
      return "That is a text field. Type what should go in it and use its Type it button instead of clicking it.";
    case "not_typeable":
      return "That control cannot be part of a recorded step (password and similar fields are never recorded).";
    case "field_unaddressable":
      return "That field has no stable name or placeholder to aim at, so a step could not find it again later. Pick a different field, or ask us for help with this page.";
    case "no_stable_selector":
      return "That control has no stable text, label or handle a step could find again later. Pick it from the list below if it appears there.";
    case "ambiguous":
      return "More than one control on this page matches that one, so a recorded step could click the wrong one. Pick it from the list below instead.";
  }
}

/**
 * The two honesty lines the panel must keep in front of the owner. Constants
 * here so the wording is pinned by one test and rendered by one component.
 */
export const DEMO_LIVE_WARNING =
  "This opens the real site with your real login. Everything you do here really happens there, exactly once, while we write it down.";
export const DEMO_REMOVE_WARNING =
  "Removing a step only edits the recording. Whatever that click already did on the site stays done.";
export const DEMO_GONE_MESSAGE =
  "The live session ended (it expired, or the browser service restarted). Anything already done on the site stays done, and your recorded steps are kept. Start again to continue from the page as it is now.";
/**
 * The cap counts what the SESSION really did, not what the recording still
 * lists, so removing a row cannot free a slot: that click already happened on
 * the site. Saying otherwise sent owners deleting rows and hitting the same
 * refusal with no way forward.
 */
export const DEMO_ACTION_CAP_MESSAGE = `This demonstration has already done ${MAX_DEMO_ACTIONS} things on the site, which is the most one step can hold. Removing a recorded row does not free one up, because that click really happened. Save what you have, or cancel and start over.`;

/**
 * Translate recorded actions into what the step editor stores. The editor's
 * field is `valueTemplate` (it may carry {{...}} placeholders); a recording
 * holds the literal the owner typed, which drops in as-is and can be mapped
 * to a variable afterwards. An empty value is dropped rather than stored as
 * an empty template, matching how the editor treats an untouched value box.
 */
export function toEditorActions(recorded: DemoRecordedAction[]): EditorAction[] {
  return recorded.map((a) => ({
    kind: a.kind,
    target: a.target,
    ...(a.value && a.value.length > 0 ? { valueTemplate: a.value } : {})
  }));
}
