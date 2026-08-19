/**
 * Shared edit_aiflow core (src/lib/ai-flows/edit-flow-tool.ts).
 *
 * The tool is a TWO-call protocol now: stage (writes nothing, returns a diff
 * and a token), then apply (by token). Every contract the one-call version
 * pinned still holds, it just lands on one side of the handshake or the
 * other: compile against the CURRENT definition, rename only when asked,
 * enabled state untouched, compile refusals passed through verbatim with the
 * flow unchanged, and an honest "not changed" when the write fails.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { logger } from "@/lib/logger";
import {
  editAiFlowTool,
  editAiflowToolArgsSchema,
  type EditFlowToolDeps
} from "@/lib/ai-flows/edit-flow-tool";
import type { AiFlowRow } from "@/lib/ai-flows/db";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import type { PendingEditRow } from "@/lib/ai-flows/pending-edits";

const BIZ = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "tok-1";

const DEFINITION: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "original" }]
} as AiFlowDefinition;

/** Same step id, different wording: the "wording" risk class. */
const EDITED: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "updated" }]
} as AiFlowDefinition;

/**
 * The SAME single step, now aiming at a page we do not control: the
 * "behavioral" risk class. Same id and same position, so nothing renumbers.
 */
const BROWSE_BASE: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [
    {
      id: "s1",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [{ kind: "click_text", target: "Claim this lead" }]
    }
  ]
} as unknown as AiFlowDefinition;

const BROWSE_RETARGETED: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [
    {
      id: "s1",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [{ kind: "click_text", target: "Accept referral" }]
    }
  ]
} as unknown as AiFlowDefinition;

/** An extra step ahead of nothing in flight: the "structural" risk class. */
const RESTRUCTURED: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [
    { id: "s0", type: "notify_owner", message: "new first step" },
    { id: "s1", type: "notify_owner", message: "original" }
  ]
} as AiFlowDefinition;

function flowRow(overrides: Partial<AiFlowRow> = {}): AiFlowRow {
  return {
    id: FLOW_ID,
    business_id: BIZ,
    name: "Lead follow-up",
    enabled: true,
    definition: DEFINITION,
    created_by: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function pendingRow(overrides: Partial<PendingEditRow> = {}): PendingEditRow {
  return {
    id: "pending-1",
    business_id: BIZ,
    flow_id: FLOW_ID,
    token: TOKEN,
    definition: EDITED,
    new_name: null,
    summary: ['Step "s1": message changes from "original" to "updated".'],
    ambiguities: [],
    risk: "wording",
    base_updated_at: "2026-07-01T00:00:00Z",
    surface: null,
    actor: null,
    created_at: "2026-08-18T00:00:00Z",
    expires_at: "2026-08-18T00:15:00Z",
    consumed_at: null,
    ...overrides
  };
}

function happyDeps(overrides: Partial<EditFlowToolDeps> = {}): EditFlowToolDeps {
  return {
    listFlows: vi.fn(async () => [flowRow()]),
    compileEdit: vi.fn(async () => ({ ok: true as const, definition: EDITED, warnings: [] })),
    persistUpdate: vi.fn(async () => flowRow({ definition: EDITED })),
    highestLiveStep: vi.fn(async () => null),
    stageEdit: vi.fn(async () => pendingRow()),
    consumeEdit: vi.fn(async () => ({ ok: true as const, row: pendingRow() })),
    peekEdit: vi.fn(async () => pendingRow()),
    announce: vi.fn(async () => {}),
    ...overrides
  };
}

const ARGS = { flow: "Lead follow-up", instructions: "change the message to 'updated'" };
const CONFIRM = { ...ARGS, confirmationToken: TOKEN };

describe("editAiFlowTool: staging (first call)", () => {
  it("compiles against the CURRENT definition, stages, and writes NOTHING", async () => {
    const deps = happyDeps();
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({
      ok: true,
      staged: true,
      confirmationToken: TOKEN,
      flowId: FLOW_ID,
      risk: "wording"
    });
    expect(deps.compileEdit).toHaveBeenCalledWith({
      businessId: BIZ,
      flowName: "Lead follow-up",
      currentDefinition: DEFINITION,
      instructions: ARGS.instructions
    });
    // The whole point of the layer: the live flow is untouched until a yes.
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("hands the model a diff and an explicit do-not-claim-it-happened note", async () => {
    const res = await editAiFlowTool(BIZ, ARGS, happyDeps());
    expect(res.ok).toBe(true);
    if (res.ok && "confirmationToken" in res) {
      expect(res.summary[0]).toContain('"original"');
      expect(res.summary[0]).toContain('"updated"');
      expect(res.note).toContain("NOTHING HAS CHANGED YET");
      expect(res.note).toContain(TOKEN);
    }
  });

  it("stages the compiled bytes and the base version the diff was computed against", async () => {
    // Storing the definition (not re-compiling on confirm) is what makes the
    // confirmation mean anything: the compile step regenerates a whole
    // definition, so a second run can differ from the one described.
    const deps = happyDeps();
    await editAiFlowTool(BIZ, ARGS, deps);
    expect(deps.stageEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: FLOW_ID,
        definition: EDITED,
        risk: "wording",
        baseUpdatedAt: "2026-07-01T00:00:00Z"
      })
    );
  });

  it("a rename with no step change is still stageable wording", async () => {
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({ ok: true as const, definition: DEFINITION, warnings: [] })),
      stageEdit: vi.fn(async () => pendingRow({ new_name: "Renamed" }))
    });
    const res = await editAiFlowTool(BIZ, { ...ARGS, newName: "Renamed" }, deps);
    expect(res).toMatchObject({ ok: true, staged: true, risk: "wording" });
    expect(deps.stageEdit).toHaveBeenCalledWith(
      expect.objectContaining({ newName: "Renamed" })
    );
    if (res.ok && "confirmationToken" in res) {
      expect(res.summary.some((l) => l.includes('Renames the automation to "Renamed"'))).toBe(true);
    }
  });

  it("carries the surface's provenance onto the staged row", async () => {
    const deps = happyDeps({ editSource: "ai_edit_sms", editActor: "+15555550100" });
    await editAiFlowTool(BIZ, ARGS, deps);
    expect(deps.stageEdit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "ai_edit_sms", actor: "+15555550100" })
    );
  });

  it("open questions block staging entirely: no token, nothing to confirm", async () => {
    // The point of the layer: the model cannot reach the apply call at all
    // until the owner has answered, which inverts the default from "act
    // unless unsure" to "cannot act until resolved".
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: EDITED,
        warnings: [],
        questions: ["Which teammate should it text?", "How long should it wait?"]
      }))
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: true, staged: false });
    if (res.ok && "questions" in res) {
      expect(res.questions).toEqual([
        "Which teammate should it text?",
        "How long should it wait?"
      ]);
      expect(res.note).toContain("NOTHING HAS CHANGED");
      expect(res.note).toContain("Do not guess on their behalf");
      // No token anywhere in the response: there is nothing to confirm yet.
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    }
    expect(deps.stageEdit).not.toHaveBeenCalled();
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("an empty or absent questions list stages normally", async () => {
    const withEmpty = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: EDITED,
        warnings: [],
        questions: []
      }))
    });
    expect(await editAiFlowTool(BIZ, ARGS, withEmpty)).toMatchObject({ ok: true, staged: true });
    // Absent entirely (the create path's shape, and any older caller).
    expect(await editAiFlowTool(BIZ, ARGS, happyDeps())).toMatchObject({ ok: true, staged: true });
  });

  it("refuses an instruction that changes nothing instead of staging a no-op", async () => {
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({ ok: true as const, definition: DEFINITION, warnings: [] }))
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("no change");
    expect(deps.stageEdit).not.toHaveBeenCalled();
  });

  it("passes a compile refusal through verbatim and never stages", async () => {
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: false as const,
        error: "invalid" as const,
        message: "The requested change couldn't be applied safely, so the automation was NOT changed:\n• bad",
        issues: ["bad"]
      }))
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("NOT changed");
    expect(deps.stageEdit).not.toHaveBeenCalled();
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("a staging failure says nothing was changed, and does not persist", async () => {
    const deps = happyDeps({
      stageEdit: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("NOTHING was changed");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "edit_aiflow: staging failed",
      expect.objectContaining({ error: "db down" })
    );
    expect(deps.persistUpdate).not.toHaveBeenCalled();

    const deps2 = happyDeps({
      stageEdit: vi.fn(async () => {
        throw "string failure";
      })
    });
    expect(await editAiFlowTool(BIZ, ARGS, deps2)).toMatchObject({ ok: false });
  });

  it("resolves by id and by unique substring; misses and ambiguity refuse with steering", async () => {
    const two = [
      flowRow(),
      flowRow({ id: "33333333-3333-4333-8333-333333333333", name: "Lead intake" })
    ];
    const deps = happyDeps({ listFlows: vi.fn(async () => two) });

    expect((await editAiFlowTool(BIZ, { ...ARGS, flow: FLOW_ID }, deps)).ok).toBe(true);
    expect((await editAiFlowTool(BIZ, { ...ARGS, flow: "follow-up" }, deps)).ok).toBe(true);

    const miss = await editAiFlowTool(BIZ, { ...ARGS, flow: "nope" }, deps);
    expect(miss).toMatchObject({ ok: false });
    if (!miss.ok) expect(miss.message).toContain("No AiFlow matches");

    const ambiguous = await editAiFlowTool(BIZ, { ...ARGS, flow: "Lead" }, deps);
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) expect(ambiguous.message).toContain("matches 2 flows");
  });
});

describe("editAiFlowTool: blast radius", () => {
  it("classifies an added step as structural, and still stages it on a rich surface", async () => {
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: RESTRUCTURED,
        warnings: []
      }))
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: true, staged: true, risk: "structural" });
  });

  it("refuses a structural edit on a text surface and points at the dashboard", async () => {
    // By text the coworker can change what an automation SAYS; changing what
    // it DOES needs the owner looking at the flow.
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: RESTRUCTURED,
        warnings: []
      })),
      surfaceKind: "text"
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.message).toContain(`/dashboard/aiflows?edit=${FLOW_ID}`);
      // Nothing was staged, so the message must NOT imply a pending change
      // is sitting in the dashboard waiting to be approved.
      expect(res.message).toContain("nothing was saved anywhere");
      expect(res.message).not.toContain("ready to review");
    }
    expect(deps.stageEdit).not.toHaveBeenCalled();
  });

  it("still allows a WORDING change by text: the handshake applies, the refusal does not", async () => {
    const deps = happyDeps({ surfaceKind: "text" });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: true, staged: true, risk: "wording" });
  });

  it("refuses a retargeted browse click by text, even though nothing renumbers", async () => {
    // The gap this closes: a changed selector used to classify as "wording",
    // so one text message could repoint the claim button at a label that does
    // not exist, and the failure would surface days later on a live lead.
    const deps = happyDeps({
      listFlows: vi.fn(async () => [flowRow({ definition: BROWSE_BASE })]),
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: BROWSE_RETARGETED,
        warnings: []
      })),
      surfaceKind: "text"
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.message).toContain("what a step DOES on a web page");
      expect(res.message).toContain(`/dashboard/aiflows?edit=${FLOW_ID}`);
      expect(res.message).toContain("nothing was saved anywhere");
    }
    expect(deps.stageEdit).not.toHaveBeenCalled();
  });

  it("still STAGES that same browse edit on a rich surface, where the owner can see it", async () => {
    const deps = happyDeps({
      listFlows: vi.fn(async () => [flowRow({ definition: BROWSE_BASE })]),
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: BROWSE_RETARGETED,
        warnings: []
      }))
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: true, staged: true, risk: "behavioral" });
  });

  it("an edit that diverges at or before a parked run is in_flight, and says so", async () => {
    // current_step is a flat index: inserting s0 renumbers everything after
    // it, so a run parked at index 0 would resume on a different step.
    const deps = happyDeps({
      compileEdit: vi.fn(async () => ({
        ok: true as const,
        definition: RESTRUCTURED,
        warnings: []
      })),
      highestLiveStep: vi.fn(async () => 0),
      surfaceKind: "text"
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("runs already at step 0");
  });
});

describe("editAiFlowTool: applying (second call)", () => {
  it("applies the STAGED definition, not a recompile", async () => {
    const deps = happyDeps();
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({
      ok: true,
      flowId: FLOW_ID,
      flowName: "Lead follow-up",
      enabled: true,
      stepCount: 1,
      triggerChannel: "manual"
    });
    // No second compile: the bytes the owner agreed to are the bytes written.
    expect(deps.compileEdit).not.toHaveBeenCalled();
    // Enabled state untouched, no rename unless the staged row carries one.
    expect(deps.persistUpdate).toHaveBeenCalledWith({
      businessId: BIZ,
      id: FLOW_ID,
      definition: EDITED
    });
    if (res.ok && "applied" in res) {
      expect(res.note).toContain(`/dashboard/aiflows?edit=${FLOW_ID}`);
      expect(res.note).toContain("undo that");
      expect(res.note).not.toContain("still disabled");
    }
  });

  it("renames only when the staged row carries a name, and notes a disabled flow honestly", async () => {
    const deps = happyDeps({
      listFlows: vi.fn(async () => [flowRow({ enabled: false })]),
      consumeEdit: vi.fn(async () => ({
        ok: true as const,
        row: pendingRow({ new_name: "Renamed" })
      })),
      persistUpdate: vi.fn(async () =>
        flowRow({ enabled: false, name: "Renamed", definition: EDITED })
      )
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: true, flowName: "Renamed", enabled: false });
    if (res.ok && "applied" in res) expect(res.note).toContain("still disabled");
    expect(deps.persistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" })
    );
  });

  it("relays a consume refusal (unknown, replayed or expired token) verbatim", async () => {
    const deps = happyDeps({
      peekEdit: vi.fn(async () => null),
      consumeEdit: vi.fn(async () => ({
        ok: false as const,
        message: "That change was already applied once. It has NOT been applied a second time."
      }))
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("NOT been applied a second time");
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("a REPLAYED token is diagnosed as already-applied, not as a stale flow", async () => {
    // After a successful apply the flow's updated_at has moved, so the
    // freshness check would fire first and tell the model the flow changed
    // underneath, steering it into re-staging a change that already landed.
    const deps = happyDeps({
      peekEdit: vi.fn(async () =>
        pendingRow({ consumed_at: "2026-08-18T00:05:00Z", base_updated_at: "2026-07-01T00:00:00Z" })
      ),
      listFlows: vi.fn(async () => [flowRow({ updated_at: "2026-08-18T00:05:00Z" })]),
      consumeEdit: vi.fn(async () => ({
        ok: false as const,
        message: "That change was already applied once. It has NOT been applied a second time."
      }))
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.message).toContain("already applied once");
      expect(res.message).not.toContain("changed after that summary");
    }
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("refuses a token staged against a DIFFERENT automation", async () => {
    const deps = happyDeps({
      peekEdit: vi.fn(async () => pendingRow({ flow_id: "44444444-4444-4444-8444-444444444444" }))
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("different automation");
    expect(deps.persistUpdate).not.toHaveBeenCalled();
    // The refusal wrote nothing, so it must not spend the single-use token.
    expect(deps.consumeEdit).not.toHaveBeenCalled();
  });

  it("refuses when the flow moved between staging and confirming", async () => {
    // Otherwise the owner's yes applies to a diff that no longer describes
    // what is live, silently overwriting whatever happened in between.
    const deps = happyDeps({
      peekEdit: vi.fn(async () => pendingRow({ base_updated_at: "2026-07-01T00:00:00Z" })),
      listFlows: vi.fn(async () => [flowRow({ updated_at: "2026-07-02T00:00:00Z" })])
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("changed after that summary");
    expect(deps.persistUpdate).not.toHaveBeenCalled();
    expect(deps.consumeEdit).not.toHaveBeenCalled();
  });

  it("refuses a staged edit that still carries open questions", async () => {
    const deps = happyDeps({
      peekEdit: vi.fn(async () => pendingRow({ ambiguities: ["which teammate should it text?"] }))
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("which teammate should it text?");
    expect(deps.persistUpdate).not.toHaveBeenCalled();
    expect(deps.consumeEdit).not.toHaveBeenCalled();
  });

  it("a persist failure degrades to an honest 'not changed' (Error and non-Error throws)", async () => {
    const deps = happyDeps({
      persistUpdate: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const res = await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.message).toContain("NOT changed");
      // Honest about the spent token rather than inviting a retry that would
      // come back "already applied".
      expect(res.message).toContain("used up");
    }
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "edit_aiflow: persist failed",
      expect.objectContaining({ error: "db down" })
    );

    const deps2 = happyDeps({
      persistUpdate: vi.fn(async () => {
        throw "string failure";
      })
    });
    expect(await editAiFlowTool(BIZ, CONFIRM, deps2)).toMatchObject({ ok: false });
  });

  it("announces the applied change out of band, with the diff the owner approved", async () => {
    // A text thread scrolls. The owner should still know tomorrow.
    const deps = happyDeps({ editSource: "ai_edit_sms", editActor: "+15555550100" });
    await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(deps.announce).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        flowId: FLOW_ID,
        action: "edited",
        source: "ai_edit_sms",
        actor: "+15555550100",
        summary: pendingRow().summary
      })
    );
  });

  it("does not announce anything when the write failed", async () => {
    const deps = happyDeps({
      persistUpdate: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it("carries provenance onto the applied write", async () => {
    const deps = happyDeps({ editSource: "ai_edit_sms", editActor: "+15555550100" });
    await editAiFlowTool(BIZ, CONFIRM, deps);
    expect(deps.persistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ editSource: "ai_edit_sms", editActor: "+15555550100" })
    );
  });
});

describe("editAiflowToolArgsSchema", () => {
  it("requires flow + instructions, bounds newName and the token", () => {
    expect(editAiflowToolArgsSchema.safeParse(ARGS).success).toBe(true);
    expect(editAiflowToolArgsSchema.safeParse(CONFIRM).success).toBe(true);
    expect(editAiflowToolArgsSchema.safeParse({ flow: "f" }).success).toBe(false);
    expect(editAiflowToolArgsSchema.safeParse({ ...ARGS, newName: "" }).success).toBe(false);
    expect(
      editAiflowToolArgsSchema.safeParse({ ...ARGS, newName: "x".repeat(121) }).success
    ).toBe(false);
    expect(
      editAiflowToolArgsSchema.safeParse({ ...ARGS, confirmationToken: "x".repeat(81) }).success
    ).toBe(false);
  });
});
