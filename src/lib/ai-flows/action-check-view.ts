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

/** What the page reported about itself, as the sidecar groups it. */
export type PageDiagnostics = Record<string, string[]>;

/**
 * Owner-readable lines for what the page reported about itself.
 *
 * The reason this matters is the same one PR #1508 gave for printing it in
 * the engineer probe: a page whose data requests failed returns HTTP 200 with
 * real markup and missing controls, so "not found on this page" and "the
 * control never rendered because its script was served an HTML error page"
 * are the same message without this. On HomeLight that distinction was two
 * `Unexpected token '<'` page errors, and nothing else would have said so.
 */
export function describePageDiagnostics(diagnostics?: PageDiagnostics): string[] {
  if (!diagnostics) return [];
  const lines: string[] = [];
  for (const [kind, items] of Object.entries(diagnostics)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    for (const item of items.slice(0, 5)) lines.push(`${kind}: ${item}`);
    if (items.length > 5) lines.push(`${kind}: ... ${items.length - 5} more`);
  }
  // Our own SSRF guard aborts with `route.abort("blockedbyclient")`, which
  // Chromium reports back as `net::ERR_BLOCKED_BY_CLIENT`. Matching the abort
  // ARGUMENT alone never fires, so our refusals would read as portal faults;
  // normalize both spellings, the same way the engineer probe does.
  const normalized = lines.join(" ").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("blockedbyclient")) {
    lines.push(
      "Note: a blocked request above is our own safety guard refusing it, not the page failing."
    );
  }
  return lines;
}

/**
 * One action as the EDITOR holds it. The step schema calls the value
 * `valueTemplate` (it can carry {{...}} placeholders a run fills in), while
 * the sidecar's parseActions expects `value`.
 */
export type EditorAction = { kind: string; target: string; valueTemplate?: string };

/**
 * Value-requiring kinds, mirroring BROWSE_ACTION_KINDS_REQUIRING_VALUE in the
 * schema and ACTION_KINDS_REQUIRING_VALUE in the sidecar. Duplicated rather
 * than imported because this module must stay client-safe.
 */
const VALUE_REQUIRING_KINDS = new Set(["click_role", "select_option"]);

/**
 * Translate editor actions into what the checker sends.
 *
 * Passing the editor's objects straight through drops the value entirely, and
 * `parseActions` rejects the WHOLE array when a value-requiring kind has none.
 * So a sequence containing one `select_option` would not have come back with
 * "the dropdown does not offer that choice"; it would have come back as a
 * failed page open, blaming the address.
 */
export function toCheckableActions(actions: EditorAction[]): CheckableAction[] {
  return actions.map((a) => ({
    kind: a.kind,
    target: a.target,
    ...(a.valueTemplate ? { value: a.valueTemplate } : {})
  }));
}

/**
 * True when a value the check actually COMPARES is still a template.
 *
 * Only the value-requiring kinds matter: a dry run never types, so a
 * `fill_selector` template is irrelevant, but `select_option` and
 * `click_role` match ON the value, and at authoring time there is no run to
 * resolve {{vars.x}} against. The owner has to be told the comparison used
 * the text as written, or a correct step reads as a missing option.
 */
export function hasUnresolvedTemplateValue(actions: EditorAction[]): boolean {
  return actions.some(
    (a) => VALUE_REQUIRING_KINDS.has(a.kind) && (a.valueTemplate ?? "").includes("{{")
  );
}
