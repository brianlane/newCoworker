import { describe, expect, it } from "vitest";
import {
  OFFER_REPLY_DECISION,
  staleOfferDecision
} from "../supabase/functions/_shared/ai_flows/telemetry_decisions";

describe("OFFER_REPLY_DECISION", () => {
  it("every decision value equals its key (grep-ability: the constant IS the wire string)", () => {
    for (const [key, value] of Object.entries(OFFER_REPLY_DECISION)) {
      expect(value).toBe(key);
    }
  });
});

describe("staleOfferDecision", () => {
  it("maps every stale-offer kind to its namespaced decision", () => {
    expect(staleOfferDecision("claimed_by_sender")).toBe("stale_claimed_by_sender");
    expect(staleOfferDecision("claimed_by_other")).toBe("stale_claimed_by_other");
    expect(staleOfferDecision("live_with_other")).toBe("stale_live_with_other");
    expect(staleOfferDecision("moved_on")).toBe("stale_moved_on");
  });
});
