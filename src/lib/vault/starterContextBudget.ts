/**
 * Rough token estimate for English-ish markdown (~4 characters per token).
 * The ~2k combined vault target below matches KVM2-style integration expectations
 * (`npm run test:integration`, optional Rowboat bot) — large vaults increase prefill / TTFT risk on starter VPS.
 */
export function estimateTokenCountRough(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Soft budget for combined vault markdown on starter (KVM2) to limit prefill / TTFT risk. */
export const STARTER_VAULT_MAX_ESTIMATED_TOKENS = 2000;

export function starterVaultBudgetStatus(
  soulMd: string,
  identityMd: string,
  memoryMd: string,
  /**
   * Onboarding-crawled website summary capped at 8k chars (`WEBSITE_INGEST_MAX_SUMMARY_CHARS`).
   * It gets injected into the Gemini Live / Rowboat prompt alongside soul/identity/memory, so
   * it counts against the KVM2 prefill budget and must be included here. The parameter is
   * optional (default "") to keep older callers — dashboard, prompt composers — compiling
   * until they opt in.
   */
  websiteMd: string = "",
  maxTokens: number = STARTER_VAULT_MAX_ESTIMATED_TOKENS
): { estimatedTotal: number; maxTokens: number; overBudget: boolean } {
  const estimatedTotal =
    estimateTokenCountRough(soulMd) +
    estimateTokenCountRough(identityMd) +
    estimateTokenCountRough(memoryMd) +
    estimateTokenCountRough(websiteMd);
  return {
    estimatedTotal,
    maxTokens,
    overBudget: estimatedTotal > maxTokens
  };
}
