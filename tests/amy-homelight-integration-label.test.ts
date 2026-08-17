import { describe, it, expect } from "vitest";
import {
  NEW_LABEL,
  OLD_LABEL,
  integrationLabelsIn,
  relabelIntegration
} from "../scripts/oneshot/amy-homelight-integration-label-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the 2026-08-17 HomeLight credential incident.
 *
 * Amy's `custom_integrations` row was renamed "Home Light" -> "HomeLight" while
 * all ten of her live HomeLight browse steps still asked for the old spelling.
 * `getCustomIntegrationByLabel` matches with `ilike` on the trimmed label, so
 * it forgives case but NOT the space: every step resolved to
 * `integration_not_found`, which the render service reports as
 * `auth_config_error`, which the worker treats as PERMANENT. The next referral
 * would have died at step 2 with no claim and no lead reaching the team.
 *
 * The transform has to reach steps nested inside branch arms, because three of
 * the ten (`claim_verify`, `claim_retry`, `claim_verify2`) live there. A
 * trunk-only walk looks like it worked and leaves the flow broken.
 */

/** A stand-in shaped like the live HomeLight flow: trunk plus a branch arm. */
function liveish(label: string): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [{ type: "has_url" }, { type: "contains", value: "New HomeLight" }]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "open",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: label },
        fields: [{ name: "already_claimed", description: "yes or no" }]
      },
      {
        id: "lost_branch",
        type: "branch",
        question: "Did another agent claim it?",
        branches: [
          {
            id: "lb_claimed",
            label: "claimed",
            condition: { var: "already_claimed", equals: "yes" },
            steps: [
              {
                id: "claim_verify",
                type: "browse_extract",
                urlVar: "leadUrl",
                auth: { integrationLabel: label },
                fields: [{ name: "claim_state", description: "claimed or not" }]
              }
            ]
          }
        ],
        else: [
          {
            id: "claim_retry",
            type: "browse_action",
            urlVar: "leadUrl",
            auth: { integrationLabel: label },
            actions: [{ kind: "click_text", target: "Call me to claim referral" }]
          }
        ]
      }
    ]
  } as AiFlowDefinition;
}

describe("relabelIntegration", () => {
  it("rewrites trunk AND branch-nested steps", () => {
    const def = liveish(OLD_LABEL);
    const changed = relabelIntegration(def, OLD_LABEL, NEW_LABEL);

    // The nested two are the ones a trunk-only walk would miss.
    expect(changed.sort()).toEqual(["claim_retry", "claim_verify", "open"]);
    expect(integrationLabelsIn(def)).toEqual([NEW_LABEL]);
  });

  it("is idempotent: a second run changes nothing", () => {
    const def = liveish(OLD_LABEL);
    relabelIntegration(def, OLD_LABEL, NEW_LABEL);
    expect(relabelIntegration(def, OLD_LABEL, NEW_LABEL)).toEqual([]);
  });

  it("treats case and surrounding whitespace as already-matching", () => {
    // These already resolve to the same row through `ilike` + trim, so
    // rewriting them would be a live write that buys nothing.
    const def = liveish("  home light  ");
    const changed = relabelIntegration(def, OLD_LABEL, NEW_LABEL);
    expect(changed).toHaveLength(3);
    expect(integrationLabelsIn(def)).toEqual([NEW_LABEL]);
  });

  it("leaves other integrations alone", () => {
    const def = liveish("Clever");
    expect(relabelIntegration(def, OLD_LABEL, NEW_LABEL)).toEqual([]);
    expect(integrationLabelsIn(def)).toEqual(["Clever"]);
  });

  it("produces a definition the authoring validator still accepts", () => {
    const def = liveish(OLD_LABEL);
    relabelIntegration(def, OLD_LABEL, NEW_LABEL);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("keeps every other property of a step untouched", () => {
    const def = liveish(OLD_LABEL);
    const before = JSON.parse(JSON.stringify(def.steps[1]));
    relabelIntegration(def, OLD_LABEL, NEW_LABEL);
    const after = def.steps[1] as unknown as Record<string, unknown>;
    expect({ ...after, auth: undefined }).toEqual({ ...before, auth: undefined });
  });
});

describe("label constants", () => {
  it("differ only by the space, which is the whole bug", () => {
    expect(OLD_LABEL.replace(" ", "")).toBe(NEW_LABEL);
    expect(OLD_LABEL).not.toBe(NEW_LABEL);
  });
});
