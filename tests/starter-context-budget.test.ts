import { describe, expect, it } from "vitest";
import {
  estimateTokenCountRough,
  starterVaultBudgetStatus,
  STARTER_VAULT_MAX_ESTIMATED_TOKENS
} from "@/lib/vault/starterContextBudget";

describe("starterContextBudget", () => {
  it("estimateTokenCountRough rounds up by ~4 chars per token", () => {
    expect(estimateTokenCountRough("")).toBe(0);
    expect(estimateTokenCountRough("abcd")).toBe(1);
    expect(estimateTokenCountRough("abcdefgh")).toBe(2);
  });

  it("starterVaultBudgetStatus sums fields and flags over budget", () => {
    const atLimit = "x".repeat(8000);
    const s = starterVaultBudgetStatus(atLimit, "", "");
    expect(s.estimatedTotal).toBe(2000);
    expect(s.overBudget).toBe(false);
    const over = starterVaultBudgetStatus(atLimit + "x", "", "");
    expect(over.estimatedTotal).toBeGreaterThan(2000);
    expect(over.overBudget).toBe(true);
  });

  it("exports default max aligned with TTFT guidance", () => {
    expect(STARTER_VAULT_MAX_ESTIMATED_TOKENS).toBe(2000);
  });
});
