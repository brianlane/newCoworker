/**
 * Closed-class option lists for the Step 1 onboarding form.
 *
 * Team size and CRM tooling were originally elicited via the Step 2
 * chat interview, which required a stack of fragile heuristics
 * (transcript scanning, Q/A pairing, dead-end fallback questions) to
 * reliably tell when a topic had been answered. Moving them to closed
 * dropdowns on Step 1 trades a tiny amount of "form-y" UX for big
 * wins:
 *
 *   - Deterministic answers — no regex/LLM extraction.
 *   - Lower token cost on every chat turn (the system prompt no
 *     longer carries the team-size / CRM dead-end question banks).
 *   - The chat interview can focus on what LLMs are actually good at:
 *     tone, exception flows, routing rules, free-text policies.
 *
 * The string values selected here flow directly into
 * `OnboardingKnownContext.{teamSize,crmUsed}` and `identity.md`, so
 * keep them human-readable rather than enum-coded.
 */

export type TeamSizeOption = {
  value: string;
  label: string;
  hint?: string;
};

/**
 * Coarse buckets (`Just me`, `2–3`, …, `25+`) rather than free
 * numeric input. The downstream system prompts and `identity.md` only
 * need a rough scale — exact headcount adds noise without value, and
 * a closed enum eliminates the "4 or 5" / "couple of agents" /
 * "team of nine or ten" parsing problems.
 */
export const TEAM_SIZE_OPTIONS: readonly TeamSizeOption[] = [
  { value: "Just me", label: "Just me" },
  { value: "2-3", label: "2–3" },
  { value: "4-5", label: "4–5" },
  { value: "6-10", label: "6–10" },
  { value: "11-25", label: "11–25" },
  { value: "25+", label: "25+" }
] as const;

/**
 * Maps a Step 1 dropdown value (`"Just me"`, `"2-3"`, …, `"25+"`) to
 * the integer that gets persisted in `businesses.team_size`. The DB
 * column is `int`, so we need a deterministic projection: previously
 * the route called `parseInt(body.teamSize, 10)`, which silently
 * produced `NaN` for `"Just me"` (breaking create/checkout for the
 * single largest user segment — solo operators) and silently
 * truncated `"4-5"` to `4` purely by parseInt's trailing-garbage
 * tolerance. Both paths corrupted onboarding data.
 *
 * Picks the LOWER bound of each bucket so any `team_size >= N`
 * comparisons (analytics, routing, billing thresholds) don't
 * over-count operators. Solo is `1`, not `0`, because `0` would imply
 * "no humans involved" which is never the case.
 *
 * Falls through to a guarded `parseInt` for legacy localStorage
 * drafts that pre-date the dropdown and may still carry free-text
 * values like `"5"` or `"10 agents"`. If even that fails, defaults to
 * `1` rather than `NaN` — solo is the most common small-team default
 * and is recoverable; a NaN insert is not.
 */
export function teamSizeBucketToInt(value: string | undefined | null): number {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return 1;
  switch (trimmed) {
    case "Just me":
      return 1;
    case "2-3":
      return 2;
    case "4-5":
      return 4;
    case "6-10":
      return 6;
    case "11-25":
      return 11;
    case "25+":
      return 25;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export type CrmOption = {
  value: string;
  label: string;
};

/**
 * The "None" entry exists explicitly so users who run on
 * texts/email/calendar can answer the question without picking
 * something inaccurate. The chat downstream treats both `""` (unset)
 * and `"None — texts, email, or calendar only"` as "no formal CRM",
 * but the latter is what we want once Step 1 has been completed —
 * empty-string would imply the user skipped the field.
 */
export const CRM_OPTIONS: readonly CrmOption[] = [
  // value is a persisted sentinel (referenced by the onboarding chat prompt
  // and stored drafts) — only the LABEL is user-visible, so only it avoids
  // the em dash.
  { value: "None — texts, email, or calendar only", label: "None: texts, email, or calendar only" },
  { value: "HubSpot", label: "HubSpot" },
  { value: "Salesforce", label: "Salesforce" },
  { value: "Pipedrive", label: "Pipedrive" },
  { value: "Follow Up Boss", label: "Follow Up Boss" },
  { value: "Sierra Interactive", label: "Sierra Interactive" },
  { value: "kvCORE", label: "kvCORE" },
  { value: "BoomTown", label: "BoomTown" },
  { value: "Real Geeks", label: "Real Geeks" },
  { value: "Zoho CRM", label: "Zoho CRM" },
  { value: "GoHighLevel", label: "GoHighLevel" },
  { value: "ActiveCampaign", label: "ActiveCampaign" },
  { value: "Other", label: "Other (I'll type it in)" }
] as const;

export const CRM_OTHER_VALUE = "Other";

export const CRM_OTHER_PREFIX = "Other: ";

/**
 * Storage marker for "user picked Other from the dropdown but hasn't
 * typed the CRM name yet". Without this sentinel, an empty Other
 * state would round-trip through `serializeCrmSelection` → `""` →
 * `deriveCrmSelection` as `{ selection: "", … }`, which made the
 * dropdown visually reset to its placeholder and hid the "Which
 * CRM?" text input — Other became fully non-functional. The sentinel
 * preserves the in-flight selection across re-renders while still
 * being recognizable to `isCrmSelectionComplete` as an incomplete
 * answer that should block Step 1 advance.
 */
export const CRM_OTHER_SENTINEL = "Other:";

/**
 * Render the user's stored CRM string as a (selection, free-text)
 * pair the form UI can display. Round-trips with
 * `serializeCrmSelection`.
 *
 *   ""                                → { selection: "",      otherText: "" }
 *   "HubSpot"                         → { selection: "HubSpot", otherText: "" }
 *   "Other:"                          → { selection: "Other",   otherText: "" }
 *   "Other: My Custom CRM"            → { selection: "Other",   otherText: "My Custom CRM" }
 *   "Some Custom Thing"               → { selection: "Other",   otherText: "Some Custom Thing" }
 *
 * The last case is the legacy-localStorage path: pre-migration users
 * who typed a free-text CRM value get treated as "Other" so the form
 * doesn't lose their answer.
 */
export function deriveCrmSelection(stored: string | undefined | null): {
  selection: string;
  otherText: string;
} {
  const value = (stored ?? "").trim();
  if (!value) return { selection: "", otherText: "" };
  if (value === CRM_OTHER_SENTINEL) return { selection: CRM_OTHER_VALUE, otherText: "" };
  if (value.startsWith(CRM_OTHER_PREFIX)) {
    return { selection: CRM_OTHER_VALUE, otherText: value.slice(CRM_OTHER_PREFIX.length).trim() };
  }
  const matched = CRM_OPTIONS.find((option) => option.value.toLowerCase() === value.toLowerCase());
  if (matched) return { selection: matched.value, otherText: "" };
  // Unknown free-text value (legacy draft, copy-paste, etc.) → bucket
  // as Other so the user sees and can edit what they originally
  // entered rather than losing it on form rehydrate.
  return { selection: CRM_OTHER_VALUE, otherText: value };
}

/**
 * Inverse of `deriveCrmSelection`. The Other-with-empty-text case
 * serializes to the explicit `CRM_OTHER_SENTINEL` rather than `""`
 * so the dropdown can re-render in its Other state and reveal the
 * "Which CRM?" text input. Use `isCrmSelectionComplete` (not a raw
 * truthiness check) for advance-gate validation, since the sentinel
 * is intentionally truthy-but-incomplete.
 */
export function serializeCrmSelection(selection: string, otherText: string): string {
  if (!selection) return "";
  if (selection === CRM_OTHER_VALUE) {
    const trimmed = otherText.trim();
    return trimmed ? `${CRM_OTHER_PREFIX}${trimmed}` : CRM_OTHER_SENTINEL;
  }
  return selection;
}

/**
 * True when the stored CRM value represents a completed answer the
 * server can rely on. The empty string, the in-flight sentinel
 * `"Other:"`, AND the bare `"Other"` value all block advance;
 * everything else — including the explicit
 * `"None — texts, email, or calendar only"` entry — counts as a
 * complete answer.
 *
 * The bare `"Other"` case matters even though
 * `serializeCrmSelection` never produces it (it always writes the
 * sentinel or the prefixed form): a legacy localStorage draft, a
 * direct API caller, or any code path that wrote `CRM_OPTIONS`'
 * `Other` entry's `value` straight into storage would land here.
 * `deriveCrmSelection` correctly renders such a value as
 * `{ selection: "Other", otherText: "" }` and shows the empty
 * "Which CRM?" text input — letting the advance gate pass anyway
 * would short-circuit the user past the field.
 */
export function isCrmSelectionComplete(stored: string | undefined | null): boolean {
  const value = (stored ?? "").trim();
  if (!value) return false;
  if (value === CRM_OTHER_SENTINEL) return false;
  if (value === CRM_OTHER_VALUE) return false;
  if (value.startsWith(CRM_OTHER_PREFIX)) {
    return value.slice(CRM_OTHER_PREFIX.length).trim().length > 0;
  }
  return true;
}
