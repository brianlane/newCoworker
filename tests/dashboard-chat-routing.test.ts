/**
 * Dashboard-chat turn routing (src/lib/dashboard-chat/routing.ts):
 * inline-primary / worker-fallback / attachment-refusal decision matrix.
 */
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_NOT_CONFIGURED_MESSAGE,
  ATTACHMENT_OVER_BUDGET_MESSAGE,
  resolveChatTurnRoute
} from "@/lib/dashboard-chat/routing";
import type { ChatSpendSnapshot } from "@/lib/db/chat-usage";

function spend(spendMicros: number, capMicros: number): ChatSpendSnapshot {
  return {
    periodStart: "2026-07-01T00:00:00.000Z",
    spendMicros,
    baseCapMicros: capMicros,
    creditMicros: 0,
    effectiveCapMicros: capMicros
  };
}

describe("resolveChatTurnRoute", () => {
  it("routes inline when the key is present and spend is under the cap", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: false, apiKeyPresent: true, spend: spend(1, 100) })
    ).toEqual({ kind: "inline" });
    expect(
      resolveChatTurnRoute({ hasAttachment: true, apiKeyPresent: true, spend: spend(1, 100) })
    ).toEqual({ kind: "inline" });
  });

  it("fails OPEN to inline when the spend read failed (null snapshot)", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: false, apiKeyPresent: true, spend: null })
    ).toEqual({ kind: "inline" });
  });

  it("falls back to the worker without an API key (text turns)", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: false, apiKeyPresent: false, spend: null })
    ).toEqual({ kind: "worker" });
  });

  it("refuses attachment turns without an API key", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: true, apiKeyPresent: false, spend: spend(0, 100) })
    ).toEqual({ kind: "refuse", message: ATTACHMENT_NOT_CONFIGURED_MESSAGE });
  });

  it("falls back to the worker over cap (text turns) — the worker owns the local-model degrade", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: false, apiKeyPresent: true, spend: spend(100, 100) })
    ).toEqual({ kind: "worker" });
  });

  it("refuses attachment turns over cap with the budget message", () => {
    expect(
      resolveChatTurnRoute({ hasAttachment: true, apiKeyPresent: true, spend: spend(150, 100) })
    ).toEqual({ kind: "refuse", message: ATTACHMENT_OVER_BUDGET_MESSAGE });
  });
});
