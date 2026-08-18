import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { flattenSteps } from "../supabase/functions/_shared/ai_flows/branching";
import { FINAL_REMINDER_BANNER } from "../supabase/functions/_shared/ai_flows/offer_reminders";
import {
  HIGH_DOLLAR_WAIT_MINUTES,
  OLD_HIGH_VALUE_RULE,
  OWNER_NOTICE_OFF,
  UNCLAIMED_BANNER,
  addHighDollarTakeover,
  allSteps,
  bannerNotice,
  bannerOwnerFallbacks,
  findStepDeep,
  highDollarHeadline,
  rewriteHighDollarTemplate,
  rewriteHighDollarTemplates,
  silenceNotice,
  silenceNotices,
  withBanner,
  type Definition
} from "../scripts/oneshot/amy-owner-notice-policy";
import { FOLLOW_UP_TAG, buildNeedsFollowUpDefinition } from "../scripts/oneshot/amy-needs-follow-up-definition";

/**
 * Fixtures mirror the LIVE flows' relevant structure (step ids, the whens each
 * step really carries, the `*_team_unclaimed` shape), compact enough to read
 * but complete enough that parseAiFlowDefinition accepts the PATCHED result.
 * The applier refuses to write an invalid definition, so a fixture that cannot
 * validate would let a structural bug hide until apply time, which is exactly
 * how the first draft's invented guard var was caught.
 */

type Step = Record<string, unknown>;

function routeStep(id: string, extra: Step = {}): Step {
  return {
    id,
    type: "route_to_team",
    offerTemplate: "New lead: {{vars.lead_name}} ({{vars.lead_phone}})",
    ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}. It's back to you.",
    responseMinutes: 10,
    ...extra
  };
}

/** A `*_team_unclaimed` branch shaped exactly like the live ones. */
function teamUnclaimedBranch(prefix: string): Step {
  return {
    id: `${prefix}_team_unclaimed`,
    type: "branch",
    when: { var: "price_gate", notEquals: "ai" },
    question: "Did the offer lapse with nobody on it?",
    else: [],
    branches: [
      {
        id: `${prefix}_tu_open`,
        label: "Under $1M: the takeover can apply",
        condition: { var: "price_under_1m", notEquals: "no" },
        steps: [
          {
            id: `${prefix}_tu_wait`,
            type: "sleep",
            when: { var: "claimed_agent", equals: "none" },
            minutes: 120
          },
          {
            id: `${prefix}_tu_check`,
            type: "branch",
            question: "Still unclaimed?",
            else: [],
            branches: [
              {
                id: `${prefix}_tu_still`,
                label: "Still unclaimed",
                condition: { var: "claimed_agent", equals: "none" },
                steps: [
                  {
                    id: `${prefix}_tu_tag`,
                    type: "update_contact",
                    phoneVar: "lead_phone",
                    addTags: [FOLLOW_UP_TAG],
                    noteTemplate: "auto_first_contact: the AI already called"
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function fixture(prefix = "re"): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "referral" }] },
    steps: [
      {
        id: "read",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "price_gate" },
          { name: "price_under_1m" },
          { name: "route_lead_type" },
          { name: "lead_type" }
        ]
      },
      routeStep("route_seller", {
        ownerDirectWhen: { var: "price_under_1m", equals: "no" },
        ownerDirectNudges: true,
        ownerDirectTemplate:
          `${OLD_HIGH_VALUE_RULE}\n` +
          "HIGH-VALUE {{vars.lead_type}} lead ($1M+) kept for you, not offered to the team.\n" +
          "{{vars.lead_name}} ({{vars.lead_phone}})\n" +
          `${OLD_HIGH_VALUE_RULE}`
      }),
      {
        id: "notify",
        type: "notify_owner",
        when: { var: "route_lead_type", equals: "seller" },
        message: "AiFlow handled a lead: {{vars.lead_name}}."
      },
      {
        id: "notify_unclaimed",
        type: "notify_owner",
        when: { var: "claimed_agent", equals: "none" },
        message: "Not claimed: {{vars.lead_name}}."
      },
      {
        id: "wrap_up",
        type: "notify_owner",
        message: "Finished with {{vars.lead_name}}."
      },
      teamUnclaimedBranch(prefix)
    ]
  };
}

describe("the unclaimed banner", () => {
  it("is the same five characters the final claim reminder already uses", () => {
    // One banner, one meaning. If offer_reminders.ts ever changes its banner,
    // Amy's account would end up with two different "urgent" markers.
    expect(UNCLAIMED_BANNER).toBe(FINAL_REMINDER_BANNER);
  });

  it("prefixes text that does not have it yet", () => {
    expect(withBanner("Nobody claimed this.")).toBe(`${UNCLAIMED_BANNER}\nNobody claimed this.`);
  });

  it("is idempotent, so re-running never stacks banners", () => {
    const once = withBanner("Nobody claimed this.");
    expect(withBanner(once)).toBe(once);
  });

  it("banners every ownerFallbackTemplate in the flow, arms and else included", () => {
    const def = fixture();
    const notes: string[] = [];
    expect(bannerOwnerFallbacks(def, notes)).toBe(true);
    const templates = allSteps(def.steps)
      .map((s) => s.ownerFallbackTemplate)
      .filter((t): t is string => typeof t === "string");
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) expect(t.startsWith(UNCLAIMED_BANNER)).toBe(true);
  });

  it("reports no change on a second pass", () => {
    const def = fixture();
    bannerOwnerFallbacks(def, []);
    expect(bannerOwnerFallbacks(def, [])).toBe(false);
  });

  it("banners a named unclaimed notice", () => {
    const def = fixture();
    expect(bannerNotice(def, "notify_unclaimed", [])).toBe(true);
    expect(String(findStepDeep(def.steps, "notify_unclaimed")!.message)).toContain(
      UNCLAIMED_BANNER
    );
    expect(bannerNotice(def, "notify_unclaimed", [])).toBe(false);
  });

  it("refuses to banner a step that is not a notify_owner", () => {
    expect(() => bannerNotice(fixture(), "route_seller", [])).toThrow(/not found/);
  });
});

describe("silencing a routed notice", () => {
  it("keeps the step in place rather than deleting it", () => {
    // The whole point: ai_flow_runs.current_step is a flat index, so a
    // deleted step walks every parked run onto the wrong instruction.
    const def = fixture();
    const before = flattenSteps((def.steps ?? []) as never).map((e) => (e.step as Step).id);
    silenceNotice(def, "notify", undefined, []);
    const after = flattenSteps((def.steps ?? []) as never).map((e) => (e.step as Step).id);
    expect(after).toEqual(before);
  });

  it("reuses the var the step already reads, so the validator accepts it", () => {
    const def = fixture();
    silenceNotice(def, "notify", undefined, []);
    expect(findStepDeep(def.steps, "notify")!.when).toEqual({
      var: "route_lead_type",
      equals: OWNER_NOTICE_OFF
    });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("takes the caller's var when the step carries no when of its own", () => {
    const def = fixture();
    silenceNotice(def, "wrap_up", "lead_name", []);
    expect(findStepDeep(def.steps, "wrap_up")!.when).toEqual({
      var: "lead_name",
      equals: OWNER_NOTICE_OFF
    });
  });

  it("refuses to guess when the step has neither a when nor a fallback var", () => {
    expect(() => silenceNotice(fixture(), "wrap_up", undefined, [])).toThrow(/no fallback var/);
  });

  it("is idempotent", () => {
    const def = fixture();
    expect(silenceNotice(def, "notify", undefined, [])).toBe(true);
    expect(silenceNotice(def, "notify", undefined, [])).toBe(false);
  });

  it("refuses a step id that is not a notify_owner", () => {
    expect(() => silenceNotice(fixture(), "route_seller", "lead_name", [])).toThrow(/not found/);
  });

  it("accepts a mixed list of bare ids and [id, var] pairs", () => {
    const def = fixture();
    expect(silenceNotices(def, ["notify", ["wrap_up", "lead_name"]], [])).toBe(true);
    expect(findStepDeep(def.steps, "wrap_up")!.when).toEqual({
      var: "lead_name",
      equals: OWNER_NOTICE_OFF
    });
  });

  it("guards on a value no lead name, agent report, or verdict can hold", () => {
    // A guard that a teammate could accidentally type would switch a silenced
    // notice back on mid-run.
    expect(OWNER_NOTICE_OFF).toMatch(/^owner-notice-disabled-by-amy-\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the $1M+ owner notice", () => {
  it("replaces the asterisk rules with the red banner", () => {
    const out = rewriteHighDollarTemplate(
      `${OLD_HIGH_VALUE_RULE}\nHIGH-VALUE Clever lead ($1M+) kept for you, not offered to the team.\nx\n${OLD_HIGH_VALUE_RULE}`
    );
    expect(out).not.toContain(OLD_HIGH_VALUE_RULE);
    expect(out.startsWith(UNCLAIMED_BANNER)).toBe(true);
    expect(out.endsWith(UNCLAIMED_BANNER)).toBe(true);
  });

  it("puts the headline in capitals and says HIGH DOLLAR, the words Amy used", () => {
    const out = rewriteHighDollarTemplate(
      "HIGH-VALUE Realtor.com lead ($1M+) kept for you, not offered to the team."
    );
    expect(out).toBe("HIGH DOLLAR REALTOR.COM LEAD ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM.");
  });

  it("drops a placeholder from the headline rather than uppercasing it dead", () => {
    // {{VARS.LEAD_TYPE}} would render as literal text, so the type is left to
    // the detail lines below and every flow reads with the same shape.
    expect(highDollarHeadline("{{vars.lead_type}} lead")).toBe(
      "HIGH DOLLAR LEAD ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM."
    );
  });

  it("keeps the source name when the headline carries one", () => {
    expect(highDollarHeadline("HomeLight referral")).toBe(
      "HIGH DOLLAR HOMELIGHT REFERRAL ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM."
    );
  });

  it("leaves the detail lines alone", () => {
    const def = fixture();
    rewriteHighDollarTemplates(def, []);
    expect(String(findStepDeep(def.steps, "route_seller")!.ownerDirectTemplate)).toContain(
      "{{vars.lead_name}} ({{vars.lead_phone}})"
    );
  });

  it("is idempotent", () => {
    const def = fixture();
    expect(rewriteHighDollarTemplates(def, [])).toBe(true);
    expect(rewriteHighDollarTemplates(def, [])).toBe(false);
  });
});

describe("the $1M+ takeover arm", () => {
  it("adds the arm the branch never had", () => {
    const def = fixture();
    expect(addHighDollarTakeover(def, "re_team_unclaimed", "re", [])).toBe(true);
    const arm = findStepDeep(def.steps, "re_tu_high");
    expect(arm).toBeUndefined(); // the arm is a branch arm, not a step
    const branch = findStepDeep(def.steps, "re_team_unclaimed")!;
    const arms = branch.branches as Array<Record<string, unknown>>;
    expect(arms.map((a) => a.id)).toEqual(["re_tu_open", "re_tu_high"]);
  });

  it("fires exactly where the under-$1M arm does not", () => {
    const def = fixture();
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    const arms = (findStepDeep(def.steps, "re_team_unclaimed")!.branches ?? []) as Array<
      Record<string, unknown>
    >;
    // notEquals "no" and equals "no" are exhaustive and disjoint, so no lead
    // can match both arms and none falls through to the empty else.
    expect(arms[0].condition).toEqual({ var: "price_under_1m", notEquals: "no" });
    expect(arms[1].condition).toEqual({ var: "price_under_1m", equals: "no" });
  });

  it("leaves every index inside the existing arm untouched", () => {
    const def = fixture();
    const before = flattenSteps((def.steps ?? []) as never).map((e) => (e.step as Step).id);
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    const after = flattenSteps((def.steps ?? []) as never).map((e) => (e.step as Step).id);
    // Pure append: the old order is a prefix of the new one, so a parked run
    // at any existing index is still on the same instruction.
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("waits out Amy's three attempts before the AI takes over", () => {
    const def = fixture();
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    const wait = findStepDeep(def.steps, "re_tu_high_wait")!;
    expect(wait.minutes).toBe(HIGH_DOLLAR_WAIT_MINUTES);
    // The owner-direct nudges land at 10 and 30 minutes and the unclaimed
    // reminders run three rounds 20 minutes apart, so 120 clears both.
    expect(HIGH_DOLLAR_WAIT_MINUTES).toBeGreaterThan(30 + 3 * 20);
  });

  it("only tags a lead that is still unclaimed", () => {
    const def = fixture();
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    expect(findStepDeep(def.steps, "re_tu_high_wait")!.when).toEqual({
      var: "claimed_agent",
      equals: "none"
    });
    const check = findStepDeep(def.steps, "re_tu_high_check")!;
    const arms = check.branches as Array<Record<string, unknown>>;
    expect(arms[0].condition).toEqual({ var: "claimed_agent", equals: "none" });
  });

  it("hands the lead to the one cadence chokepoint", () => {
    const def = fixture();
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    expect(findStepDeep(def.steps, "re_tu_high_tag")!.addTags).toEqual([FOLLOW_UP_TAG]);
  });

  it("copies the flow's own phone var instead of assuming one", () => {
    const def = fixture();
    const tag = findStepDeep(def.steps, "re_tu_tag")!;
    tag.phoneVar = "group_lead_phone";
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    expect(findStepDeep(def.steps, "re_tu_high_tag")!.phoneVar).toBe("group_lead_phone");
  });

  it("does not carry the already-called note, because no call happened", () => {
    // A $1M+ lead went straight to Amy and was never contacted, so the
    // cadence's immediate round-1 call IS the first contact.
    const def = fixture();
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    expect(findStepDeep(def.steps, "re_tu_high_tag")!.noteTemplate).toBeUndefined();
  });

  it("is idempotent", () => {
    const def = fixture();
    expect(addHighDollarTakeover(def, "re_team_unclaimed", "re", [])).toBe(true);
    expect(addHighDollarTakeover(def, "re_team_unclaimed", "re", [])).toBe(false);
  });

  it("aborts rather than guessing when the branch is missing", () => {
    expect(() => addHighDollarTakeover(fixture(), "nope_team_unclaimed", "nope", [])).toThrow(
      /not found/
    );
  });

  it("aborts when there is no existing tag step to copy from", () => {
    const def = fixture();
    const branch = findStepDeep(def.steps, "re_team_unclaimed")!;
    (branch.branches as Array<Record<string, unknown>>)[0].steps = [];
    expect(() => addHighDollarTakeover(def, "re_team_unclaimed", "re", [])).toThrow(
      /no existing .* tag step/
    );
  });

  it("aborts when the branch has no arms at all", () => {
    const def = fixture();
    (findStepDeep(def.steps, "re_team_unclaimed") as Step).branches = [];
    expect(() => addHighDollarTakeover(def, "re_team_unclaimed", "re", [])).toThrow(/no arms/);
  });
});

describe("the patched definition", () => {
  it("still validates, which is what the applier gates the write on", () => {
    const def = fixture();
    bannerOwnerFallbacks(def, []);
    bannerNotice(def, "notify_unclaimed", []);
    silenceNotices(def, ["notify", ["wrap_up", "lead_name"]], []);
    rewriteHighDollarTemplates(def, []);
    addHighDollarTakeover(def, "re_team_unclaimed", "re", []);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });
});

describe("the cadence builder", () => {
  it("carries the banner too, so a re-seed cannot strip it back off", () => {
    // seed-amy-needs-follow-up-aiflow.ts re-applies this definition by name.
    // Without the banner in the builder, the next re-seed would quietly undo
    // the one-shot on all nine of the cadence's route steps.
    const def = buildNeedsFollowUpDefinition() as Definition;
    const fallbacks = allSteps(def.steps)
      .map((s) => s.ownerFallbackTemplate)
      .filter((t): t is string => typeof t === "string");
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const t of fallbacks) expect(t.startsWith(UNCLAIMED_BANNER)).toBe(true);
  });
});
