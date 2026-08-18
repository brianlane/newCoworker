import { describe, expect, it, vi } from "vitest";
import { undoAiFlowEditTool, undoAiflowToolArgsSchema } from "@/lib/ai-flows/undo-flow-tool";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

const FLOW = {
  id: "11111111-1111-4111-8111-111111111111",
  business_id: "biz-1",
  name: "Lead follow-up",
  enabled: true,
  definition: { version: 1, trigger: { channel: "sms", conditions: [] }, steps: [] },
  created_by: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-18T04:00:00Z"
};

const okRestore = {
  ok: true as const,
  flowId: FLOW.id,
  flowName: FLOW.name,
  versionId: 9,
  replacedAt: "2026-08-18T04:00:00Z",
  undoneSource: "ai_edit_sms"
};

describe("undoAiFlowEditTool", () => {
  it("resolves the flow by name and restores its previous version", async () => {
    const restoreVersion = vi.fn(async () => okRestore);
    const result = await undoAiFlowEditTool(
      "biz-1",
      { flow: "lead follow" },
       
      { listFlows: (async () => [FLOW]) as any, restoreVersion: restoreVersion as any }
    );
    expect(result).toMatchObject({
      ok: true,
      flowId: FLOW.id,
      restoredFrom: "2026-08-18T04:00:00Z",
      undoneSource: "ai_edit_sms"
    });
    expect(restoreVersion).toHaveBeenCalledWith("biz-1", FLOW.id, expect.any(Object));
  });

  it("tells the model the undo is itself reversible", async () => {
    // Without this an owner who reverses the wrong change is told, in
    // effect, that they are now stuck with the reversal.
    const result = await undoAiFlowEditTool(
      "biz-1",
      { flow: FLOW.id },
       
      { listFlows: (async () => [FLOW]) as any, restoreVersion: (async () => okRestore) as any }
    );
    expect((result as { note: string }).note).toMatch(/reversible/i);
    // ...and must not push the raw definition into a text message.
    expect((result as { note: string }).note).toMatch(/do NOT repeat the JSON/i);
  });

  it("passes provenance through so the undo is attributed to its surface", async () => {
    const restoreVersion = vi.fn(async () => okRestore);
    await undoAiFlowEditTool(
      "biz-1",
      { flow: FLOW.id },
      {
         
        listFlows: (async () => [FLOW]) as any,
         
        restoreVersion: restoreVersion as any,
        editSource: "ai_edit_sms",
        editActor: "+15555550100"
      }
    );
    expect(restoreVersion).toHaveBeenCalledWith(
      "biz-1",
      FLOW.id,
      expect.objectContaining({ editSource: "ai_edit_sms", editActor: "+15555550100" })
    );
  });

  it("forwards an injected history reader, and omits the key when absent", async () => {
    const restoreVersion = vi.fn(
      async (_biz: string, _flow: string, _opts: Record<string, unknown>) => okRestore
    );
    const fetchVersions = vi.fn();
    await undoAiFlowEditTool(
      "biz-1",
      { flow: FLOW.id },
       
      { listFlows: (async () => [FLOW]) as any, restoreVersion: restoreVersion as any, fetchVersions }
    );
    expect(restoreVersion.mock.calls[0][2]).toMatchObject({ fetchVersions });

    restoreVersion.mockClear();
    await undoAiFlowEditTool(
      "biz-1",
      { flow: FLOW.id },
       
      { listFlows: (async () => [FLOW]) as any, restoreVersion: restoreVersion as any }
    );
    expect(restoreVersion.mock.calls[0][2]).not.toHaveProperty("fetchVersions");
  });

  it("relays an unresolvable flow reference", async () => {
    const restoreVersion = vi.fn();
    const result = await undoAiFlowEditTool(
      "biz-1",
      { flow: "no such automation" },
       
      { listFlows: (async () => [FLOW]) as any, restoreVersion: restoreVersion as any }
    );
    expect(result).toMatchObject({ ok: false });
    expect(restoreVersion).not.toHaveBeenCalled();
  });

  it("relays a refusal from the restore core verbatim", async () => {
    const result = await undoAiFlowEditTool(
      "biz-1",
      { flow: FLOW.id },
      {
         
        listFlows: (async () => [FLOW]) as any,
        restoreVersion: (async () => ({
          ok: false as const,
          message: "This automation has no earlier version recorded, so there is nothing to undo."
        })) as any
      }
    );
    expect(result).toEqual({ ok: false, message: expect.stringContaining("nothing to undo") });
  });

  it("bounds the flow reference", () => {
    expect(undoAiflowToolArgsSchema.safeParse({ flow: "" }).success).toBe(false);
    expect(undoAiflowToolArgsSchema.safeParse({ flow: "x".repeat(201) }).success).toBe(false);
    expect(undoAiflowToolArgsSchema.safeParse({ flow: "Lead follow-up" }).success).toBe(true);
  });
});
