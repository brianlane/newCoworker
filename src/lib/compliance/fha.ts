const FORBIDDEN_TERMS = [
  "race",
  "color",
  "religion",
  "sex",
  "familial status",
  "disability",
  "national origin"
];

export function hasFhaRisk(text: string): boolean {
  const normalized = text.toLowerCase();
  return FORBIDDEN_TERMS.some((term) => normalized.includes(term));
}

export function buildComplianceSystemPrompt(): string {
  return [
    "Follow Fair Housing Act guardrails at all times.",
    "Never discriminate or steer based on protected classes.",
    "Escalate uncertain scenarios to the business owner.",
    "Keep responses factual, neutral, and professional."
  ].join(" ");
}
