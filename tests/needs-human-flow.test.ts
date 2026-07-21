import { describe, expect, it, vi } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  NEEDS_HUMAN_TEAM_FLOW_NAME,
  applyNeedsHumanTeamFirstSetting,
  ensureNeedsHumanTeamFlow,
  needsHumanTeamFlowDefinition,
  setNeedsHumanTeamFlowEnabled
} from "@/lib/ai-flows/needs-human-flow";
import { NEEDS_HUMAN_TAG } from "../supabase/functions/_shared/needs_human";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * The seeded "Human handoff — offer to team first" flow: created/enabled by
 * the Employees-page toggle, it reacts to the Needs Human tag with a
 * broadcastAll route_to_team (10-minute shared deadline, owner fallback).
 * Visible and editable like any flow — the toggle only manages enablement.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

/** Chainable fake: `from` returns a thenable builder; each terminal await
 * resolves the next scripted result. The ROOT is deliberately not thenable
 * (an async resolveDb would unwrap it). */
function fakeDb(results: Array<{ data?: unknown; error?: unknown }>) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let idx = 0;
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "eq", "limit", "maybeSingle", "single"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ name: m, args });
      return builder;
    };
  }
  builder["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[idx++] ?? { data: null, error: null }).then(resolve);
  const db = {
    from: (...args: unknown[]) => {
      calls.push({ name: "from", args });
      return builder;
    }
  };
  return { db, calls };
}

describe("needsHumanTeamFlowDefinition", () => {
  it("is a valid definition: Needs Human tag trigger + one broadcastAll route step", () => {
    const def = parseAiFlowDefinition(needsHumanTeamFlowDefinition());
    const trigger = def.trigger as { channel: string; tag?: string; change?: string };
    expect(trigger.channel).toBe("tag_changed");
    expect(trigger.tag).toBe(NEEDS_HUMAN_TAG);
    expect(trigger.change).toBe("added");
    expect(def.steps).toHaveLength(1);
    const step = def.steps[0] as {
      type: string;
      broadcastAll?: boolean;
      responseMinutes?: number;
      offerTemplate: string;
      ownerFallbackTemplate: string;
      claimedNotifyTemplate?: string;
    };
    expect(step.type).toBe("route_to_team");
    expect(step.broadcastAll).toBe(true);
    expect(step.responseMinutes).toBe(10);
    // The offer must tell the teammate WHO needs a human and WHAT they said,
    // and teach the universal claim digits.
    expect(step.offerTemplate).toContain("{{trigger.from}}");
    expect(step.offerTemplate).toContain("{{trigger.note}}");
    expect(step.offerTemplate).toContain("1");
    expect(step.offerTemplate).toContain("2");
    // Owner fallback carries the same context (this IS the 10-minute page).
    expect(step.ownerFallbackTemplate).toContain("{{trigger.from}}");
    expect(step.ownerFallbackTemplate).toContain("{{trigger.note}}");
    expect(step.claimedNotifyTemplate).toBeTruthy();
  });
});

describe("ensureNeedsHumanTeamFlow", () => {
  it("creates the flow when absent", async () => {
    const { db, calls } = fakeDb([
      { data: null }, // name lookup: absent
      { data: { id: "flow-9" } } // insert returning id
    ]);
    const res = await ensureNeedsHumanTeamFlow(BIZ, db as never);
    expect(res).toEqual({ flowId: "flow-9", created: true });
    const insert = calls.find((c) => c.name === "insert");
    const row = insert?.args[0] as { name: string; enabled: boolean; business_id: string };
    expect(row.name).toBe(NEEDS_HUMAN_TEAM_FLOW_NAME);
    expect(row.enabled).toBe(true);
    expect(row.business_id).toBe(BIZ);
  });

  it("re-enables an existing disabled flow instead of duplicating it", async () => {
    const { db, calls } = fakeDb([
      { data: { id: "flow-1", enabled: false } },
      { data: null } // enable update
    ]);
    const res = await ensureNeedsHumanTeamFlow(BIZ, db as never);
    expect(res).toEqual({ flowId: "flow-1", created: false });
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ enabled: true });
  });

  it("an existing enabled flow is left untouched", async () => {
    const { db, calls } = fakeDb([{ data: { id: "flow-1", enabled: true } }]);
    const res = await ensureNeedsHumanTeamFlow(BIZ, db as never);
    expect(res).toEqual({ flowId: "flow-1", created: false });
    expect(calls.some((c) => c.name === "update" || c.name === "insert")).toBe(false);
  });

  it("throws on lookup/insert/enable errors (the toggle save must fail loudly)", async () => {
    const lookupFail = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(ensureNeedsHumanTeamFlow(BIZ, lookupFail.db as never)).rejects.toThrow(
      "ensureNeedsHumanTeamFlow"
    );
    const insertFail = fakeDb([{ data: null }, { data: null, error: { message: "boom" } }]);
    await expect(ensureNeedsHumanTeamFlow(BIZ, insertFail.db as never)).rejects.toThrow(
      "ensureNeedsHumanTeamFlow"
    );
    const enableFail = fakeDb([
      { data: { id: "flow-1", enabled: false } },
      { data: null, error: { message: "boom" } }
    ]);
    await expect(ensureNeedsHumanTeamFlow(BIZ, enableFail.db as never)).rejects.toThrow(
      "ensureNeedsHumanTeamFlow"
    );
  });

  it("resolves the service client when none is injected", async () => {
    const { db } = fakeDb([{ data: { id: "flow-1", enabled: true } }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const res = await ensureNeedsHumanTeamFlow(BIZ);
    expect(res.flowId).toBe("flow-1");
  });
});

describe("setNeedsHumanTeamFlowEnabled", () => {
  it("disables the flow by its seeded name", async () => {
    const { db, calls } = fakeDb([{ data: null }]);
    await setNeedsHumanTeamFlowEnabled(BIZ, false, db as never);
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ enabled: false });
    const nameEq = calls.find((c) => c.name === "eq" && c.args[0] === "name");
    expect(nameEq?.args[1]).toBe(NEEDS_HUMAN_TEAM_FLOW_NAME);
  });

  it("throws on a write error", async () => {
    const { db } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(setNeedsHumanTeamFlowEnabled(BIZ, false, db as never)).rejects.toThrow(
      "setNeedsHumanTeamFlowEnabled"
    );
  });

  it("resolves the service client when none is injected", async () => {
    const { db, calls } = fakeDb([{ data: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await setNeedsHumanTeamFlowEnabled(BIZ, true);
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ enabled: true });
  });
});

describe("applyNeedsHumanTeamFirstSetting", () => {
  it("ON: arms the flow, then flips the column", async () => {
    const { db, calls } = fakeDb([
      { data: { id: "flow-1", enabled: true } }, // flow lookup (already armed)
      { data: null } // businesses column update
    ]);
    await applyNeedsHumanTeamFirstSetting(BIZ, true, db as never);
    const tables = calls.filter((c) => c.name === "from").map((c) => c.args[0]);
    expect(tables).toEqual(["ai_flows", "businesses"]);
    const updates = calls.filter((c) => c.name === "update");
    expect(updates[updates.length - 1]?.args[0]).toEqual({ needs_human_team_first: true });
  });

  it("ON with a failed column write: the flow is DISARMED again before rethrowing", async () => {
    // Without the rollback an enabled flow beside an OFF column would
    // broadcast AND page on every escalation (Bugbot, PR #801).
    const { db, calls } = fakeDb([
      { data: null }, // flow lookup: absent
      { data: { id: "flow-9" } }, // insert (armed)
      { data: null, error: { message: "boom" } }, // column write fails
      { data: null } // disarm update (rollback)
    ]);
    await expect(applyNeedsHumanTeamFirstSetting(BIZ, true, db as never)).rejects.toThrow(
      "setNeedsHumanTeamFirst"
    );
    const updates = calls.filter((c) => c.name === "update");
    expect(updates[updates.length - 1]?.args[0]).toEqual({ enabled: false });
  });

  it("ON with a failed column write AND a failed disarm: logs, still rethrows the column error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb([
      { data: { id: "flow-1", enabled: true } },
      { data: null, error: { message: "boom" } }, // column write fails
      { data: null, error: { message: "also boom" } } // disarm fails too
    ]);
    await expect(applyNeedsHumanTeamFirstSetting(BIZ, true, db as never)).rejects.toThrow(
      "setNeedsHumanTeamFirst"
    );
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("OFF: disables the flow, then clears the column", async () => {
    const { db, calls } = fakeDb([
      { data: null }, // flow disable
      { data: null } // column clear
    ]);
    await applyNeedsHumanTeamFirstSetting(BIZ, false, db as never);
    const updates = calls.filter((c) => c.name === "update");
    expect(updates[0]?.args[0]).toEqual({ enabled: false });
    expect(updates[1]?.args[0]).toEqual({ needs_human_team_first: false });
  });

  it("resolves the service client when none is injected", async () => {
    const { db } = fakeDb([{ data: null }, { data: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(applyNeedsHumanTeamFirstSetting(BIZ, false)).resolves.toBeUndefined();
  });
});
