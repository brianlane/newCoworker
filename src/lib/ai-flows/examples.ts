/**
 * Per-business-type example/placeholder copy for the AiFlows builder UI.
 *
 * These strings only seed NEW-step defaults and input placeholders — they never
 * touch stored flow definitions or existing variable names. Real estate keeps
 * the original literals verbatim (zero diff for existing tenants); every other
 * industry gets neutral, industry-agnostic equivalents.
 */
export type AiFlowExampleCopy = {
  /** Default variable name for an extracted phone number (browse_extract + send_sms). */
  contactVar: string;
  /** Placeholder for the flow Name field. */
  namePlaceholder: string;
  /** Placeholder for the "Generate with AI" prompt textarea. */
  aiPromptPlaceholder: string;
  /** Example variable shown in the Steps tip and browse_extract field placeholder. */
  tipVar: string;
  /** Example shown in the route_to_team "pin to one member" label. */
  pinExample: string;
  /** Placeholder for the per-step "Only run when" value input. */
  whenValuePlaceholder: string;
  /** Example used in the send_email Subject label. */
  emailSubjectExample: string;
};

const REAL_ESTATE_COPY: AiFlowExampleCopy = {
  contactVar: "seller_phone",
  namePlaceholder: "ReferralExchange lead follow-up",
  aiPromptPlaceholder:
    "When a ReferralExchange lead texts a link, open it, get the seller's phone, ask me to approve, then text them.",
  tipVar: "seller_phone",
  pinExample: "all seller leads to one agent",
  whenValuePlaceholder: "buyer",
  emailSubjectExample: "{{vars.lead_name}} BS RE"
};

const DEFAULT_COPY: AiFlowExampleCopy = {
  contactVar: "contact_phone",
  namePlaceholder: "New lead follow-up",
  aiPromptPlaceholder:
    "When a new lead texts a link, open it, get their phone number, ask me to approve, then text them.",
  tipVar: "contact_phone",
  pinExample: "all new leads to one team member",
  whenValuePlaceholder: "urgent",
  emailSubjectExample: "{{vars.lead_name}} — new inquiry"
};

/**
 * Real estate keeps its original builder copy verbatim. (Mortgage and other
 * industries get the neutral default — the ReferralExchange/seller phrasing is
 * specific to real-estate agents, unlike the FHA compliance guardrail which
 * also applies to mortgage lending.)
 */
export function getAiFlowExampleCopy(businessType?: string | null): AiFlowExampleCopy {
  return businessType === "real_estate" ? REAL_ESTATE_COPY : DEFAULT_COPY;
}
