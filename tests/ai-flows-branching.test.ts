import { describe, expect, it } from "vitest";
import {
  AiFlowValidationError,
  MAX_BRANCH_ARMS,
  parseAiFlowDefinition,
  validateDefinitionSemantics,
  type AiFlowDefinition,
  type FlowStep
} from "@/lib/ai-flows/schema";
import {
  BRANCH_ELSE_ARM,
  branchChoiceVar,
  chooseBranchArm,
  flattenSteps,
  isOnActivePath
} from "../supabase/functions/_shared/ai_flows/branching";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep as EngineFlowStep } from "../supabase/functions/_shared/ai_flows/types";

/** Parse and return the flat issue list ([] when the definition is valid). */
function issuesOf(input: unknown): string[] {
  try {
    parseAiFlowDefinition(input);
    return [];
  } catch (e) {
    if (e instanceof AiFlowValidationError) return e.issues;
    throw e;
  }
}

/** A minimal valid branch flow: extract a field, branch on it, notify after. */
function branchFlow(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [{ name: "insurance_type", description: "auto or home" }]
      },
      {
        id: "s2",
        type: "branch",
        question: "What insurance type?",
        branches: [
          {
            id: "b_auto",
            label: "Auto",
            condition: { var: "insurance_type", contains: "auto" },
            steps: [{ id: "s2a", type: "notify_owner", message: "Auto lead" }]
          },
          {
            id: "b_home",
            label: "Home",
            condition: { var: "insurance_type", contains: "home" },
            steps: [{ id: "s2b", type: "notify_owner", message: "Home lead" }]
          }
        ],
        else: [{ id: "s2e", type: "notify_owner", message: "Other lead" }]
      },
      { id: "s3", type: "notify_owner", message: "Done either way" }
    ],
    ...overrides
  };
}

describe("branch step authoring schema", () => {
  it("accepts a valid multi-branch flow", () => {
    const def = parseAiFlowDefinition(branchFlow());
    const branch = def.steps[1];
    if (branch.type !== "branch") throw new Error("expected branch step");
    expect(branch.branches.map((a) => a.label)).toEqual(["Auto", "Home"]);
    expect(branch.else).toHaveLength(1);
  });

  it("rejects more than MAX_BRANCH_ARMS arms", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as { branches: Array<Record<string, unknown>> };
    const arm = branch.branches[0];
    branch.branches = Array.from({ length: MAX_BRANCH_ARMS + 1 }, (_, i) => ({
      ...arm,
      id: `b${i}`,
      steps: []
    }));
    expect(issuesOf(flow).length).toBeGreaterThan(0);
  });

  it("rejects branches nested more than 3 levels deep", () => {
    const nested = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { id: `leaf`, type: "notify_owner", message: "hi" }
        : {
            id: `br${depth}`,
            type: "branch",
            question: "Deeper?",
            branches: [
              {
                id: `arm${depth}`,
                label: "Yes",
                condition: { var: "insurance_type", contains: "auto" },
                steps: [nested(depth - 1)]
              }
            ],
            else: []
          };
    const flow = branchFlow() as { steps: unknown[] };
    flow.steps[1] = nested(4);
    expect(issuesOf(flow).join("\n")).toMatch(/nests branches more than 3 levels/);
  });

  it("rejects a duplicate step id inside a branch arm", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as {
      branches: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    branch.branches[0].steps[0].id = "s1"; // clashes with the trunk extract step
    expect(issuesOf(flow).join("\n")).toMatch(/Duplicate step id "s1"/);
  });

  it('rejects an arm named "else" and duplicate arm ids', () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as { branches: Array<Record<string, unknown>> };
    branch.branches[0].id = "else";
    expect(issuesOf(flow).join("\n")).toMatch(/reserved for the none-matched path/);

    const flow2 = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch2 = flow2.steps[1] as { branches: Array<Record<string, unknown>> };
    branch2.branches[1].id = branch2.branches[0].id as string;
    expect(issuesOf(flow2).join("\n")).toMatch(/two branches with the id/);
  });

  it("rejects an arm condition on a var no earlier step produces", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as { branches: Array<Record<string, unknown>> };
    branch.branches[0].condition = { var: "never_produced", contains: "x" };
    expect(issuesOf(flow).join("\n")).toMatch(/never_produced/);
  });

  it("rejects a voice step inside a branch arm on a non-voice flow", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as {
      branches: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    branch.branches[0].steps.push({ id: "v1", type: "voice_transfer", toE164: "+16025551234" });
    expect(issuesOf(flow).join("\n")).toMatch(/voice steps need a voice trigger/);
  });

  it("lets a var produced inside an arm feed a later trunk step (permissive scope)", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as {
      branches: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    branch.branches[0].steps.push({
      id: "x1",
      type: "extract_text",
      fields: [{ name: "arm_var" }]
    });
    flow.steps[2] = { id: "s3", type: "notify_owner", message: "Got {{vars.arm_var}}" };
    expect(issuesOf(flow)).toEqual([]);
  });

  it("enforces the definition-wide total step cap across arms", () => {
    const manySteps = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${i}`,
        type: "notify_owner",
        message: "hi"
      }));
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    const branch = flow.steps[1] as {
      branches: Array<{ steps: unknown[] }>;
      else: unknown[];
    };
    branch.branches[0].steps = manySteps("a", 25);
    branch.branches[1].steps = manySteps("b", 25);
    expect(issuesOf(flow).join("\n")).toMatch(/limit is 50/);
  });

  it("accepts a branch `when` guard and checks its var scope", () => {
    const flow = branchFlow() as { steps: Array<Record<string, unknown>> };
    (flow.steps[1] as Record<string, unknown>).when = {
      var: "insurance_type",
      notEquals: "none"
    };
    expect(issuesOf(flow)).toEqual([]);

    (flow.steps[1] as Record<string, unknown>).when = { var: "missing_var", equals: "x" };
    expect(issuesOf(flow).join("\n")).toMatch(/missing_var/);
  });
});

describe("flow time window schema", () => {
  it("accepts a valid time window", () => {
    const def = parseAiFlowDefinition(
      branchFlow({
        timeWindow: { timezone: "America/Phoenix", start: "09:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }
      })
    );
    expect(def.timeWindow?.start).toBe("09:00");
  });

  it("rejects a zero-length window and malformed times", () => {
    expect(
      issuesOf(
        branchFlow({ timeWindow: { timezone: "America/Phoenix", start: "09:00", end: "09:00" } })
      ).join("\n")
    ).toMatch(/can't start and end at the same time/);
    expect(
      issuesOf(
        branchFlow({ timeWindow: { timezone: "America/Phoenix", start: "9am", end: "17:00" } })
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("validateDefinitionSemantics on a parsed branch flow", () => {
  it("returns no issues for the valid fixture", () => {
    const def = parseAiFlowDefinition(branchFlow());
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

// ── Engine-side flattening + choice helpers (Deno shared module) ──

function engineBranchStep(): Extract<EngineFlowStep, { type: "branch" }> {
  return {
    id: "s2",
    type: "branch",
    question: "What insurance type?",
    branches: [
      {
        id: "b_auto",
        label: "Auto",
        condition: { var: "insurance_type", contains: "auto" },
        steps: [{ id: "s2a", type: "notify_owner", message: "Auto lead" }]
      },
      {
        id: "b_home",
        label: "Home",
        condition: { var: "insurance_type", contains: "home" },
        steps: [{ id: "s2b", type: "notify_owner", message: "Home lead" }]
      }
    ],
    else: [{ id: "s2e", type: "notify_owner", message: "Other lead" }]
  };
}

describe("flattenSteps", () => {
  const trunk: EngineFlowStep[] = [
    { id: "s1", type: "extract_text", fields: [{ name: "insurance_type" }] },
    engineBranchStep(),
    { id: "s3", type: "notify_owner", message: "Done" }
  ];

  it("emits branch first, then arms in order, then else, then the trunk", () => {
    const flat = flattenSteps(trunk);
    expect(flat.map((e) => e.step.id)).toEqual(["s1", "s2", "s2a", "s2b", "s2e", "s3"]);
    expect(flat[0].branchPath).toEqual([]);
    expect(flat[2].branchPath).toEqual([{ branchStepId: "s2", armId: "b_auto" }]);
    expect(flat[3].branchPath).toEqual([{ branchStepId: "s2", armId: "b_home" }]);
    expect(flat[4].branchPath).toEqual([{ branchStepId: "s2", armId: BRANCH_ELSE_ARM }]);
    expect(flat[5].branchPath).toEqual([]);
  });

  it("is deterministic (same definition, same order)", () => {
    expect(flattenSteps(trunk)).toEqual(flattenSteps(trunk));
  });

  it("carries the full hop chain for nested branches", () => {
    const nested: EngineFlowStep[] = [
      {
        id: "outer",
        type: "branch",
        question: "Q1",
        branches: [
          {
            id: "o1",
            label: "One",
            condition: { var: "x", equals: "1" },
            steps: [
              {
                id: "inner",
                type: "branch",
                question: "Q2",
                branches: [
                  {
                    id: "i1",
                    label: "A",
                    condition: { var: "y", equals: "a" },
                    steps: [{ id: "leaf", type: "notify_owner", message: "deep" }]
                  }
                ],
                else: []
              }
            ]
          }
        ],
        else: []
      }
    ];
    const flat = flattenSteps(nested);
    const leaf = flat.find((e) => e.step.id === "leaf");
    expect(leaf?.branchPath).toEqual([
      { branchStepId: "outer", armId: "o1" },
      { branchStepId: "inner", armId: "i1" }
    ]);
  });

  it("keeps goal checkpoints stable in the flat order (jump indices depend on it)", () => {
    const withGoal: EngineFlowStep[] = [
      { id: "s1", type: "extract_text", fields: [{ name: "insurance_type" }] },
      engineBranchStep(),
      { id: "g1", type: "goal", label: "Booked", events: [{ kind: "appointment_booked" }] },
      { id: "s3", type: "notify_owner", message: "Done" }
    ];
    const flat = flattenSteps(withGoal);
    expect(flat.map((e) => e.step.id)).toEqual(["s1", "s2", "s2a", "s2b", "s2e", "g1", "s3"]);
    // Trunk goal: empty branchPath — exactly what makes it a legal jump target.
    expect(flat[5].branchPath).toEqual([]);
    expect(flattenSteps(withGoal)).toEqual(flattenSteps(withGoal));
  });

  it("drops malformed entries instead of throwing", () => {
    const corrupt = [
      null,
      42,
      { type: "notify_owner", message: "no id" },
      { id: "ok", type: "notify_owner", message: "hi" },
      { id: "bad_branch", type: "branch", question: "?", branches: "nope", else: null }
    ] as unknown as EngineFlowStep[];
    const flat = flattenSteps(corrupt);
    expect(flat.map((e) => e.step.id)).toEqual(["ok", "bad_branch"]);
    expect(flattenSteps("nope" as unknown as EngineFlowStep[])).toEqual([]);
  });

  it("drops malformed arms and non-array arm steps instead of throwing", () => {
    const corrupt = [
      {
        id: "br",
        type: "branch",
        question: "?",
        branches: [
          null,
          { label: "no id", condition: { var: "x", equals: "1" }, steps: [] },
          { id: "good", label: "Good", condition: { var: "x", equals: "1" }, steps: "nope" }
        ],
        else: [{ id: "e1", type: "notify_owner", message: "else" }]
      }
    ] as unknown as EngineFlowStep[];
    const flat = flattenSteps(corrupt);
    expect(flat.map((e) => e.step.id)).toEqual(["br", "e1"]);
    expect(flat[1].branchPath).toEqual([{ branchStepId: "br", armId: BRANCH_ELSE_ARM }]);
  });
});

describe("chooseBranchArm + isOnActivePath", () => {
  it("picks the first matching arm (top to bottom)", () => {
    expect(chooseBranchArm(engineBranchStep(), { vars: { insurance_type: "Auto policy" } })).toBe(
      "b_auto"
    );
    expect(chooseBranchArm(engineBranchStep(), { vars: { insurance_type: "home only" } })).toBe(
      "b_home"
    );
    // Matches BOTH arms — the first one checked wins.
    expect(chooseBranchArm(engineBranchStep(), { vars: { insurance_type: "home + auto" } })).toBe(
      "b_auto"
    );
  });

  it("falls through to else when nothing matches", () => {
    expect(chooseBranchArm(engineBranchStep(), { vars: { insurance_type: "life" } })).toBe(
      BRANCH_ELSE_ARM
    );
    expect(chooseBranchArm(engineBranchStep(), { vars: {} })).toBe(BRANCH_ELSE_ARM);
  });

  it("survives malformed arms (no condition / non-array branches)", () => {
    const broken = {
      ...engineBranchStep(),
      branches: [null, { id: "no_cond", label: "x" }]
    } as unknown as Extract<EngineFlowStep, { type: "branch" }>;
    expect(chooseBranchArm(broken, { vars: { insurance_type: "auto" } })).toBe(BRANCH_ELSE_ARM);
    const noArray = {
      ...engineBranchStep(),
      branches: "nope"
    } as unknown as Extract<EngineFlowStep, { type: "branch" }>;
    expect(chooseBranchArm(noArray, { vars: { insurance_type: "auto" } })).toBe(BRANCH_ELSE_ARM);
  });

  it("gates steps by every hop's recorded choice", () => {
    const path = [{ branchStepId: "s2", armId: "b_auto" }];
    expect(isOnActivePath(path, { [branchChoiceVar("s2")]: "b_auto" })).toBe(true);
    expect(isOnActivePath(path, { [branchChoiceVar("s2")]: "b_home" })).toBe(false);
    // Unevaluated branch (skipped or not yet run) → children are NOT active.
    expect(isOnActivePath(path, {})).toBe(false);
    expect(isOnActivePath([], {})).toBe(true);
  });
});

describe("planStep branch", () => {
  it("records the chosen arm id and label as engine vars", () => {
    const plan = planStep(engineBranchStep(), { vars: { insurance_type: "home" } });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).toEqual({
      kind: "set_vars",
      vars: { [branchChoiceVar("s2")]: "b_home", __branch_label_s2: "Home" }
    });
  });

  it("records the else sentinel when no arm matches", () => {
    const plan = planStep(engineBranchStep(), { vars: { insurance_type: "life" } });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).toEqual({
      kind: "set_vars",
      vars: { [branchChoiceVar("s2")]: "else", __branch_label_s2: "none matched" }
    });
  });

  it("falls back to the arm id when a (malformed) arm has no label", () => {
    const step = engineBranchStep();
    const noLabel = {
      ...step,
      branches: [{ id: "b1", condition: { var: "insurance_type", contains: "auto" }, steps: [] }]
    } as unknown as Extract<EngineFlowStep, { type: "branch" }>;
    const plan = planStep(noLabel, { vars: { insurance_type: "auto" } });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).toEqual({
      kind: "set_vars",
      vars: { [branchChoiceVar("s2")]: "b1", __branch_label_s2: "b1" }
    });
  });
});
