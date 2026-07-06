import { describe, expect, it } from "vitest";
import {
  simplifyClaimOptions,
  CLAIM_ETA_HINT_LINE
} from "../scripts/oneshot/simplify-claim-options";
import { parseAiFlowDefinition } from "../src/lib/ai-flows/schema";

/** Amy's ReferralExchange seller route as patched by the superseded one-shot. */
function referralExchangeDef() {
  return {
    version: 1 as const,
    trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
    steps: [
      {
        id: "route_seller",
        type: "route_to_team",
        agentName: "Dave Lane",
        claimTimeframeOption: 3,
        lateClaimOption: 4,
        offerTemplate:
          "New seller lead. " +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
          "Lead source: realestateagents.com\n" +
          "Reply 3 with a timeframe to claim and tell us when you'll reach out " +
          '(e.g. "3, 20 min").\n' +
          'Lapsed lead? Reply "4, <ETA>" to claim it after its window — ' +
          'ETA of when you can please triple tap this lead? (e.g. "4, tomorrow am").',
        responseMinutes: 10,
        ownerFallbackTemplate: "No one claimed it — back to you."
      }
    ]
  };
}

describe("simplifyClaimOptions", () => {
  it("strips the 3/4 option lines, drops both option digits, and appends the universal ETA hint", () => {
    const def = referralExchangeDef();
    expect(simplifyClaimOptions(def)).toBe(true);
    const step = def.steps[0] as {
      offerTemplate: string;
      claimTimeframeOption?: number;
      lateClaimOption?: number;
    };
    expect(step.claimTimeframeOption).toBeUndefined();
    expect(step.lateClaimOption).toBeUndefined();
    expect(step.offerTemplate).not.toContain("with a timeframe to claim and tell us");
    expect(step.offerTemplate).not.toContain("triple tap this lead");
    // Authored lines survive.
    expect(step.offerTemplate).toContain("Reply 1 to claim or 2 to pass");
    expect(step.offerTemplate).toContain("Lead source: realestateagents.com");
    // The timeframe affordance stays visible, on the universal digit.
    expect(step.offerTemplate).toContain(CLAIM_ETA_HINT_LINE);
    // Patched definition stays valid against the canonical schema.
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent (second run is a no-op)", () => {
    const def = referralExchangeDef();
    expect(simplifyClaimOptions(def)).toBe(true);
    const once = JSON.stringify(def);
    expect(simplifyClaimOptions(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(once);
  });

  it("handles the HomeLight shape (timeframe digit 2 baked into the copy, retro 3)", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        {
          id: "route",
          type: "route_to_team",
          agentName: "Dave Lane",
          claimTimeframeOption: 2,
          lateClaimOption: 3,
          offerTemplate:
            "New HomeLight referral.\n" +
            "Reply 1 to confirm you're taking it by {{offer.deadline}}.\n" +
            "Reply 2 with a timeframe to claim and tell us when you'll reach out " +
            '(e.g. "2, 20 min").\n' +
            'Lapsed lead? Reply "3, <ETA>" to claim it after its window — ' +
            'ETA of when you can please triple tap this lead? (e.g. "3, tomorrow am").',
          responseMinutes: 5,
          ownerFallbackTemplate: "Back to you."
        }
      ]
    };
    expect(simplifyClaimOptions(def)).toBe(true);
    const step = def.steps[0] as {
      offerTemplate: string;
      claimTimeframeOption?: number;
      lateClaimOption?: number;
    };
    expect(step.claimTimeframeOption).toBeUndefined();
    expect(step.lateClaimOption).toBeUndefined();
    expect(step.offerTemplate).not.toContain("Reply 2 with a timeframe");
    expect(step.offerTemplate).not.toContain("triple tap this lead");
    expect(step.offerTemplate).toContain("Reply 1 to confirm you're taking it");
    expect(step.offerTemplate).toContain(CLAIM_ETA_HINT_LINE);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("leaves a round-robin offer with no options untouched, including authored 'triple tap' copy", () => {
    // Realtor.com's route step: no option digits, and an AUTHORED ETA ask that
    // must never be stripped (the retro marker includes "this lead" exactly so
    // this line doesn't match).
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        {
          id: "s4",
          type: "route_to_team",
          offerTemplate:
            "New Realtor.com Buyer Lead.\n" +
            "ETA of when you can please triple tap? Thanks.\n" +
            "Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.",
          responseMinutes: 10,
          ownerFallbackTemplate: "Back to you."
        }
      ]
    };
    const before = JSON.stringify(def);
    expect(simplifyClaimOptions(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(before);
  });

  it("does not duplicate the hint when the offer already advertises the 1, <ETA> form", () => {
    const def = referralExchangeDef();
    const step = def.steps[0] as { offerTemplate: string };
    step.offerTemplate += `\n${CLAIM_ETA_HINT_LINE}`;
    expect(simplifyClaimOptions(def)).toBe(true);
    const hits = step.offerTemplate
      .split("\n")
      .filter((l) => l.includes('"1, <ETA>"')).length;
    expect(hits).toBe(1);
  });

  it("ignores non-route steps", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [{ id: "url", type: "extract_url", saveAs: "lead_url" }]
    };
    expect(simplifyClaimOptions(def)).toBe(false);
  });
});
