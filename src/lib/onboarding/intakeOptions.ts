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
  { value: "None — texts, email, or calendar only", label: "None — texts, email, or calendar only" },
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
 * Render the user's stored CRM string as a (selection, free-text)
 * pair the form UI can display. Round-trips with
 * `serializeCrmSelection`.
 *
 *   ""                                → { selection: "",      otherText: "" }
 *   "HubSpot"                         → { selection: "HubSpot", otherText: "" }
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
 * Inverse of `deriveCrmSelection`. The `Other` selection without
 * non-empty text is intentionally serialized as `""` (treated as
 * "field not yet filled in"), so step-advance validation can flag it
 * the same way a blank dropdown would be.
 */
export function serializeCrmSelection(selection: string, otherText: string): string {
  if (!selection) return "";
  if (selection === CRM_OTHER_VALUE) {
    const trimmed = otherText.trim();
    return trimmed ? `${CRM_OTHER_PREFIX}${trimmed}` : "";
  }
  return selection;
}
