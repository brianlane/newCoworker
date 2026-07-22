/**
 * Shared edit_aiflow core (src/lib/ai-flows/edit-flow-tool.ts): flow
 * resolution pass-throughs, the compile-refusal contract (live flow
 * untouched), persist-failure honesty, and the applied-edit summary.
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

const BIZ = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";

const DEFINITION: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "original" }]
} as AiFlowDefinition;

const EDITED: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "updated" }]
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

function happyDeps(overrides: Partial<EditFlowToolDeps> = {}): EditFlowToolDeps {
  return {
    listFlows: vi.fn(async () => [flowRow()]),
    compileEdit: vi.fn(async () => ({ ok: true as const, definition: EDITED, warnings: [] })),
    persistUpdate: vi.fn(async () => flowRow({ definition: EDITED })),
    ...overrides
  };
}

const ARGS = { flow: "Lead follow-up", instructions: "change the message to 'updated'" };

describe("editAiFlowTool", () => {
  it("resolves, compiles against the CURRENT definition, persists, and summarizes", async () => {
    const deps = happyDeps();
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({
      ok: true,
      flowId: FLOW_ID,
      flowName: "Lead follow-up",
      enabled: true,
      stepCount: 1,
      triggerChannel: "manual"
    });
    if (res.ok) {
      expect(res.note).toContain(`/dashboard/aiflows?edit=${FLOW_ID}`);
      expect(res.note).not.toContain("still disabled");
    }
    expect(deps.compileEdit).toHaveBeenCalledWith({
      businessId: BIZ,
      flowName: "Lead follow-up",
      currentDefinition: DEFINITION,
      instructions: ARGS.instructions
    });
    // Enabled state untouched, no rename unless asked.
    expect(deps.persistUpdate).toHaveBeenCalledWith({
      businessId: BIZ,
      id: FLOW_ID,
      definition: EDITED
    });
  });

  it("renames only when newName is supplied, and notes a disabled flow honestly", async () => {
    const deps = happyDeps({
      listFlows: vi.fn(async () => [flowRow({ enabled: false })]),
      persistUpdate: vi.fn(async () =>
        flowRow({ enabled: false, name: "Renamed", definition: EDITED })
      )
    });
    const res = await editAiFlowTool(BIZ, { ...ARGS, newName: "Renamed" }, deps);
    expect(res).toMatchObject({ ok: true, flowName: "Renamed", enabled: false });
    if (res.ok) expect(res.note).toContain("still disabled");
    expect(deps.persistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" })
    );
  });

  it("resolves by id and by unique substring; misses and ambiguity refuse with steering", async () => {
    const two = [flowRow(), flowRow({ id: "33333333-3333-4333-8333-333333333333", name: "Lead intake" })];
    const deps = happyDeps({ listFlows: vi.fn(async () => two) });

    const byId = await editAiFlowTool(BIZ, { ...ARGS, flow: FLOW_ID }, deps);
    expect(byId.ok).toBe(true);

    const bySub = await editAiFlowTool(BIZ, { ...ARGS, flow: "follow-up" }, deps);
    expect(bySub.ok).toBe(true);

    const miss = await editAiFlowTool(BIZ, { ...ARGS, flow: "nope" }, deps);
    expect(miss).toMatchObject({ ok: false });
    if (!miss.ok) expect(miss.message).toContain("No AiFlow matches");

    const ambiguous = await editAiFlowTool(BIZ, { ...ARGS, flow: "Lead" }, deps);
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) expect(ambiguous.message).toContain("matches 2 flows");
  });

  it("passes a compile refusal through verbatim and never persists", async () => {
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
    expect(deps.persistUpdate).not.toHaveBeenCalled();
  });

  it("a persist failure degrades to an honest 'not changed' (Error and non-Error throws)", async () => {
    const deps = happyDeps({
      persistUpdate: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const res = await editAiFlowTool(BIZ, ARGS, deps);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("NOT changed");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "edit_aiflow: persist failed",
      expect.objectContaining({ error: "db down" })
    );

    const deps2 = happyDeps({
      persistUpdate: vi.fn(async () => {
        throw "string failure";
      })
    });
    const res2 = await editAiFlowTool(BIZ, ARGS, deps2);
    expect(res2).toMatchObject({ ok: false });
  });
});

describe("editAiflowToolArgsSchema", () => {
  it("requires flow + instructions, bounds newName", () => {
    expect(editAiflowToolArgsSchema.safeParse(ARGS).success).toBe(true);
    expect(editAiflowToolArgsSchema.safeParse({ flow: "f" }).success).toBe(false);
    expect(editAiflowToolArgsSchema.safeParse({ ...ARGS, newName: "" }).success).toBe(false);
    expect(
      editAiflowToolArgsSchema.safeParse({ ...ARGS, newName: "x".repeat(121) }).success
    ).toBe(false);
  });
});
