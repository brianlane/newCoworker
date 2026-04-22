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

  it("counts websiteMd against the starter budget so the crawl summary cannot silently blow it", () => {
    // Crawl summary is capped at 8k chars (~2k tokens). With soul/identity/memory
    // empty but a full websiteMd, we should already be at the limit — any more
    // content anywhere must flip `overBudget`.
    const websiteMd = "w".repeat(8000);
    const atLimit = starterVaultBudgetStatus("", "", "", websiteMd);
    expect(atLimit.estimatedTotal).toBe(2000);
    expect(atLimit.overBudget).toBe(false);

    const over = starterVaultBudgetStatus("s".repeat(4), "", "", websiteMd);
    expect(over.estimatedTotal).toBeGreaterThan(2000);
    expect(over.overBudget).toBe(true);
  });

  it("defaults websiteMd to empty for older callers so existing budget math is unchanged", () => {
    // Calling without the 4th arg must behave exactly like calling with "". This
    // guards the optional-parameter contract: existing prompt composers that
    // haven't opted in yet must still compute the same total.
    const legacy = starterVaultBudgetStatus("abcd", "abcd", "abcd");
    const explicit = starterVaultBudgetStatus("abcd", "abcd", "abcd", "");
    expect(legacy).toEqual(explicit);
  });

  it("respects the maxTokens override after websiteMd is in the mix", () => {
    const res = starterVaultBudgetStatus("", "", "", "w".repeat(400), 50);
    // 400 chars ≈ 100 tokens > 50 override → over budget.
    expect(res.maxTokens).toBe(50);
    expect(res.overBudget).toBe(true);
  });
});
