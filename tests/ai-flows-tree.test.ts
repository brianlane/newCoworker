import { describe, expect, it } from "vitest";
import type { FlowStep } from "@/lib/ai-flows/schema";
import {
  findStepById,
  flattenForDisplay,
  hasBranchStep,
  insertStepAt,
  isBranchStep,
  moveStepById,
  patchStepById,
  removeStepById,
  statsByStepIdFromRunSteps,
  varsInScopeBefore,
  varsProducedByStep
} from "@/lib/ai-flows/tree";

/** extract → branch(Auto→sms | Home→sms, else notify) → notify. */
function tree(): FlowStep[] {
  return [
    { id: "s1", type: "extract_text", fields: [{ name: "kind" }, { name: "lead_phone" }] },
    {
      id: "br",
      type: "branch",
      question: "Which kind?",
      branches: [
        {
          id: "a_auto",
          label: "Auto",
          condition: { var: "kind", contains: "auto" },
          steps: [{ id: "auto_sms", type: "send_sms", to: "{{vars.lead_phone}}", body: "auto" }]
        },
        {
          id: "a_home",
          label: "Home",
          condition: { var: "kind", contains: "home" },
          steps: [{ id: "home_sms", type: "send_sms", to: "{{vars.lead_phone}}", body: "home" }]
        }
      ],
      else: [{ id: "else_note", type: "notify_owner", message: "other" }]
    },
    { id: "s3", type: "notify_owner", message: "done" }
  ];
}

describe("flattenForDisplay", () => {
  it("matches the worker's execution order with containers and depth", () => {
    const flat = flattenForDisplay(tree());
    expect(flat.map((e) => e.step.id)).toEqual([
      "s1",
      "br",
      "auto_sms",
      "home_sms",
      "else_note",
      "s3"
    ]);
    expect(flat[0].container).toEqual({ kind: "trunk" });
    expect(flat[0].depth).toBe(0);
    expect(flat[2].container).toEqual({ kind: "arm", branchId: "br", armId: "a_auto" });
    expect(flat[2].depth).toBe(1);
    expect(flat[4].container).toEqual({ kind: "else", branchId: "br" });
    expect(flat[5].container).toEqual({ kind: "trunk" });
    expect(flat[5].indexInContainer).toBe(2);
  });
});

describe("findStepById", () => {
  it("finds trunk, arm, and else steps; misses return null", () => {
    const steps = tree();
    expect(findStepById(steps, "s3")?.id).toBe("s3");
    expect(findStepById(steps, "home_sms")?.id).toBe("home_sms");
    expect(findStepById(steps, "else_note")?.id).toBe("else_note");
    expect(findStepById(steps, "nope")).toBeNull();
  });
});

describe("patchStepById", () => {
  it("patches a nested arm step immutably, sharing untouched subtrees", () => {
    const steps = tree();
    const next = patchStepById(steps, "home_sms", { body: "HOME!" });
    expect(next).not.toBe(steps);
    const patched = findStepById(next, "home_sms");
    expect(patched && "body" in patched && patched.body).toBe("HOME!");
    // The original tree is untouched; unaffected trunk nodes are shared.
    const original = findStepById(steps, "home_sms");
    expect(original && "body" in original && original.body).toBe("home");
    expect(next[0]).toBe(steps[0]);
  });

  it("patches an else step and a trunk step", () => {
    const next = patchStepById(tree(), "else_note", { message: "changed" });
    const note = findStepById(next, "else_note");
    expect(note && "message" in note && note.message).toBe("changed");
    const next2 = patchStepById(tree(), "s3", { message: "trunk" });
    const s3 = findStepById(next2, "s3");
    expect(s3 && "message" in s3 && s3.message).toBe("trunk");
  });

  it("returns the same array when the id is missing", () => {
    const steps = tree();
    expect(patchStepById(steps, "missing", { x: 1 })).toBe(steps);
  });
});

describe("removeStepById", () => {
  it("removes a nested step and a whole branch subtree", () => {
    const withoutArmStep = removeStepById(tree(), "auto_sms");
    expect(findStepById(withoutArmStep, "auto_sms")).toBeNull();
    expect(findStepById(withoutArmStep, "home_sms")).not.toBeNull();

    const withoutBranch = removeStepById(tree(), "br");
    expect(flattenForDisplay(withoutBranch).map((e) => e.step.id)).toEqual(["s1", "s3"]);
  });
});

describe("insertStepAt", () => {
  const newNote: FlowStep = { id: "new_note", type: "notify_owner", message: "new" };

  it("inserts into the trunk at an index (clamped)", () => {
    const next = insertStepAt(tree(), { kind: "trunk" }, 1, newNote);
    expect(next.map((s) => s.id)).toEqual(["s1", "new_note", "br", "s3"]);
    const clamped = insertStepAt(tree(), { kind: "trunk" }, 99, newNote);
    expect(clamped[clamped.length - 1].id).toBe("new_note");
  });

  it("inserts into a branch arm and an else path", () => {
    const inArm = insertStepAt(
      tree(),
      { kind: "arm", branchId: "br", armId: "a_auto" },
      0,
      newNote
    );
    expect(flattenForDisplay(inArm).map((e) => e.step.id)).toEqual([
      "s1",
      "br",
      "new_note",
      "auto_sms",
      "home_sms",
      "else_note",
      "s3"
    ]);
    const inElse = insertStepAt(tree(), { kind: "else", branchId: "br" }, 1, newNote);
    const flat = flattenForDisplay(inElse).map((e) => e.step.id);
    expect(flat.indexOf("new_note")).toBe(flat.indexOf("else_note") + 1);
  });

  it("no-ops when the container no longer exists", () => {
    const steps = tree();
    expect(insertStepAt(steps, { kind: "arm", branchId: "gone", armId: "x" }, 0, newNote)).toBe(
      steps
    );
    expect(insertStepAt(steps, { kind: "arm", branchId: "br", armId: "gone" }, 0, newNote)).toBe(
      steps
    );
    // A container pointing at a NON-branch step can't resolve either.
    expect(insertStepAt(steps, { kind: "else", branchId: "s1" }, 0, newNote)).toBe(steps);
  });
});

describe("moveStepById", () => {
  it("swaps within the container and stops at the edges", () => {
    const moved = moveStepById(tree(), "s3", -1);
    expect(moved.map((s) => s.id)).toEqual(["s1", "s3", "br"]);
    const atEdge = moveStepById(tree(), "s1", -1);
    expect(atEdge.map((s) => s.id)).toEqual(["s1", "br", "s3"]);
  });

  it("moves a nested step only within its own arm", () => {
    // auto_sms is alone in its arm — moving it down must not leak into the
    // next arm's list.
    const steps = tree();
    expect(moveStepById(steps, "auto_sms", 1)).toBe(steps);
  });

  it("no-ops for an unknown id", () => {
    const steps = tree();
    expect(moveStepById(steps, "missing", 1)).toBe(steps);
  });
});

describe("varsProducedByStep", () => {
  it("covers every producing step type", () => {
    expect(varsProducedByStep({ id: "x", type: "extract_url", saveAs: "u" })).toEqual(["u"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "browse_extract",
        urlVar: "u",
        fields: [{ name: "f1" }],
        extractLinks: [{ name: "l1", matchText: "t" }]
      })
    ).toEqual(["f1", "l1"]);
    expect(
      varsProducedByStep({ id: "x", type: "extract_text", fields: [{ name: "a" }] })
    ).toEqual(["a"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "email_extract",
        connectionId: "11111111-1111-1111-1111-111111111111",
        fields: [{ name: "b" }]
      })
    ).toEqual(["b"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "browse_action",
        urlVar: "u",
        actions: [{ kind: "click_text", target: "Go" }],
        fields: [{ name: "c" }]
      })
    ).toEqual(["c"]);
    expect(
      varsProducedByStep({ id: "x", type: "http_call", label: "api", saveAs: "resp" })
    ).toEqual(["resp"]);
    expect(varsProducedByStep({ id: "x", type: "http_call", label: "api" })).toEqual([]);
    expect(varsProducedByStep({ id: "x", type: "recall_url", saveAs: "r", keyVars: ["p"] })).toEqual(
      ["r"]
    );
    expect(varsProducedByStep({ id: "x", type: "wait_for_reply", phoneVar: "p" })).toEqual([
      "reply_text"
    ]);
    expect(
      varsProducedByStep({ id: "x", type: "wait_for_reply", phoneVar: "p", saveAs: "ans" })
    ).toEqual(["ans"]);
    expect(varsProducedByStep({ id: "x", type: "notify_owner", message: "m" })).toEqual([]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "classify",
        categories: [{ value: "a" }, { value: "b" }],
        saveAs: "intent"
      })
    ).toEqual(["intent"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "generate_image",
        promptTemplate: "a banner",
        saveAs: "img_url"
      })
    ).toEqual(["img_url"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "share_document",
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        to: "{{trigger.from}}",
        saveAs: "doc_url"
      })
    ).toEqual(["doc_url"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "share_document",
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        to: "{{trigger.from}}"
      })
    ).toEqual([]);
    // Optional field lists absent → nothing produced.
    expect(
      varsProducedByStep({
        id: "x",
        type: "browse_extract",
        urlVar: "u",
        extractLinks: [{ name: "only_link", matchText: "t" }]
      })
    ).toEqual(["only_link"]);
    expect(
      varsProducedByStep({ id: "x", type: "browse_extract", urlVar: "u", fields: [{ name: "f" }] })
    ).toEqual(["f"]);
    expect(
      varsProducedByStep({
        id: "x",
        type: "browse_action",
        urlVar: "u",
        actions: [{ kind: "click_text", target: "Go" }]
      })
    ).toEqual([]);
  });
});

describe("varsInScopeBefore", () => {
  it("collects deduped vars in flat order up to the target step", () => {
    const steps = tree();
    expect(varsInScopeBefore(steps, "br")).toEqual(["kind", "lead_phone"]);
    // Arm steps see the extraction vars too (produced before the branch).
    expect(varsInScopeBefore(steps, "home_sms")).toEqual(["kind", "lead_phone"]);
    expect(varsInScopeBefore(steps, "s1")).toEqual([]);
    // Duplicate producers dedupe.
    const dup: FlowStep[] = [
      { id: "a", type: "extract_text", fields: [{ name: "kind" }] },
      { id: "b", type: "extract_text", fields: [{ name: "kind" }] },
      { id: "c", type: "notify_owner", message: "m" }
    ];
    expect(varsInScopeBefore(dup, "c")).toEqual(["kind"]);
  });
});

describe("hasBranchStep + isBranchStep", () => {
  it("detects branches anywhere in the tree", () => {
    expect(hasBranchStep(tree())).toBe(true);
    expect(hasBranchStep([{ id: "n", type: "notify_owner", message: "m" }])).toBe(false);
    const branch = tree()[1];
    expect(isBranchStep(branch)).toBe(true);
    expect(isBranchStep(tree()[0])).toBe(false);
  });
});

describe("statsByStepIdFromRunSteps", () => {
  it("maps flat step_index rows onto tree node ids", () => {
    // Flat order: s1=0, br=1, auto_sms=2, home_sms=3, else_note=4, s3=5.
    const stats = statsByStepIdFromRunSteps(tree(), [
      { step_index: 0, step_type: "extract_text", status: "done" },
      { step_index: 1, step_type: "branch", status: "done" },
      { step_index: 2, step_type: "send_sms", status: "done" },
      { step_index: 3, step_type: "send_sms", status: "skipped" },
      { step_index: 4, step_type: "notify_owner", status: "skipped" },
      { step_index: 5, step_type: "notify_owner", status: "failed" },
      { step_index: 5, step_type: "notify_owner", status: "done" },
      { step_index: 0, step_type: "extract_text", status: "running" }, // non-terminal → ignored
      { step_index: 99, step_type: "notify_owner", status: "done" }, // beyond the definition → ignored
      // Recorded before a step-type-changing edit → stale, ignored.
      { step_index: 2, step_type: "send_email", status: "done" }
    ]);
    expect(stats.s1).toEqual({ done: 1, skipped: 0, failed: 0 });
    expect(stats.auto_sms).toEqual({ done: 1, skipped: 0, failed: 0 });
    expect(stats.home_sms).toEqual({ done: 0, skipped: 1, failed: 0 });
    expect(stats.s3).toEqual({ done: 1, skipped: 0, failed: 1 });
    expect(stats["99"]).toBeUndefined();
  });
});
