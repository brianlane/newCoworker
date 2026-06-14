const FORBIDDEN_TERMS = [
  "race",
  "color",
  "religion",
  "sex",
  "familial status",
  "disability",
  "national origin"
];

/**
 * Business types subject to Fair Housing Act guardrails. Real estate and
 * mortgage lending both fall under FHA, so they share the housing-specific
 * compliance prompt; every other industry gets the generic guardrail.
 */
const FHA_BUSINESS_TYPES = new Set(["real_estate", "mortgage_brokerage"]);

export function isFhaBusinessType(businessType?: string | null): boolean {
  return businessType != null && FHA_BUSINESS_TYPES.has(businessType);
}

export function hasFhaRisk(text: string): boolean {
  const normalized = text.toLowerCase();
  return FORBIDDEN_TERMS.some((term) => normalized.includes(term));
}

/**
 * Compliance guardrail injected into the agent's system prompt. Housing
 * business types (see {@link FHA_BUSINESS_TYPES}) keep the Fair Housing Act
 * guardrail verbatim; all other industries — and unknown/undefined types —
 * get an industry-neutral legal/ethical guardrail.
 */
export function buildComplianceSystemPrompt(businessType?: string | null): string {
  if (isFhaBusinessType(businessType)) {
    return [
      "Follow Fair Housing Act guardrails at all times.",
      "Never discriminate or steer based on protected classes.",
      "Escalate uncertain scenarios to the business owner.",
      "Keep responses factual, neutral, and professional."
    ].join(" ");
  }
  return [
    "Follow the legal and ethical guardrails that apply to your industry at all times.",
    "Never discriminate against or harass anyone, and do not make promises the business has not authorized.",
    "Escalate uncertain or sensitive scenarios to the business owner.",
    "Keep responses factual, neutral, and professional."
  ].join(" ");
}
