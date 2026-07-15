import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  goalTimeline,
  goalViaText,
  runPosition,
  taskLeadPhone
} from "@/lib/ai-flows/tasks";
import type { FlowStep } from "@/lib/ai-flows/schema";

/**
 * Task Center pure helpers: lead identity from a run context, mapping the
 * run cursor back to a node label, and the goal-event timeline.
 */

describe("ACTIVE_RUN_STATUSES", () => {
  it("covers every non-terminal run status", () => {
    expect([...ACTIVE_RUN_STATUSES]).toEqual([
      "queued",
      "running",
      "awaiting_approval",
      "awaiting_agent",
      "awaiting_reply",
      "awaiting_call"
    ]);
  });
});

describe("taskLeadPhone", () => {
  it("prefers the extracted lead_phone var over the triggering sender", () => {
    expect(
      taskLeadPhone({
        vars: { lead_phone: "+16025550111" },
        trigger: { from: "+15550001111" }
      })
    ).toBe("+16025550111");
  });

  it("falls back to an E.164 trigger sender", () => {
    expect(taskLeadPhone({ trigger: { from: " +15550001111 " } })).toBe("+15550001111");
  });

  it("rejects non-phone values on both sources", () => {
    expect(taskLeadPhone({ vars: { lead_phone: "not-a-phone" }, trigger: { from: "meta" } })).toBe(
      null
    );
    expect(taskLeadPhone({ vars: { lead_phone: 42 }, trigger: { from: null } })).toBe(null);
    expect(taskLeadPhone({})).toBe(null);
    expect(taskLeadPhone({ vars: [], trigger: [] })).toBe(null);
  });
});

describe("runPosition", () => {
  const steps: FlowStep[] = [
    { id: "s1", type: "extract_text", fields: [{ name: "lead_phone" }] },
    { id: "g1", type: "goal", label: "Booked", events: [{ kind: "appointment_booked" }] },
    { id: "s3", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi" }
  ];

  it("maps the cursor to a friendly node label (1-based)", () => {
    expect(runPosition(steps, 0)).toEqual({
      stepNumber: 1,
      totalSteps: 3,
      nodeLabel: "Read details from the message text",
      stepType: "extract_text"
    });
    expect(runPosition(steps, 2).nodeLabel).toBe("Send a text");
  });

  it("labels goal nodes with the authored goal name", () => {
    expect(runPosition(steps, 1)).toEqual({
      stepNumber: 2,
      totalSteps: 3,
      nodeLabel: "Goal: Booked",
      stepType: "goal"
    });
  });

  it("reports Finished past the end, and tolerates junk cursors/step lists", () => {
    expect(runPosition(steps, 3)).toEqual({
      stepNumber: 0,
      totalSteps: 3,
      nodeLabel: "Finished",
      stepType: ""
    });
    expect(runPosition(steps, -1).nodeLabel).toBe("Finished");
    expect(runPosition([], 0).totalSteps).toBe(0);
    expect(runPosition("junk" as unknown as FlowStep[], 0).nodeLabel).toBe("Finished");
  });

  it("falls back to the raw type for a step the label map predates", () => {
    const future = [{ id: "x", type: "future_step" } as unknown as FlowStep];
    expect(runPosition(future, 0).nodeLabel).toBe("future_step");
  });

  it("counts flattened branch-arm steps (worker execution order)", () => {
    const withBranch: FlowStep[] = [
      { id: "s1", type: "extract_text", fields: [{ name: "t" }] },
      {
        id: "b1",
        type: "branch",
        question: "path?",
        branches: [
          {
            id: "a1",
            label: "A",
            condition: { var: "t", equals: "x" },
            steps: [{ id: "n1", type: "notify_owner", message: "hi" }]
          }
        ],
        else: []
      }
    ];
    // Flat order: s1, b1, n1 → the arm step is index 2.
    expect(runPosition(withBranch, 2)).toMatchObject({
      stepNumber: 3,
      totalSteps: 3,
      stepType: "notify_owner"
    });
  });
});

describe("goalTimeline", () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    run_id: "r1",
    step_type: "goal",
    status: "done",
    result: { goal: "Booked", reached_via: "appointment_booked" },
    updated_at: "2026-07-10T12:00:00Z",
    ...over
  });

  it("keeps completed goal rows, newest first", () => {
    const entries = goalTimeline([
      row({ updated_at: "2026-07-09T12:00:00Z", result: { goal: "Replied", reached_via: "replied" } }),
      row()
    ] as never);
    expect(entries).toEqual([
      { runId: "r1", label: "Booked", via: "appointment_booked", at: "2026-07-10T12:00:00Z" },
      { runId: "r1", label: "Replied", via: "replied", at: "2026-07-09T12:00:00Z" }
    ]);
  });

  it("drops non-goal rows and skipped goals (a jump past a non-matching goal)", () => {
    const entries = goalTimeline([
      row({ step_type: "send_sms" }),
      row({ status: "skipped" })
    ] as never);
    expect(entries).toEqual([]);
  });

  it("defaults label and via when the recorded result is sparse", () => {
    const entries = goalTimeline([row({ result: null })] as never);
    expect(entries[0]).toMatchObject({ label: "Goal", via: "passed_inline" });
    // Empty-string fields fall back the same way as missing ones.
    const blank = goalTimeline([row({ result: { goal: "", reached_via: "" } })] as never);
    expect(blank[0]).toMatchObject({ label: "Goal", via: "passed_inline" });
  });

  it("keeps already-newest-first input stable (comparator both ways)", () => {
    const entries = goalTimeline([
      row({ updated_at: "2026-07-10T12:00:00Z" }),
      row({ updated_at: "2026-07-09T12:00:00Z" })
    ] as never);
    expect(entries.map((e) => e.at)).toEqual([
      "2026-07-10T12:00:00Z",
      "2026-07-09T12:00:00Z"
    ]);
  });
});

describe("goalViaText", () => {
  it("words every event kind (unknowns pass through)", () => {
    expect(goalViaText("replied")).toBe("they texted back");
    expect(goalViaText("appointment_booked")).toBe("an appointment was booked");
    expect(goalViaText("claimed")).toBe("a teammate claimed the lead");
    expect(goalViaText("tag_added")).toBe("a tag was added");
    expect(goalViaText("passed_inline")).toBe("reached in sequence");
    expect(goalViaText("mystery")).toBe("mystery");
  });
});
