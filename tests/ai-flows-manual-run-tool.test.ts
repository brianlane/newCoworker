import { describe, expect, it, vi } from "vitest";
import {
  LIST_AIFLOWS_MAX,
  flowTriggerSummary,
  listAiFlowsTool,
  runAiFlowTool,
  runAiflowToolArgsSchema,
  type ManualRunToolDeps
} from "@/lib/ai-flows/manual-run-tool";

/**
 * Shared cores behind BOTH dashboard-chat "run automations" surfaces — the
 * inline action tools and the Rowboat dispatcher's dashboard_ twins. The
 * behavior here is model-facing contract: honest refusals, never a fake
 * success.
 */

type Flow = {
  id: string;
  name: string;
  enabled: boolean;
  definition: { trigger?: { channel?: string; on?: string } };
};

function flow(over: Partial<Flow>): Flow {
  return {
    id: "0f0e0d0c-0b0a-4a4b-8c8d-1a2b3c4d5e6f",
    name: "HomeLight Referral",
    enabled: true,
    definition: { trigger: { channel: "sms" } },
    ...over
  };
}

function deps(over: {
  flows?: Flow[];
  enqueueFlowRun?: ReturnType<typeof vi.fn>;
}): ManualRunToolDeps & { enqueueFlowRun: ReturnType<typeof vi.fn> } {
  const enqueueFlowRun = over.enqueueFlowRun ?? vi.fn(async () => ({ id: "run-1" }));
  return {
    listFlows: vi.fn(async () => over.flows ?? [flow({})]) as never,
    enqueueFlowRun: enqueueFlowRun as never
  } as ManualRunToolDeps & { enqueueFlowRun: ReturnType<typeof vi.fn> };
}

describe("flowTriggerSummary", () => {
  it("labels manual, calendar, channel, and unknown triggers", () => {
    expect(flowTriggerSummary({ trigger: { channel: "manual" } })).toBe("manual (run on demand)");
    expect(flowTriggerSummary({ trigger: { channel: "calendar", on: "created" } })).toBe(
      "calendar (created)"
    );
    expect(flowTriggerSummary({ trigger: { channel: "calendar" } })).toBe("calendar (event)");
    expect(flowTriggerSummary({ trigger: { channel: "sms" } })).toBe("sms");
    expect(flowTriggerSummary({})).toBe("unknown trigger");
  });
});

describe("runAiflowToolArgsSchema", () => {
  it("bounds flow and input exactly like the dashboard Run-now endpoint", () => {
    expect(runAiflowToolArgsSchema.safeParse({ flow: "x" }).success).toBe(true);
    expect(runAiflowToolArgsSchema.safeParse({ flow: "" }).success).toBe(false);
    expect(
      runAiflowToolArgsSchema.safeParse({ flow: "x", input: "y".repeat(4001) }).success
    ).toBe(false);
  });
});

describe("listAiFlowsTool", () => {
  it("lists id/name/enabled/trigger with the guidance note, capped", async () => {
    const flows = Array.from({ length: LIST_AIFLOWS_MAX + 5 }, (_, i) =>
      flow({ id: `id-${i}`, name: `Flow ${i}` })
    );
    const res = await listAiFlowsTool("biz", deps({ flows }));
    expect(res.ok).toBe(true);
    expect(res.flows).toHaveLength(LIST_AIFLOWS_MAX);
    expect(res.flows[0]).toEqual({ id: "id-0", name: "Flow 0", enabled: true, trigger: "sms" });
    expect(res.note).toMatch(/offer it as an option/);
  });
});

describe("runAiFlowTool", () => {
  it("resolves by exact id, then exact name, then unique substring", async () => {
    const flows = [
      flow({ id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Alpha" }),
      flow({ id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Beta nurture" })
    ];
    for (const ref of [
      "aaaaaaaa-0000-4000-8000-000000000002",
      "beta nurture",
      "nurture"
    ]) {
      const d = deps({ flows });
      const res = await runAiFlowTool("biz", { flow: ref }, d);
      expect(res.ok, ref).toBe(true);
      expect(d.enqueueFlowRun).toHaveBeenCalledWith(
        expect.objectContaining({ flowId: "aaaaaaaa-0000-4000-8000-000000000002" })
      );
    }
  });

  it("refuses honestly on no match and on ambiguity", async () => {
    const flows = [flow({ name: "Alpha one" }), flow({ id: "x2", name: "Alpha two" })];
    const d = deps({ flows });
    const none = await runAiFlowTool("biz", { flow: "zeta" }, d);
    expect(none).toMatchObject({ ok: false, message: expect.stringMatching(/No AiFlow matches/) });
    const ambiguous = await runAiFlowTool("biz", { flow: "alpha" }, d);
    expect(ambiguous).toMatchObject({
      ok: false,
      message: expect.stringMatching(/matches 2 flows/)
    });
    expect(d.enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("refuses disabled flows and voice flows without enqueueing", async () => {
    const disabledDeps = deps({ flows: [flow({ enabled: false })] });
    const disabled = await runAiFlowTool("biz", { flow: "HomeLight Referral" }, disabledDeps);
    expect(disabled).toMatchObject({ ok: false, message: expect.stringMatching(/DISABLED/) });
    expect(disabledDeps.enqueueFlowRun).not.toHaveBeenCalled();

    const voiceDeps = deps({
      flows: [flow({ definition: { trigger: { channel: "voice" } } })]
    });
    const voice = await runAiFlowTool("biz", { flow: "HomeLight Referral" }, voiceDeps);
    expect(voice).toMatchObject({ ok: false, message: expect.stringMatching(/voice flow/) });
    expect(voiceDeps.enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("enqueues a manual run with the assistant trigger scope and unique dedupe key", async () => {
    const d = deps({ enqueueFlowRun: vi.fn(async () => ({ id: "run-9" })) });
    const res = await runAiFlowTool(
      "biz",
      { flow: "HomeLight Referral", input: "lead notes" },
      d
    );
    expect(res).toMatchObject({ ok: true, runId: "run-9", flowName: "HomeLight Referral" });
    const call = d.enqueueFlowRun.mock.calls[0][0] as {
      businessId: string;
      dedupeKey: string;
      trigger: Record<string, unknown>;
    };
    expect(call.businessId).toBe("biz");
    expect(call.dedupeKey).toMatch(/^manual:/);
    expect(call.trigger).toMatchObject({
      channel: "manual",
      windowText: "lead notes",
      from: "assistant"
    });
  });

  it("reports an enqueue failure honestly", async () => {
    const d = deps({ enqueueFlowRun: vi.fn(async () => null) });
    const res = await runAiFlowTool("biz", { flow: "HomeLight Referral" }, d);
    expect(res).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be enqueued/)
    });
  });
});
