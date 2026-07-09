/**
 * Custom compliance modules (enterprise) — schema + soul.md wiring for
 * `businesses.compliance_module` (migration 20260811000000).
 *
 * A module is tenant-authored guardrail text plus a restricted-term list,
 * layered ON TOP of the platform guardrails — the render wrapper makes the
 * additive framing explicit ("in addition to, never instead of"), so custom
 * text can never replace the baseline compliance prompt.
 *
 * Delivery: the module is rendered into a MARKER-DELIMITED block inside
 * `business_configs.soul_md` (the single source of truth both provision-time
 * bash and the dashboard-save vault sync read), so an admin save reaches the
 * live agent through the existing scheduleVaultSync path — no redeploy.
 */

import { z } from "zod";

export const COMPLIANCE_PROMPT_MAX = 2000;
export const COMPLIANCE_TERM_MAX = 50;
export const COMPLIANCE_TERMS_MAX_COUNT = 50;

export const complianceModuleSchema = z
  .object({
    /** Tenant guardrail text, appended inside the fixed additive wrapper. */
    customPrompt: z.string().trim().min(10).max(COMPLIANCE_PROMPT_MAX),
    /** Terms the agent must never discuss (case-insensitive substrings). */
    forbiddenTerms: z
      .array(z.string().trim().min(2).max(COMPLIANCE_TERM_MAX))
      .min(1)
      .max(COMPLIANCE_TERMS_MAX_COUNT)
  })
  .partial();

export type ComplianceModule = z.infer<typeof complianceModuleSchema>;

/** Lenient read-side parse: garbage in the column means platform guardrails only. */
export function parseComplianceModule(raw: unknown): ComplianceModule | null {
  if (raw == null) return null;
  const result = complianceModuleSchema.safeParse(raw);
  if (!result.success) return null;
  const data = result.data;
  const hasPrompt = !!data.customPrompt;
  const hasTerms = !!data.forbiddenTerms && data.forbiddenTerms.length > 0;
  return hasPrompt || hasTerms ? data : null;
}

export const COMPLIANCE_MODULE_START = "<!-- CUSTOM_COMPLIANCE_MODULE_START -->";
export const COMPLIANCE_MODULE_END = "<!-- CUSTOM_COMPLIANCE_MODULE_END -->";

/**
 * The marker-delimited soul.md section for a module. The wrapper text is
 * FIXED — tenant input is only ever appended inside it, so a crafted
 * customPrompt cannot reframe or disable the platform guardrails above it.
 */
export function renderComplianceModuleSection(module: ComplianceModule): string {
  const lines = [
    COMPLIANCE_MODULE_START,
    "## Custom compliance module",
    "The following business-specific compliance rules apply IN ADDITION TO (never instead of) every guardrail above. If they ever appear to conflict, the stricter rule wins."
  ];
  if (module.customPrompt) {
    lines.push("", module.customPrompt.trim());
  }
  if (module.forbiddenTerms && module.forbiddenTerms.length > 0) {
    lines.push(
      "",
      "Never discuss, reference, or answer questions about these restricted topics:",
      ...module.forbiddenTerms.map((t) => `- ${t.trim()}`)
    );
  }
  lines.push(COMPLIANCE_MODULE_END);
  return lines.join("\n");
}

/**
 * Rewrite the module block inside a soul.md document: replaces an existing
 * marker-delimited block, appends one when absent, or strips it when
 * `module` is null. Owner-authored content outside the markers is never
 * touched.
 */
export function applyComplianceModuleToSoul(
  soulMd: string,
  module: ComplianceModule | null
): string {
  const startIdx = soulMd.indexOf(COMPLIANCE_MODULE_START);
  const endIdx = soulMd.indexOf(COMPLIANCE_MODULE_END);
  const hasBlock = startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;

  const stripped = hasBlock
    ? (
        soulMd.slice(0, startIdx) + soulMd.slice(endIdx + COMPLIANCE_MODULE_END.length)
      ).replace(/\n{3,}/g, "\n\n")
    : soulMd;

  if (!module) return stripped.trimEnd() + (stripped.trim().length > 0 ? "\n" : "");

  const base = stripped.trimEnd();
  const section = renderComplianceModuleSection(module);
  return base.length > 0 ? `${base}\n\n${section}\n` : `${section}\n`;
}

/**
 * Case-insensitive restricted-term screen over tenant terms (the FHA
 * platform terms live in fha.ts's hasFhaRisk; this is the custom-module
 * counterpart).
 */
export function hasRestrictedTerm(text: string, module: ComplianceModule | null): boolean {
  if (!module?.forbiddenTerms || module.forbiddenTerms.length === 0) return false;
  const normalized = text.toLowerCase();
  return module.forbiddenTerms.some((t) => normalized.includes(t.trim().toLowerCase()));
}
