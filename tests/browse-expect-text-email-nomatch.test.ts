import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";
import { EXPECT_TEXT_TIMEOUT_MS, waitForExpectedText } from "../vps/aiflow-render/actions.mjs";

/**
 * browse_action.expectText and email_extract.noMatchVars.
 *
 * Both exist because of the 2026-08-16 HomeLight incident on Amy Laidlaw's
 * account. Two referrals' claim clicks resolved the real
 * `data-test="submit-claim-referral"` button, Playwright delivered the click,
 * the step reported success, and Telnyx carrier records show HomeLight never
 * placed the claim callback for either; a human clicking the same button
 * produced it within seconds. A dispatched click is not an applied click on a
 * hydrating SPA, so a consequential action needs to assert the page's AFTER
 * state (`expectText`), not just that no exception was thrown.
 *
 * The same incident showed the reveal ladder inert: `email_extract` wrote NO
 * vars on a mailbox no-match, so every retry rung gated on
 * `status equals "missing"` was when_unmet the moment the first read found no
 * email. `noMatchVars` makes "looked and found nothing" a visible value.
 */

const TRIGGER = {
  channel: "sms",
  conditions: [{ type: "from_matches", value: "3142707635" }]
} as const;

describe("browse_action.expectText schema", () => {
  it("accepts a postcondition on a plain action step", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: TRIGGER,
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "claim",
          type: "browse_action",
          urlVar: "lead_url",
          auth: { integrationLabel: "Home Light" },
          actions: [{ kind: "click_text", target: "Call me to claim referral" }],
          continueWhenText: "Decline referral",
          expectText: "We're calling you at"
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects the postcondition on a forEachLink loop, which has no single after-page", () => {
    // parseAiFlowDefinition enforces semantics itself, so build the valid loop
    // first and graft the incompatible marker on before asking the validator.
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: TRIGGER,
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "loop",
          type: "browse_action",
          urlVar: "lead_url",
          forEachLink: "a.lead",
          actions: [{ kind: "click_text", target: "Provide Update" }]
        }
      ]
    });
    (def.steps[1] as { expectText?: string }).expectText = "Update saved";
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "loop" can\'t combine forEachLink with expectText; a loop has no single after-page to hold to the expectation.'
    );
  });

  it("rejects an empty or oversized marker", () => {
    for (const bad of ["", "x".repeat(201)]) {
      expect(() =>
        parseAiFlowDefinition({
          version: 1,
          trigger: TRIGGER,
          steps: [
            { id: "u", type: "extract_url", saveAs: "lead_url" },
            {
              id: "claim",
              type: "browse_action",
              urlVar: "lead_url",
              actions: [{ kind: "click_text", target: "Accept" }],
              expectText: bad
            }
          ]
        })
      ).toThrow();
    }
  });
});

describe("browse_action.expectText planner", () => {
  const step = {
    id: "claim",
    type: "browse_action",
    urlVar: "lead_url",
    auth: { integrationLabel: "Home Light" },
    actions: [{ kind: "click_text", target: "Call me to claim referral" }],
    expectText: " We're calling you at "
  } as unknown as FlowStep;

  it("forwards the trimmed marker to the worker action", () => {
    const plan = planStep(step, { vars: { lead_url: "https://agent.homelight.com/r/1" } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect((plan.action as { expectText?: string }).expectText).toBe("We're calling you at");
  });

  it("omits the field entirely when the step has none", () => {
    const bare = { ...(step as unknown as Record<string, unknown>) };
    delete bare.expectText;
    const plan = planStep(bare as unknown as FlowStep, {
      vars: { lead_url: "https://agent.homelight.com/r/1" }
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect("expectText" in (plan.action as Record<string, unknown>)).toBe(false);
  });
});

describe("waitForExpectedText (render service)", () => {
  function stubPage(behavior: "appears" | "never") {
    const calls: Array<{ needle: unknown; timeout: number | undefined }> = [];
    return {
      calls,
      page: {
        waitForFunction: async (
          _fn: unknown,
          needle: unknown,
          opts?: { timeout?: number }
        ): Promise<void> => {
          calls.push({ needle, timeout: opts?.timeout });
          if (behavior === "never") throw new Error("Timeout 10000ms exceeded.");
        }
      }
    };
  }

  it("resolves true when the marker appears, matching case-insensitively", async () => {
    const { page, calls } = stubPage("appears");
    await expect(waitForExpectedText(page, "  We're CALLING you  ")).resolves.toBe(true);
    // The needle is normalized once so the in-page predicate stays a plain includes().
    expect(calls).toEqual([{ needle: "we're calling you", timeout: EXPECT_TEXT_TIMEOUT_MS }]);
  });

  it("resolves false on timeout instead of throwing", async () => {
    const { page } = stubPage("never");
    await expect(waitForExpectedText(page, "We're calling you", 5)).resolves.toBe(false);
  });

  it("treats a blank marker as vacuously satisfied without touching the page", async () => {
    const { page, calls } = stubPage("never");
    await expect(waitForExpectedText(page, "   ")).resolves.toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("email_extract.noMatchVars schema", () => {
  function defWith(noMatchVars: unknown): AiFlowDefinition {
    return parseAiFlowDefinition({
      version: 1,
      trigger: TRIGGER,
      steps: [
        {
          id: "alert",
          type: "extract_text",
          fields: [{ name: "lead_first_name", description: "First name" }]
        },
        {
          id: "read",
          type: "email_extract",
          connectionId: "00000000-0000-4000-8000-000000000001",
          fromContains: "homelight.com",
          matchTemplates: ["{{vars.lead_first_name}}"],
          fields: [{ name: "u1_status", description: "found or missing" }],
          fillOnlyEmpty: true,
          ...(noMatchVars === undefined ? {} : { noMatchVars })
        },
        {
          id: "tell",
          type: "notify_owner",
          message: "Mailbox check: {{vars.u1_status}}",
          when: { var: "u1_status", notEquals: "found" }
        }
      ]
    });
  }

  it("accepts no-match defaults and counts the keys as produced vars", () => {
    const def = defWith({ u1_status: "missing" });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("registers a key that is NOT one of the extraction fields, too", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: TRIGGER,
      steps: [
        {
          id: "read",
          type: "email_extract",
          connectionId: "00000000-0000-4000-8000-000000000001",
          fields: [{ name: "lead_phone", description: "Phone" }],
          noMatchVars: { mailbox_checked: "empty" }
        },
        { id: "tell", type: "notify_owner", message: "Result: {{vars.mailbox_checked}}" }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects an empty record, a bad var name, an oversized value, and too many entries", () => {
    expect(() => defWith({})).toThrow();
    expect(() => defWith({ "1bad name": "missing" })).toThrow();
    expect(() => defWith({ u1_status: "x".repeat(81) })).toThrow();
    const tooMany = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`status_${i}`, "missing"])
    );
    expect(() => defWith(tooMany)).toThrow();
  });
});

describe("email_extract.noMatchVars planner", () => {
  const base = {
    id: "read",
    type: "email_extract",
    connectionId: "00000000-0000-4000-8000-000000000001",
    fromContains: "homelight.com",
    matchTemplates: ["{{vars.lead_first_name}}"],
    fields: [{ name: "u1_status", description: "found or missing" }],
    fillOnlyEmpty: true
  };

  it("forwards the defaults to the worker action", () => {
    const plan = planStep(
      { ...base, noMatchVars: { u1_status: "missing" } } as unknown as FlowStep,
      { vars: { lead_first_name: "Thomas" } }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect((plan.action as { noMatchVars?: Record<string, string> }).noMatchVars).toEqual({
      u1_status: "missing"
    });
  });

  it("omits the field when the step has none", () => {
    const plan = planStep(base as unknown as FlowStep, { vars: { lead_first_name: "Thomas" } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect("noMatchVars" in (plan.action as Record<string, unknown>)).toBe(false);
  });
});
