import { describe, expect, it } from "vitest";
import {
  COPY_KEYS,
  patchCopyFields,
  stripEmDashesFromCopy
} from "../scripts/oneshot/strip-em-dashes-flows";

/**
 * The live-flow em-dash strip (README "Writing rule: NO EM DASHES"). Pins
 * the two properties production correctness rides on: only OUTPUT copy is
 * rewritten, and matcher fields (trigger conditions, matchTemplates and
 * friends) are never touched, since they exist to MATCH text that customers
 * and lead sources send.
 */

const EM = "\u2014";

describe("stripEmDashesFromCopy", () => {
  it("replaces separators with commas per the README policy", () => {
    expect(stripEmDashesFromCopy(`kept for you ${EM} not offered`)).toBe(
      "kept for you, not offered"
    );
    expect(stripEmDashesFromCopy(`${EM} The Team`)).toBe(", The Team");
    expect(stripEmDashesFromCopy(`a${EM}b`)).toBe("a, b");
  });

  it("is idempotent on clean copy", () => {
    const clean = "No dashes here, just commas.";
    expect(stripEmDashesFromCopy(clean)).toBe(clean);
  });
});

describe("patchCopyFields", () => {
  it("patches copy fields (incl. nested branch arms) and reports each", () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: `LIVE ${EM} TRANSFER` }] },
      steps: [
        { id: "s1", type: "send_sms", to: "{{vars.p}}", body: `Hi ${EM} there` },
        {
          id: "b",
          type: "branch",
          question: `Referral ${EM} yes?`,
          branches: [
            {
              id: "arm",
              condition: { var: "x", equals: "y" },
              steps: [{ id: "s2", type: "notify_owner", message: `Done ${EM} sent` }]
            }
          ]
        }
      ]
    };
    const patched = patchCopyFields(def);
    const paths = patched.map((p) => p.path).sort();
    expect(paths).toEqual([
      "steps[0].body",
      "steps[1].branches[0].steps[0].message",
      "steps[1].question"
    ]);
    expect((def.steps[0] as { body: string }).body).toBe("Hi, there");
    // Matcher field untouched: the trigger condition still carries the em dash.
    expect(def.trigger.conditions[0].value).toBe(`LIVE ${EM} TRANSFER`);
  });

  it("never rewrites non-copy strings even when they carry an em dash", () => {
    const def = {
      steps: [
        {
          id: "e",
          type: "email_extract",
          matchTemplates: [`{{vars.name}} ${EM} inquiry`],
          fromContains: `homelight ${EM} alerts`,
          fields: [{ name: "lead_name", description: `The name ${EM} never the agent's` }]
        }
      ]
    };
    const patched = patchCopyFields(def);
    // description IS copy (a model-facing prompt); the matchers are not.
    expect(patched.map((p) => p.path)).toEqual(["steps[0].fields[0].description"]);
    const step = def.steps[0] as { matchTemplates: string[]; fromContains: string };
    expect(step.matchTemplates[0]).toContain(EM);
    expect(step.fromContains).toContain(EM);
  });

  it("second pass is a no-op (idempotent)", () => {
    const def = { steps: [{ id: "s", type: "send_sms", to: "x", body: `A ${EM} B` }] };
    expect(patchCopyFields(def)).toHaveLength(1);
    expect(patchCopyFields(def)).toHaveLength(0);
  });

  it("copy-key set covers the send/offer/notify templates", () => {
    for (const key of [
      "body",
      "message",
      "subject",
      "offerTemplate",
      "ownerFallbackTemplate",
      "claimedNotifyTemplate",
      "ownerDirectTemplate"
    ]) {
      expect(COPY_KEYS.has(key)).toBe(true);
    }
  });
});
