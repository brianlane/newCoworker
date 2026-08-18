import { describe, expect, it, vi } from "vitest";
import {
  FLOW_VERSION_LIST_LIMIT,
  listFlowVersions,
  restoreFlowVersion,
  type AiFlowVersionRow
} from "@/lib/ai-flows/versions";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

const DEF_OLD = {
  version: 1,
  trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
  steps: [{ id: "s1", type: "notify_owner", message: "the original wording" }]
};

function makeVersion(over: Record<string, unknown> = {}): AiFlowVersionRow {
  return {
    id: 7,
    flow_id: "flow-1",
    business_id: "biz-1",
    definition: DEF_OLD,
    name: "Lead follow-up",
    enabled: true,
    source: "ai_edit_sms",
    actor: "+15555550100",
    replaced_at: "2026-08-18T04:00:00Z",
    ...over
  } as AiFlowVersionRow;
}

/** Minimal PostgREST builder: every call chains, the await resolves. */
function makeDb(result: { data?: unknown; error?: { message: string } | null }) {
  const thenable: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
  };
  for (const m of ["select", "eq", "order", "limit"]) {
    thenable[m] = vi.fn(() => thenable);
  }
  const db = { from: vi.fn(() => thenable) };
  return {
    db,
    thenable: thenable as unknown as Record<string, ReturnType<typeof vi.fn>>
  };
}

describe("listFlowVersions", () => {
  it("reads newest-first, scoped to the business as well as the flow", async () => {
    const { db, thenable } = makeDb({ data: [makeVersion()] });
     
    const rows = await listFlowVersions("biz-1", "flow-1", { client: db as any });
    expect(rows).toHaveLength(1);
    expect(db.from).toHaveBeenCalledWith("ai_flow_definition_versions");
    // Business scoping is the isolation boundary: a flow id guessed from
    // another tenant must read as empty rather than leak a definition.
    expect(thenable.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(thenable.eq).toHaveBeenCalledWith("flow_id", "flow-1");
    expect(thenable.order).toHaveBeenCalledWith("replaced_at", { ascending: false });
    expect(thenable.limit).toHaveBeenCalledWith(FLOW_VERSION_LIST_LIMIT);
  });

  it("breaks replaced_at ties by id, so two edits in the same instant still order", async () => {
    const { db, thenable } = makeDb({ data: [] });
     
    await listFlowVersions("biz-1", "flow-1", { client: db as any });
    expect(thenable.order).toHaveBeenCalledWith("id", { ascending: false });
  });

  it("clamps the limit at both ends", async () => {
    const { db, thenable } = makeDb({ data: [] });
     
    await listFlowVersions("biz-1", "flow-1", { client: db as any, limit: 0 });
    expect(thenable.limit).toHaveBeenCalledWith(1);
     
    await listFlowVersions("biz-1", "flow-1", { client: db as any, limit: 5000 });
    expect(thenable.limit).toHaveBeenCalledWith(100);
  });

  it("returns [] when the table has nothing rather than null", async () => {
    const { db } = makeDb({ data: null });
     
    await expect(listFlowVersions("biz-1", "flow-1", { client: db as any })).resolves.toEqual([]);
  });

  it("throws on a read error", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    await expect(
       
      listFlowVersions("biz-1", "flow-1", { client: db as any })
    ).rejects.toThrow("listFlowVersions: boom");
  });
});

describe("restoreFlowVersion", () => {
  it("with no versionId, writes the most recent snapshot back", async () => {
    const persistUpdate = vi.fn(async () => ({ id: "flow-1", name: "Lead follow-up" }));
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [makeVersion({ id: 9 }), makeVersion({ id: 4 })],
       
      persistUpdate: persistUpdate as any
    });
    expect(result).toMatchObject({ ok: true, versionId: 9, undoneSource: "ai_edit_sms" });
    expect(persistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flow-1", name: "Lead follow-up", definition: DEF_OLD })
    );
  });

  it("restores through updateAiFlow, so the undo is validated AND snapshotted itself", async () => {
    // The whole point of not writing ai_flows directly: the restore trips
    // the same trigger, so undoing the wrong edit is not a second
    // unrecoverable event.
    const persistUpdate = vi.fn(async () => ({ id: "flow-1", name: "Lead follow-up" }));
    await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [makeVersion()],
       
      persistUpdate: persistUpdate as any,
      editSource: "ai_undo_sms",
      editActor: "+15555550100"
    });
    expect(persistUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ editSource: "ai_undo_sms", editActor: "+15555550100" })
    );
  });

  it("never restores `enabled`: an undo must not switch an automation back on", async () => {
    const persistUpdate = vi.fn(async (_input: Record<string, unknown>) => ({
      id: "flow-1",
      name: "Lead follow-up"
    }));
    await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [makeVersion({ enabled: true })],
       
      persistUpdate: persistUpdate as any
    });
    expect(persistUpdate.mock.calls[0][0]).not.toHaveProperty("enabled");
  });

  it("targets an explicit versionId when given", async () => {
    const persistUpdate = vi.fn(async () => ({ id: "flow-1", name: "Older name" }));
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      versionId: 4,
      fetchVersions: async () => [makeVersion({ id: 9 }), makeVersion({ id: 4, name: "Older name" })],
       
      persistUpdate: persistUpdate as any
    });
    expect(result).toMatchObject({ ok: true, versionId: 4 });
  });

  it("refuses honestly when there is no history", async () => {
    const persistUpdate = vi.fn();
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [],
       
      persistUpdate: persistUpdate as any
    });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("nothing to undo") });
    expect(persistUpdate).not.toHaveBeenCalled();
  });

  it("refuses an unknown versionId instead of silently undoing something else", async () => {
    const persistUpdate = vi.fn();
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      versionId: 123,
      fetchVersions: async () => [makeVersion({ id: 9 })],
       
      persistUpdate: persistUpdate as any
    });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("123") });
    expect(persistUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed write as unchanged rather than throwing", async () => {
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [makeVersion()],
      persistUpdate: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("was not changed")
    });
    expect((result as { message: string }).message).toContain("db down");
  });

  it("stringifies a non-Error throw", async () => {
    const result = await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions: async () => [makeVersion()],
      persistUpdate: vi.fn(async () => {
        throw "nope";
      })
    });
    expect((result as { message: string }).message).toContain("nope");
  });

  it("passes an injected client through to the history read", async () => {
    const fetchVersions = vi.fn(async () => [makeVersion()]);
    const client = { marker: true };
    await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions,
       
      client: client as any,
      persistUpdate: vi.fn(async () => ({ id: "flow-1", name: "Lead follow-up" })) as any
    });
    expect(fetchVersions).toHaveBeenCalledWith("biz-1", "flow-1", { client });
  });

  it("omits the client key entirely when none was given", async () => {
    const fetchVersions = vi.fn(async () => [makeVersion()]);
    await restoreFlowVersion("biz-1", "flow-1", {
      fetchVersions,
       
      persistUpdate: vi.fn(async () => ({ id: "flow-1", name: "Lead follow-up" })) as any
    });
    expect(fetchVersions).toHaveBeenCalledWith("biz-1", "flow-1", {});
  });
});
