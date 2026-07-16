/**
 * Agent templates — prebuilt, reviewable starting points for common
 * document tasks. A template is nothing but prefill for the create form
 * (name + instructions + output format): the owner reviews and saves it as
 * a regular agent, and it runs ONLY when a staff member manually invokes
 * it — templates are never wired to flow triggers or starter flows.
 *
 * The quote templates encode the objectivity guardrail directly in their
 * instructions: they organize and compare information but must never
 * recommend an option — recommendations and any coverage/purchase advice
 * stay with the business's licensed/qualified staff. Wording is industry
 * neutral (insurance quotes, contractor bids, vendor proposals all fit).
 */

import type { AgentOutputFormat } from "./core";

export type AgentTemplate = {
  /** Stable identifier (UI keys + tests). */
  id: string;
  name: string;
  /** One-line gallery description. */
  description: string;
  instructions: string;
  outputFormat: AgentOutputFormat;
};

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "quote_comparison",
    name: "Quote comparison",
    description:
      "Compare provider quotes side by side — prices, inclusions, exclusions — without recommending one.",
    outputFormat: "markdown",
    instructions: [
      "You are comparing quotes/proposals from different providers for the same customer. The attached material contains one or more quotes (they may be pasted together or split across sections).",
      "",
      "Produce, in this exact order:",
      "",
      "1. **Comparison table** — one column per provider, one row per attribute. Include every attribute that appears in ANY quote: price/premium (with its billing period), deductibles or excess, what is included, optional add-ons/riders, exclusions or limitations, term/duration, payment terms, and stated conditions. Write \"not stated\" when a quote omits an attribute — never guess or fill in typical values.",
      "",
      "2. **Key differences** — short bullets calling out where the quotes genuinely differ: price gaps (with the amounts), scope/coverage differences, exclusions present in one but not another, and add-ons available in only some quotes.",
      "",
      "3. **Questions to clarify** — anything ambiguous, contradictory, or missing that a staff member should confirm with the provider before presenting options.",
      "",
      "4. **Customer-friendly summary** — a short plain-language section (no jargon, no table) a customer could read, presenting each option factually.",
      "",
      "Rules: present information objectively. Do NOT recommend an option, rank the quotes, or advise which is \"best\" — recommendations and any coverage or purchase advice stay with the business's licensed/qualified staff. Preserve every number exactly as written. Never invent facts."
    ].join("\n")
  },
  {
    id: "quote_request_package",
    name: "Quote request package",
    description:
      "Turn customer info into a clean, provider-ready quote request with a missing-details checklist.",
    outputFormat: "markdown",
    instructions: [
      "The attached material contains customer information (intake notes, forms, an existing policy or contract, or conversation notes). Organize it into a clean, provider-ready quote request package.",
      "",
      "Produce, in this exact order:",
      "",
      "1. **Request details** — the business's reference info found in the material: requesting staff member, date, and any internal reference numbers.",
      "",
      "2. **Customer profile** — name, contact details, address, and every identifying detail relevant to a quote (only what actually appears in the material).",
      "",
      "3. **What's being quoted** — the product/service/coverage requested, with every concrete specification found: amounts, limits, dates, property/vehicle/item details, and the current provider and terms when mentioned.",
      "",
      "4. **Current agreement facts** (when present) — existing policy/contract numbers, renewal or expiry dates, current pricing, and known claims or service history.",
      "",
      "5. **Missing information checklist** — the specific details a provider will likely require that the material does NOT contain, as a `- [ ]` checkbox list staff can work through with the customer.",
      "",
      "Rules: copy facts exactly — never invent, estimate, or fill in typical values. Flag anything illegible or contradictory instead of resolving it yourself. Add no advice or recommendations; this package is for information transfer only."
    ].join("\n")
  }
];

/** Template lookup by id; null for unknown ids. */
export function getAgentTemplate(id: string): AgentTemplate | null {
  return AGENT_TEMPLATES.find((t) => t.id === id) ?? null;
}
