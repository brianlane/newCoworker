/**
 * Tests for Slack approval-gate answering (src/lib/slack/approvals.ts).
 *
 * Pinned: options validate against what is STORED on the run (a stale card
 * cannot smuggle an option the run was not offered), races with other
 * surfaces resolve to polite no-ops, the modify rewind writes exactly what
 * the SMS webhook writes (status/current_step/note/resume marker), and the
 * ack lines match the SMS wording.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/ai-flows/db", () => ({
  decideAiFlowApproval: vi.fn(),
  getAiFlowRun: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  answerApprovalFromText,
  applySlackApprovalDecision,
  applySlackApprovalModify,
  findAwaitingApprovalRunBySlackThread,
  slackApprovalAck,
  slackApprovalButtons,
  slackApprovalOptionForText
} from "@/lib/slack/approvals";
import { decideAiFlowApproval, getAiFlowRun } from "@/lib/ai-flows/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const AWAITING = {
  id: RUN,
  status: "awaiting_approval",
  context: {
    vars: { existing: "kept" },
    approval: {
      options: ["approve", "skip", "cancel"],
      redraft_step_index: 2,
      redraft_step_id: "draft-step"
    }
  }
};

function updateChain(result: { data: unknown; error: { message: string } | null }) {
  const c: Record<string, unknown> = {};
  for (const m of ["update", "eq", "select", "order", "limit"]) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => result);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return c as never;
}

function makeDb(...chains: unknown[]) {
  const from = vi.fn();
  for (const c of chains) from.mockReturnValueOnce(c);
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAiFlowRun).mockResolvedValue(AWAITING as never);
  vi.mocked(decideAiFlowApproval).mockResolvedValue(AWAITING as never);
});

describe("slackApprovalButtons", () => {
  it("renders one button per stored option with approve/cancel styling and the modify hint", () => {
    const blocks = slackApprovalButtons({
      runId: RUN,
      options: ["approve", "skip", "cancel"],
      allowModify: true
    }) as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
    expect(blocks[0].type).toBe("actions");
    const [approve, , cancel] = blocks[0].elements!;
    expect(approve).toMatchObject({ action_id: "aiflow_approval:approve", style: "primary" });
    expect(cancel).toMatchObject({ action_id: "aiflow_approval:cancel", style: "danger" });
    expect(JSON.parse(approve.value as string)).toEqual({ r: RUN, o: "approve" });
    expect(JSON.stringify(blocks[1])).toContain("mention @New Coworker");

    expect(
      slackApprovalButtons({ runId: RUN, options: ["approve", "cancel"], allowModify: false })
    ).toHaveLength(1);
  });
});

describe("applySlackApprovalDecision", () => {
  it("applies a stored option through decideAiFlowApproval", async () => {
    const out = await applySlackApprovalDecision(
      { businessId: BIZ, runId: RUN, option: "skip", decidedBy: "slack:U1" },
      makeDb()
    );
    expect(out).toEqual({ applied: true, kind: "decision", option: "skip" });
    expect(vi.mocked(decideAiFlowApproval)).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "skip", decidedBy: "slack:U1" }),
      expect.anything()
    );
  });

  it("maps cancel to the legacy deny decision", async () => {
    await applySlackApprovalDecision(
      { businessId: BIZ, runId: RUN, option: "cancel", decidedBy: "slack:U1" },
      makeDb()
    );
    expect(vi.mocked(decideAiFlowApproval)).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
      expect.anything()
    );
  });

  it("refuses options the run was never offered", async () => {
    const out = await applySlackApprovalDecision(
      { businessId: BIZ, runId: RUN, option: "bypass_quiet_hours", decidedBy: "slack:U1" },
      makeDb()
    );
    expect(out).toEqual({ applied: false, reason: "unknown_option" });
    expect(vi.mocked(decideAiFlowApproval)).not.toHaveBeenCalled();
  });

  it("treats a decided/missing run and a decide race as polite no-ops, rethrows the rest", async () => {
    vi.mocked(getAiFlowRun).mockResolvedValue(null as never);
    expect(
      await applySlackApprovalDecision(
        { businessId: BIZ, runId: RUN, option: "approve", decidedBy: "d" },
        makeDb()
      )
    ).toEqual({ applied: false, reason: "already_handled" });

    vi.mocked(getAiFlowRun).mockResolvedValue({ ...AWAITING, status: "queued" } as never);
    expect(
      (
        await applySlackApprovalDecision(
          { businessId: BIZ, runId: RUN, option: "approve", decidedBy: "d" },
          makeDb()
        )
      ).applied
    ).toBe(false);

    vi.mocked(getAiFlowRun).mockResolvedValue(AWAITING as never);
    vi.mocked(decideAiFlowApproval).mockRejectedValue(
      new Error("decideAiFlowApproval: run is not awaiting approval")
    );
    expect(
      await applySlackApprovalDecision(
        { businessId: BIZ, runId: RUN, option: "approve", decidedBy: "d" },
        makeDb()
      )
    ).toEqual({ applied: false, reason: "already_handled" });

    vi.mocked(decideAiFlowApproval).mockRejectedValue(new Error("db down"));
    await expect(
      applySlackApprovalDecision(
        { businessId: BIZ, runId: RUN, option: "approve", decidedBy: "d" },
        makeDb()
      )
    ).rejects.toThrow(/db down/);
  });

  it("falls back to the default service client", async () => {
    defaultClientSpy.mockReturnValueOnce(makeDb());
    expect(
      (
        await applySlackApprovalDecision({
          businessId: BIZ,
          runId: RUN,
          option: "approve",
          decidedBy: "d"
        })
      ).applied
    ).toBe(true);
  });
});

describe("applySlackApprovalModify", () => {
  it("rewinds to the redraft step with the note and the re-pointed resume marker", async () => {
    const c = updateChain({ data: [{ id: RUN }], error: null });
    const out = await applySlackApprovalModify(
      { businessId: BIZ, runId: RUN, note: "shorter please", decidedBy: "slack:U1" },
      makeDb(c)
    );
    expect(out).toEqual({ applied: true, kind: "modify" });
    const patch = (c as { update: ReturnType<typeof vi.fn> }).update.mock
      .calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.current_step).toBe(2);
    const context = patch.context as {
      vars: Record<string, unknown>;
      approval: Record<string, unknown>;
    };
    expect(context.approval).toMatchObject({ decision: "modify", note: "shorter please" });
    expect(context.vars.existing).toBe("kept");
    // The resume marker points at the redraft step, not the gate.
    expect(context.vars.__resume_step_id).toBe("draft-step");
  });

  it("refuses when the gate declared no redraft, and no-ops on races", async () => {
    vi.mocked(getAiFlowRun).mockResolvedValue({
      ...AWAITING,
      context: { approval: { options: ["approve", "cancel"] } }
    } as never);
    expect(
      await applySlackApprovalModify(
        { businessId: BIZ, runId: RUN, note: "x", decidedBy: "d" },
        makeDb()
      )
    ).toEqual({ applied: false, reason: "not_modifiable" });

    vi.mocked(getAiFlowRun).mockResolvedValue(AWAITING as never);
    expect(
      await applySlackApprovalModify(
        { businessId: BIZ, runId: RUN, note: "x", decidedBy: "d" },
        makeDb(updateChain({ data: [], error: null }))
      )
    ).toEqual({ applied: false, reason: "already_handled" });

    vi.mocked(getAiFlowRun).mockResolvedValue({ ...AWAITING, status: "done" } as never);
    expect(
      (
        await applySlackApprovalModify(
          { businessId: BIZ, runId: RUN, note: "x", decidedBy: "d" },
          makeDb()
        )
      ).applied
    ).toBe(false);
  });

  it("throws on write errors and uses the default client when none is passed", async () => {
    await expect(
      applySlackApprovalModify(
        { businessId: BIZ, runId: RUN, note: "x", decidedBy: "d" },
        makeDb(updateChain({ data: null, error: { message: "e" } }))
      )
    ).rejects.toThrow(/applySlackApprovalModify: e/);

    defaultClientSpy.mockReturnValueOnce(makeDb(updateChain({ data: [{ id: RUN }], error: null })));
    expect(
      (await applySlackApprovalModify({ businessId: BIZ, runId: RUN, note: "x", decidedBy: "d" }))
        .applied
    ).toBe(true);
  });
});

describe("findAwaitingApprovalRunBySlackThread", () => {
  it("matches the stored channel strictly, tolerates a missing one, nulls misses and errors", async () => {
    expect(
      await findAwaitingApprovalRunBySlackThread(
        BIZ,
        "C-9",
        "77.7",
        makeDb(updateChain({ data: [{ id: RUN, slack_channel_id: "C-9" }], error: null }))
      )
    ).toEqual({ runId: RUN });

    // Same ts in a DIFFERENT channel: never an approval answer.
    expect(
      await findAwaitingApprovalRunBySlackThread(
        BIZ,
        "C-other",
        "77.7",
        makeDb(updateChain({ data: [{ id: RUN, slack_channel_id: "C-9" }], error: null }))
      )
    ).toBeNull();

    // A row anchored without a channel (failed context merge) still answers.
    expect(
      await findAwaitingApprovalRunBySlackThread(
        BIZ,
        "C-9",
        "77.7",
        makeDb(updateChain({ data: [{ id: RUN, slack_channel_id: null }], error: null }))
      )
    ).toEqual({ runId: RUN });

    expect(
      await findAwaitingApprovalRunBySlackThread(
        BIZ,
        "C-9",
        "77.7",
        makeDb(updateChain({ data: [], error: null }))
      )
    ).toBeNull();
    expect(
      await findAwaitingApprovalRunBySlackThread(
        BIZ,
        "C-9",
        "77.7",
        makeDb(updateChain({ data: null, error: { message: "e" } }))
      )
    ).toBeNull();
    defaultClientSpy.mockReturnValueOnce(makeDb(updateChain({ data: null, error: null })));
    expect(await findAwaitingApprovalRunBySlackThread(BIZ, "C-9", "77.7")).toBeNull();
  });
});

describe("answerApprovalFromText + acks + digit parsing", () => {
  it("routes a digit to its stored option and prose to the modify rewind", async () => {
    const decided = await answerApprovalFromText(
      { businessId: BIZ, runId: RUN, text: "2", decidedBy: "slack:U1" },
      makeDb()
    );
    expect(decided).toEqual({ applied: true, kind: "decision", option: "skip" });

    const c = updateChain({ data: [{ id: RUN }], error: null });
    const modified = await answerApprovalFromText(
      { businessId: BIZ, runId: RUN, text: "make it warmer", decidedBy: "slack:U1" },
      makeDb(c)
    );
    expect(modified).toEqual({ applied: true, kind: "modify" });

    vi.mocked(getAiFlowRun).mockResolvedValue(null as never);
    expect(
      (
        await answerApprovalFromText(
          { businessId: BIZ, runId: RUN, text: "1", decidedBy: "d" },
          makeDb()
        )
      ).applied
    ).toBe(false);

    defaultClientSpy.mockReturnValueOnce(makeDb());
    vi.mocked(getAiFlowRun).mockResolvedValue(AWAITING as never);
    expect(
      (await answerApprovalFromText({ businessId: BIZ, runId: RUN, text: "1", decidedBy: "d" }))
        .applied
    ).toBe(true);
  });

  it("acks mirror the SMS wording for every outcome", () => {
    expect(slackApprovalAck({ applied: true, kind: "decision", option: "approve" })).toContain(
      "Approved, sending it now"
    );
    expect(
      slackApprovalAck({ applied: true, kind: "decision", option: "bypass_quiet_hours" })
    ).toContain("skip quiet hours");
    expect(slackApprovalAck({ applied: true, kind: "decision", option: "skip" })).toContain(
      "Skipped"
    );
    expect(slackApprovalAck({ applied: true, kind: "decision", option: "cancel" })).toContain(
      "Canceled"
    );
    expect(slackApprovalAck({ applied: true, kind: "modify" })).toContain("redoing that");
    expect(slackApprovalAck({ applied: false, reason: "already_handled" })).toContain(
      "already handled"
    );
    expect(slackApprovalAck({ applied: false, reason: "unknown_option" })).toContain(
      "isn't available"
    );
    expect(slackApprovalAck({ applied: false, reason: "not_modifiable" })).toContain(
      "buttons above"
    );
  });

  it("parses digits against the stored list only", () => {
    expect(slackApprovalOptionForText(["approve", "cancel"], "2")).toBe("cancel");
    expect(slackApprovalOptionForText(["approve", "cancel"], "9")).toBeNull();
    expect(slackApprovalOptionForText(undefined, "1")).toBe("approve");
  });
});

describe("modify edge shapes", () => {
  it("rewinds without a step-id marker and treats null update data as a race", async () => {
    vi.mocked(getAiFlowRun).mockResolvedValue({
      id: RUN,
      status: "awaiting_approval",
      context: { approval: { options: ["approve", "cancel"], redraft_step_index: 1 } }
    } as never);
    const c = updateChain({ data: [{ id: RUN }], error: null });
    const out = await applySlackApprovalModify(
      { businessId: BIZ, runId: RUN, note: "warmer", decidedBy: "d" },
      makeDb(c)
    );
    expect(out).toEqual({ applied: true, kind: "modify" });

    expect(
      await applySlackApprovalModify(
        { businessId: BIZ, runId: RUN, note: "warmer", decidedBy: "d" },
        makeDb(updateChain({ data: null, error: null }))
      )
    ).toEqual({ applied: false, reason: "already_handled" });

    // A run with a null context still rewinds (spread fallback).
    vi.mocked(getAiFlowRun).mockResolvedValue({
      id: RUN,
      status: "awaiting_approval",
      context: null
    } as never);
    expect(
      await applySlackApprovalModify(
        { businessId: BIZ, runId: RUN, note: "warmer", decidedBy: "d" },
        makeDb()
      )
    ).toEqual({ applied: false, reason: "not_modifiable" });
  });
});
