/** Rough token estimate for English-ish markdown (~4 characters per token). */
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
  maxTokens: number = STARTER_VAULT_MAX_ESTIMATED_TOKENS
): { estimatedTotal: number; maxTokens: number; overBudget: boolean } {
  const estimatedTotal =
    estimateTokenCountRough(soulMd) +
    estimateTokenCountRough(identityMd) +
    estimateTokenCountRough(memoryMd);
  return {
    estimatedTotal,
    maxTokens,
    overBudget: estimatedTotal > maxTokens
  };
}
