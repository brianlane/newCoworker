import { describe, expect, it } from "vitest";
import { classifyEditRisk, diffFlowDefinitions } from "@/lib/ai-flows/edit-diff";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

function def(steps: unknown[], trigger: unknown = { channel: "manual" }): AiFlowDefinition {
  return { version: 1, trigger, steps } as unknown as AiFlowDefinition;
}

const BASE = def([
  { id: "s1", type: "notify_owner", message: "original" },
  { id: "s2", type: "send_sms", body: "hi" }
]);

describe("diffFlowDefinitions", () => {
  it("reports a field change with both the old and the new wording", () => {
    const after = def([
      { id: "s1", type: "notify_owner", message: "updated" },
      { id: "s2", type: "send_sms", body: "hi" }
    ]);
    const diff = diffFlowDefinitions(BASE, after);
    expect(diff.stepsChanged).toEqual(["s1"]);
    expect(diff.stepsAdded).toEqual([]);
    expect(diff.stepsRemoved).toEqual([]);
    // Both sides, because "changed the message" is not a confirmable summary.
    expect(diff.summary[0]).toContain('"original"');
    expect(diff.summary[0]).toContain('"updated"');
    // Same ids in the same order, so no parked run can move.
    expect(diff.firstDivergenceIndex).toBeNull();
  });

  it("finds the first index where the two execution orders disagree", () => {
    const after = def([
      { id: "s0", type: "notify_owner", message: "new" },
      { id: "s1", type: "notify_owner", message: "original" },
      { id: "s2", type: "send_sms", body: "hi" }
    ]);
    const diff = diffFlowDefinitions(BASE, after);
    expect(diff.stepsAdded).toEqual(["s0"]);
    expect(diff.firstDivergenceIndex).toBe(0);
  });

  it("appending at the END diverges only past the existing steps", () => {
    const after = def([...(BASE.steps as unknown[]), { id: "s3", type: "sleep", minutes: 5 }]);
    const diff = diffFlowDefinitions(BASE, after);
    expect(diff.stepsAdded).toEqual(["s3"]);
    // The old list is a prefix of the new one, so nothing parked below index
    // 2 can move. This is why appending an arm was safe on Amy's flows.
    expect(diff.firstDivergenceIndex).toBe(2);
  });

  it("reports removals", () => {
    const diff = diffFlowDefinitions(BASE, def([{ id: "s1", type: "notify_owner", message: "original" }]));
    expect(diff.stepsRemoved).toEqual(["s2"]);
    expect(diff.summary.some((line) => line.includes("Removes 1 step"))).toBe(true);
  });

  it("walks nested branch arms, so a change inside an arm is found", () => {
    const nested = def([
      {
        id: "b1",
        type: "branch",
        question: "q",
        branches: [{ id: "arm", label: "l", condition: {}, steps: [{ id: "in", type: "notify_owner", message: "a" }] }],
        else: []
      }
    ]);
    const nestedAfter = def([
      {
        id: "b1",
        type: "branch",
        question: "q",
        branches: [{ id: "arm", label: "l", condition: {}, steps: [{ id: "in", type: "notify_owner", message: "b" }] }],
        else: []
      }
    ]);
    const diff = diffFlowDefinitions(nested, nestedAfter);
    expect(diff.stepsChanged).toEqual(["in"]);
    // The parent branch is NOT reported as changed: its nested children are
    // their own flattened entries, so counting them twice would mark every
    // branch above an edit as modified.
    expect(diff.stepsChanged).not.toContain("b1");
  });

  it("pluralizes added and removed counts", () => {
    const after = def([
      { id: "n1", type: "sleep", minutes: 1 },
      { id: "n2", type: "sleep", minutes: 2 }
    ]);
    const lines = diffFlowDefinitions(BASE, after).summary.join("\n");
    expect(lines).toContain("Removes 2 steps: s1, s2.");
    expect(lines).toContain("Adds 2 steps: n1, n2.");
  });

  it("a duplicate step id resolves to the FIRST occurrence, like the engine", () => {
    const dup = def([
      { id: "s1", type: "notify_owner", message: "first" },
      { id: "s1", type: "notify_owner", message: "second" }
    ]);
    const dupAfter = def([
      { id: "s1", type: "notify_owner", message: "changed" },
      { id: "s1", type: "notify_owner", message: "second" }
    ]);
    const diff = diffFlowDefinitions(dup, dupAfter);
    expect(diff.stepsChanged).toEqual(["s1"]);
    expect(diff.summary[0]).toContain('"first"');
  });

  it("flags a trigger change on its own", () => {
    const diff = diffFlowDefinitions(BASE, def(BASE.steps as unknown[], { channel: "sms" }));
    expect(diff.triggerChanged).toBe(true);
    expect(diff.summary.some((l) => l.includes("what STARTS"))).toBe(true);
  });

  it("reports a rename only when the new name actually differs", () => {
    expect(
      diffFlowDefinitions(BASE, BASE, { currentName: "A", newName: "B" }).renamedTo
    ).toBe("B");
    expect(
      diffFlowDefinitions(BASE, BASE, { currentName: "A", newName: "A" }).renamedTo
    ).toBeNull();
    expect(diffFlowDefinitions(BASE, BASE, { currentName: "A" }).renamedTo).toBeNull();
  });

  it("says so plainly when nothing at all would change", () => {
    expect(diffFlowDefinitions(BASE, BASE).summary).toEqual(["Nothing would change."]);
  });

  it("describes values without dumping a whole definition into a text message", () => {
    const long = "x".repeat(400);
    const after = def([
      { id: "s1", type: "notify_owner", message: long },
      { id: "s2", type: "send_sms", body: "hi" }
    ]);
    const line = diffFlowDefinitions(BASE, after).summary[0];
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(300);
  });

  it("describes an added field, an emptied one, and a non-string value", () => {
    const after = def([
      { id: "s1", type: "notify_owner", message: "   ", when: { var: "x", equals: "y" } },
      { id: "s2", type: "send_sms", body: "hi" }
    ]);
    const lines = diffFlowDefinitions(BASE, after).summary.join("\n");
    expect(lines).toContain("(empty)");
    expect(lines).toContain("(nothing)");
    expect(lines).toContain('{"var":"x","equals":"y"}');
  });

  it("truncates a long non-string value too", () => {
    const after = def([
      { id: "s1", type: "notify_owner", message: "original", tags: Array.from({ length: 60 }, (_, i) => `tag-${i}`) },
      { id: "s2", type: "send_sms", body: "hi" }
    ]);
    const lines = diffFlowDefinitions(BASE, after).summary.join("\n");
    expect(lines).toContain("...");
  });
});

describe("classifyEditRisk", () => {
  const wording = diffFlowDefinitions(
    BASE,
    def([
      { id: "s1", type: "notify_owner", message: "updated" },
      { id: "s2", type: "send_sms", body: "hi" }
    ])
  );
  const inserted = diffFlowDefinitions(
    BASE,
    def([
      { id: "s0", type: "notify_owner", message: "new" },
      { id: "s1", type: "notify_owner", message: "original" },
      { id: "s2", type: "send_sms", body: "hi" }
    ])
  );

  it("no change is 'none'", () => {
    expect(classifyEditRisk(diffFlowDefinitions(BASE, BASE), null)).toBe("none");
  });

  it("same steps, different wording is 'wording'", () => {
    expect(classifyEditRisk(wording, null)).toBe("wording");
    // Still only wording even with runs in flight: the ids and their order
    // are identical, so every parked index still points at the same step.
    expect(classifyEditRisk(wording, 5)).toBe("wording");
  });

  it("a rename alone is 'wording'", () => {
    const renamed = diffFlowDefinitions(BASE, BASE, { currentName: "A", newName: "B" });
    expect(classifyEditRisk(renamed, null)).toBe("wording");
  });

  it("an inserted step with nothing in flight is 'structural'", () => {
    expect(classifyEditRisk(inserted, null)).toBe("structural");
  });

  it("an insert AHEAD of a parked run is 'in_flight'", () => {
    expect(classifyEditRisk(inserted, 0)).toBe("in_flight");
    expect(classifyEditRisk(inserted, 3)).toBe("in_flight");
  });

  it("an append PAST every parked run stays 'structural'", () => {
    // The divergence is at index 2 and the furthest run is at 1, so no live
    // run's index changes meaning.
    const appended = diffFlowDefinitions(
      BASE,
      def([...(BASE.steps as unknown[]), { id: "s3", type: "sleep", minutes: 5 }])
    );
    expect(appended.firstDivergenceIndex).toBe(2);
    expect(classifyEditRisk(appended, 1)).toBe("structural");
  });

  it("a trigger-only change is structural even with identical steps", () => {
    const trig = diffFlowDefinitions(BASE, def(BASE.steps as unknown[], { channel: "sms" }));
    expect(classifyEditRisk(trig, null)).toBe("structural");
  });
});

describe("changes that are not wording", () => {
  const BROWSE = def([
    {
      id: "claim_click",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [{ kind: "click_text", target: "Claim this lead" }]
    },
    { id: "tell_team", type: "notify_owner", message: "claimed" }
  ]);

  it("treats a changed click target as behavioral, not wording", () => {
    // The step list is untouched, so no parked run moves, but what the
    // automation DOES on someone else's website changed. Judged from the
    // sentence alone ("point it at the new button label") this reads like a
    // trivial fix right up until it silently stops claiming leads.
    const after = def([
      {
        id: "claim_click",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Accept referral" }]
      },
      { id: "tell_team", type: "notify_owner", message: "claimed" }
    ]);
    const diff = diffFlowDefinitions(BROWSE, after);
    expect(diff.stepsChanged).toEqual(["claim_click"]);
    expect(diff.stepsChangedBeyondWording).toEqual(["claim_click"]);
    expect(diff.firstDivergenceIndex).toBeNull();
    expect(classifyEditRisk(diff, null)).toBe("behavioral");
  });

  it("counts a changed proof marker on a browse step too", () => {
    const after = def([
      {
        id: "claim_click",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Claim this lead" }],
        expectText: "We're calling you at"
      },
      { id: "tell_team", type: "notify_owner", message: "claimed" }
    ]);
    expect(classifyEditRisk(diffFlowDefinitions(BROWSE, after), null)).toBe("behavioral");
  });

  it("counts a browse_extract change as well", () => {
    const before = def([
      { id: "read", type: "browse_extract", urlVar: "lead_url", fields: [{ name: "price" }] }
    ]);
    const after = def([
      { id: "read", type: "browse_extract", urlVar: "other_url", fields: [{ name: "price" }] }
    ]);
    expect(classifyEditRisk(diffFlowDefinitions(before, after), null)).toBe("behavioral");
  });

  it("counts a step whose type changed INTO a browse step", () => {
    // Same id, different instruction. Reading the type off both sides means a
    // step turning into a page action cannot slip through as wording.
    const before = def([{ id: "x", type: "notify_owner", message: "hi" }]);
    const after = def([
      { id: "x", type: "browse_action", urlVar: "u", actions: [{ kind: "click_text", target: "Go" }] }
    ]);
    expect(classifyEditRisk(diffFlowDefinitions(before, after), null)).toBe("behavioral");
  });

  it("treats a changed `when` guard as behavioral on ANY step type", () => {
    // Every message is untouched; what changed is whether the step runs.
    const before = def([{ id: "s1", type: "send_sms", body: "hi" }]);
    const after = def([
      { id: "s1", type: "send_sms", body: "hi", when: { var: "stage", equals: "new" } }
    ]);
    const diff = diffFlowDefinitions(before, after);
    expect(diff.stepsChangedBeyondWording).toEqual(["s1"]);
    expect(classifyEditRisk(diff, null)).toBe("behavioral");
  });

  it("still calls a reworded message wording", () => {
    // The class must stay narrow: rewording a text is exactly what the text
    // surfaces exist to allow.
    const before = def([{ id: "s1", type: "send_sms", body: "hi" }]);
    const after = def([{ id: "s1", type: "send_sms", body: "hello there" }]);
    const diff = diffFlowDefinitions(before, after);
    expect(diff.stepsChangedBeyondWording).toEqual([]);
    expect(classifyEditRisk(diff, null)).toBe("wording");
  });

  it("ranks a structural change above a behavioral one", () => {
    // Adding a step renumbers the flat index, which is the more dangerous
    // fact even when a browse step also changed.
    const after = def([
      { id: "s0", type: "sleep", minutes: 5 },
      {
        id: "claim_click",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Accept referral" }]
      },
      { id: "tell_team", type: "notify_owner", message: "claimed" }
    ]);
    expect(classifyEditRisk(diffFlowDefinitions(BROWSE, after), null)).toBe("structural");
  });

  it("a behavioral change with runs in flight stays behavioral, not in_flight", () => {
    // in_flight is about a parked run RESUMING on the wrong instruction, which
    // needs the flat index to move. A field change leaves the order intact.
    const after = def([
      {
        id: "claim_click",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Accept referral" }]
      },
      { id: "tell_team", type: "notify_owner", message: "claimed" }
    ]);
    expect(classifyEditRisk(diffFlowDefinitions(BROWSE, after), 1)).toBe("behavioral");
  });
});
