import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PipelineError,
  RETAG_SCAN_LIMIT,
  listPipelines,
  createPipeline,
  renamePipeline,
  deletePipeline,
  addStage,
  updateStage,
  reorderStages,
  deleteStage
} from "@/lib/pipelines/db";
import {
  MAX_PIPELINES_PER_BUSINESS,
  MAX_STAGES_PER_PIPELINE
} from "@/lib/pipelines/types";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Result = { data: unknown; error: unknown };

/**
 * A thenable PostgREST-chain stub: every builder method returns the chain,
 * and awaiting it (at any depth, incl. single()/maybeSingle()) resolves to
 * the configured result — matching how the code under test terminates its
 * chains at different methods.
 */
function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "neq",
    "in",
    "order",
    "limit",
    "single",
    "maybeSingle"
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

/**
 * db.from(table) hands out that table's queued results in order; the last
 * one repeats (covers loops issuing many identical queries, e.g. retag
 * updates). Every created chain is retained for call-shape assertions.
 */
function mockDb(queues: Record<string, Result[]>) {
  const remaining: Record<string, Result[]> = Object.fromEntries(
    Object.entries(queues).map(([k, v]) => [k, [...v]])
  );
  const chains: Record<string, ReturnType<typeof chain>[]> = {};
  const from = vi.fn((table: string) => {
    const q = remaining[table] ?? [];
    const result =
      q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: { message: `no mock for ${table}` } };
    const c = chain(result);
    (chains[table] ??= []).push(c);
    return c;
  });
  return { from, chains };
}

const P1 = { id: "p1", business_id: "biz-1", name: "Leads", position: 0 };
const S1 = { id: "s1", pipeline_id: "p1", name: "New Lead", color: "sky", position: 0 };
const S2 = { id: "s2", pipeline_id: "p1", name: "Contacted", color: "teal", position: 1 };

describe("listPipelines", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns pipelines with their ordered stages (missing stages -> empty)", async () => {
    const db = mockDb({
      pipelines: [
        { data: [P1, { id: "p2", business_id: "biz-1", name: "Onboarding", position: 1 }], error: null }
      ],
      pipeline_stages: [{ data: [S1, S2], error: null }]
    });
    const pipelines = await listPipelines("biz-1", db as never);
    expect(pipelines).toHaveLength(2);
    expect(pipelines[0]).toMatchObject({ id: "p1", businessId: "biz-1", name: "Leads" });
    expect(pipelines[0].stages.map((s) => s.name)).toEqual(["New Lead", "Contacted"]);
    // A stored off-palette color clamps to the default accent.
    expect(pipelines[0].stages[0].color).toBe("sky");
    expect(pipelines[1].stages).toEqual([]);
  });

  it("clamps an off-palette stored color", async () => {
    const db = mockDb({
      pipelines: [{ data: [P1], error: null }],
      pipeline_stages: [{ data: [{ ...S1, color: "hotpink" }], error: null }]
    });
    const [p] = await listPipelines("biz-1", db as never);
    expect(p.stages[0].color).toBe("teal");
  });

  it("returns [] without querying stages when the business has no pipelines", async () => {
    const db = mockDb({ pipelines: [{ data: [], error: null }] });
    expect(await listPipelines("biz-1", db as never)).toEqual([]);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("handles null rows and creates a service client when none is passed", async () => {
    const db = mockDb({ pipelines: [{ data: null, error: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listPipelines("biz-1")).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on pipeline and stage query errors", async () => {
    const bad = mockDb({ pipelines: [{ data: null, error: { message: "boom" } }] });
    await expect(listPipelines("biz-1", bad as never)).rejects.toThrow("listPipelines: boom");

    const badStages = mockDb({
      pipelines: [{ data: [P1], error: null }],
      pipeline_stages: [{ data: null, error: { message: "stages down" } }]
    });
    await expect(listPipelines("biz-1", badStages as never)).rejects.toThrow(
      "listPipelines: stages: stages down"
    );
  });

  it("tolerates null stage rows", async () => {
    const db = mockDb({
      pipelines: [{ data: [P1], error: null }],
      pipeline_stages: [{ data: null, error: null }]
    });
    const [p] = await listPipelines("biz-1", db as never);
    expect(p.stages).toEqual([]);
  });
});

describe("createPipeline", () => {
  beforeEach(() => vi.clearAllMocks());

  const STAGES_IN = [
    { name: "New Lead", color: "sky" },
    { name: "Won", color: "not-a-color" }
  ];

  it("creates the pipeline and its stages in order", async () => {
    const db = mockDb({
      pipelines: [
        { data: [], error: null }, // count
        { data: P1, error: null } // insert
      ],
      pipeline_stages: [{ data: [S2, S1], error: null }]
    });
    const created = await createPipeline("biz-1", "  Leads  ", STAGES_IN, db as never);
    expect(created.name).toBe("Leads");
    // Returned stages sort by position regardless of insert-return order.
    expect(created.stages.map((s) => s.id)).toEqual(["s1", "s2"]);
    // Off-palette color clamped on the write.
    const stageInsert = db.chains.pipeline_stages[0].insert.mock.calls[0][0];
    expect(stageInsert).toEqual([
      expect.objectContaining({ name: "New Lead", color: "sky", position: 0 }),
      expect.objectContaining({ name: "Won", color: "teal", position: 1 })
    ]);
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb({
      pipelines: [
        { data: [], error: null },
        { data: P1, error: null }
      ],
      pipeline_stages: [{ data: [S1], error: null }]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const created = await createPipeline("biz-1", "Leads", [{ name: "New Lead" }]);
    expect(created.id).toBe("p1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid names and stage lists before any query", async () => {
    const db = mockDb({});
    await expect(createPipeline("biz-1", "  ", [{ name: "A" }], db as never)).rejects.toThrow(
      PipelineError
    );
    await expect(
      createPipeline("biz-1", "x".repeat(81), [{ name: "A" }], db as never)
    ).rejects.toThrow("Pipeline names");
    await expect(createPipeline("biz-1", "Leads", [], db as never)).rejects.toThrow(
      `1–${MAX_STAGES_PER_PIPELINE} stages`
    );
    await expect(
      createPipeline(
        "biz-1",
        "Leads",
        Array.from({ length: MAX_STAGES_PER_PIPELINE + 1 }, (_, i) => ({ name: `S${i}` })),
        db as never
      )
    ).rejects.toThrow("stages");
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "  " }], db as never)
    ).rejects.toThrow("Stage names");
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }, { name: "a" }], db as never)
    ).rejects.toThrow("unique");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("treats a null count result as zero existing pipelines", async () => {
    const db = mockDb({
      pipelines: [
        { data: null, error: null }, // count
        { data: P1, error: null }
      ],
      pipeline_stages: [{ data: [S1], error: null }]
    });
    const created = await createPipeline("biz-1", "Leads", [{ name: "A" }], db as never);
    expect(created.position).toBe(0);
    expect(db.chains.pipelines[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0 })
    );
  });

  it("enforces the per-business pipeline cap", async () => {
    const db = mockDb({
      pipelines: [
        {
          data: Array.from({ length: MAX_PIPELINES_PER_BUSINESS }, (_, i) => ({ id: `p${i}` })),
          error: null
        }
      ]
    });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], db as never)
    ).rejects.toThrow(`at most ${MAX_PIPELINES_PER_BUSINESS} pipelines`);
  });

  it("throws on count errors, duplicate names (23505), and other insert failures", async () => {
    const badCount = mockDb({ pipelines: [{ data: null, error: { message: "nope" } }] });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], badCount as never)
    ).rejects.toThrow("createPipeline: count: nope");

    const dup = mockDb({
      pipelines: [
        { data: [], error: null },
        { data: null, error: { code: "23505", message: "duplicate key value" } }
      ]
    });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], dup as never)
    ).rejects.toThrow('A pipeline named "Leads" already exists.');

    const noRow = mockDb({
      pipelines: [
        { data: [], error: null },
        { data: null, error: null }
      ]
    });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], noRow as never)
    ).rejects.toThrow("insert returned no row");

    const otherErr = mockDb({
      pipelines: [
        { data: [], error: null },
        { data: null, error: { message: "disk full" } }
      ]
    });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], otherErr as never)
    ).rejects.toThrow("createPipeline: disk full");
  });

  it("rolls the pipeline row back when the stage insert fails", async () => {
    const db = mockDb({
      pipelines: [
        { data: [], error: null }, // count
        { data: P1, error: null }, // insert
        { data: null, error: null } // rollback delete
      ],
      pipeline_stages: [{ data: null, error: { message: "stage boom" } }]
    });
    await expect(
      createPipeline("biz-1", "Leads", [{ name: "A" }], db as never)
    ).rejects.toThrow("createPipeline: stages: stage boom");
    // Third pipelines chain is the rollback delete of the created row.
    expect(db.chains.pipelines[2].delete).toHaveBeenCalled();
    expect(db.chains.pipelines[2].eq).toHaveBeenCalledWith("id", "p1");
  });

  it("tolerates a null stage-insert return", async () => {
    const db = mockDb({
      pipelines: [
        { data: [], error: null },
        { data: P1, error: null }
      ],
      pipeline_stages: [{ data: null, error: null }]
    });
    const created = await createPipeline("biz-1", "Leads", [{ name: "A" }], db as never);
    expect(created.stages).toEqual([]);
  });
});

describe("renamePipeline / deletePipeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames and validates the new name", async () => {
    const db = mockDb({ pipelines: [{ data: [{ id: "p1" }], error: null }] });
    await renamePipeline("biz-1", "p1", "  Sales  ", db as never);
    expect(db.chains.pipelines[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sales" })
    );
    await expect(renamePipeline("biz-1", "p1", "", db as never)).rejects.toThrow(
      "Pipeline names"
    );
  });

  it("creates a service client when none is passed (rename + delete)", async () => {
    const db = mockDb({ pipelines: [{ data: [{ id: "p1" }], error: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await renamePipeline("biz-1", "p1", "Sales");
    await deletePipeline("biz-1", "p1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(2);
  });

  it("maps a zero-row rename/delete to not_found and surfaces query errors", async () => {
    const missing = mockDb({ pipelines: [{ data: [], error: null }] });
    await expect(renamePipeline("biz-1", "p1", "Sales", missing as never)).rejects.toMatchObject({
      code: "not_found"
    });
    const missingNull = mockDb({ pipelines: [{ data: null, error: null }] });
    await expect(
      renamePipeline("biz-1", "p1", "Sales", missingNull as never)
    ).rejects.toMatchObject({ code: "not_found" });
    const missingDel = mockDb({ pipelines: [{ data: null, error: null }] });
    await expect(deletePipeline("biz-1", "p1", missingDel as never)).rejects.toMatchObject({
      code: "not_found"
    });

    const badRename = mockDb({ pipelines: [{ data: null, error: { message: "r" } }] });
    await expect(renamePipeline("biz-1", "p1", "Sales", badRename as never)).rejects.toThrow(
      "renamePipeline: r"
    );
    const badDelete = mockDb({ pipelines: [{ data: null, error: { message: "d" } }] });
    await expect(deletePipeline("biz-1", "p1", badDelete as never)).rejects.toThrow(
      "deletePipeline: d"
    );
  });

  it("deletes and returns silently on success", async () => {
    const db = mockDb({ pipelines: [{ data: [{ id: "p1" }], error: null }] });
    await deletePipeline("biz-1", "p1", db as never);
    expect(db.chains.pipelines[0].delete).toHaveBeenCalled();
  });
});

describe("addStage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends after the last position and clamps the color", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: [S1, S2], error: null }, // siblings
        { data: { ...S1, id: "s3", name: "Won", color: "green", position: 2 }, error: null }
      ]
    });
    const stage = await addStage("biz-1", "p1", { name: " Won ", color: "green" }, db as never);
    expect(stage).toMatchObject({ id: "s3", name: "Won", position: 2 });
    expect(db.chains.pipeline_stages[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Won", color: "green", position: 2 })
    );
  });

  it("starts at position 0 on an empty pipeline and creates a client when needed", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: [], error: null },
        { data: { ...S1, id: "s9", position: 0 }, error: null }
      ]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const stage = await addStage("biz-1", "p1", { name: "First" });
    expect(stage.position).toBe(0);
    expect(db.chains.pipeline_stages[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0, color: "teal" })
    );
  });

  it("rejects the stage cap, duplicates, invalid names, and query errors", async () => {
    const full = mockDb({
      pipeline_stages: [
        {
          data: Array.from({ length: MAX_STAGES_PER_PIPELINE }, (_, i) => ({
            ...S1,
            id: `s${i}`,
            name: `Stage ${i}`,
            position: i
          })),
          error: null
        }
      ]
    });
    await expect(addStage("biz-1", "p1", { name: "One more" }, full as never)).rejects.toThrow(
      `at most ${MAX_STAGES_PER_PIPELINE} stages`
    );

    const dup = mockDb({ pipeline_stages: [{ data: [S1], error: null }] });
    await expect(addStage("biz-1", "p1", { name: "new lead" }, dup as never)).rejects.toThrow(
      'A stage named "new lead" already exists.'
    );

    const invalid = mockDb({});
    await expect(addStage("biz-1", "p1", { name: "  " }, invalid as never)).rejects.toThrow(
      "Stage names"
    );
    await expect(
      addStage("biz-1", "p1", { name: "x".repeat(41) }, invalid as never)
    ).rejects.toThrow("Stage names");

    const badSiblings = mockDb({
      pipeline_stages: [{ data: null, error: { message: "sib" } }]
    });
    await expect(addStage("biz-1", "p1", { name: "A" }, badSiblings as never)).rejects.toThrow(
      "pipeline stages: sib"
    );

    const badInsert = mockDb({
      pipeline_stages: [
        { data: [], error: null },
        { data: null, error: { message: "ins" } }
      ]
    });
    await expect(addStage("biz-1", "p1", { name: "A" }, badInsert as never)).rejects.toThrow(
      "addStage: ins"
    );

    const noRow = mockDb({
      pipeline_stages: [
        { data: [], error: null },
        { data: null, error: null }
      ]
    });
    await expect(addStage("biz-1", "p1", { name: "A" }, noRow as never)).rejects.toThrow(
      "addStage: insert returned no row"
    );
  });

  it("tolerates null sibling rows", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: null, error: null },
        { data: { ...S1, id: "s9", position: 0 }, error: null }
      ]
    });
    const stage = await addStage("biz-1", "p1", { name: "First" }, db as never);
    expect(stage.position).toBe(0);
  });
});

describe("updateStage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recolors without touching contacts", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null }, // getStage
        { data: { ...S1, color: "rose" }, error: null } // update
      ]
    });
    const { stage, retagged } = await updateStage(
      "biz-1",
      "s1",
      { color: "rose" },
      db as never
    );
    expect(stage.color).toBe("rose");
    expect(retagged).toBe(0);
    expect(db.from.mock.calls.map((c) => c[0])).toEqual(["pipeline_stages", "pipeline_stages"]);
  });

  it("keeps an unchanged name write-only (no sibling check, no retag)", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: S1, error: null }
      ]
    });
    const { retagged } = await updateStage("biz-1", "s1", { name: "New Lead" }, db as never);
    expect(retagged).toBe(0);
  });

  it("a case-only respell updates the stored name but does not retag", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null }, // getStage
        { data: [S1, S2], error: null }, // siblings
        { data: { ...S1, name: "NEW LEAD" }, error: null } // update
      ]
    });
    const { stage, retagged } = await updateStage(
      "biz-1",
      "s1",
      { name: "NEW LEAD" },
      db as never
    );
    expect(stage.name).toBe("NEW LEAD");
    expect(retagged).toBe(0);
  });

  it("a real rename retags contacts carrying the old tag (case-insensitive)", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null }, // getStage
        { data: [S1, S2], error: null }, // siblings
        { data: { ...S1, name: "Fresh Lead" }, error: null } // update
      ],
      contacts: [
        {
          data: [
            { id: "c1", tags: ["new lead", "VIP"] },
            { id: "c2", tags: ["Contacted"] }, // untouched
            { id: "c3", tags: null } // tolerated
          ],
          error: null
        },
        { data: null, error: null } // c1 update
      ]
    });
    const { stage, retagged } = await updateStage(
      "biz-1",
      "s1",
      { name: "Fresh Lead" },
      db as never
    );
    expect(stage.name).toBe("Fresh Lead");
    expect(retagged).toBe(1);
    expect(db.chains.contacts[0].limit).toHaveBeenCalledWith(RETAG_SCAN_LIMIT);
    expect(db.chains.contacts[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["VIP", "Fresh Lead"] })
    );
  });

  it("rejects renaming onto an existing sibling and surfaces errors", async () => {
    const dup = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: [S1, S2], error: null }
      ]
    });
    await expect(
      updateStage("biz-1", "s1", { name: "contacted" }, dup as never)
    ).rejects.toThrow('A stage named "contacted" already exists.');

    const missing = mockDb({ pipeline_stages: [{ data: null, error: null }] });
    await expect(updateStage("biz-1", "s1", {}, missing as never)).rejects.toMatchObject({
      code: "not_found"
    });

    const badRead = mockDb({ pipeline_stages: [{ data: null, error: { message: "read" } }] });
    await expect(updateStage("biz-1", "s1", {}, badRead as never)).rejects.toThrow(
      "pipeline stage: read"
    );

    const badWrite = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: null, error: { message: "write" } }
      ]
    });
    await expect(
      updateStage("biz-1", "s1", { color: "rose" }, badWrite as never)
    ).rejects.toThrow("updateStage: write");

    const noRow = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: null, error: null }
      ]
    });
    await expect(updateStage("biz-1", "s1", { color: "rose" }, noRow as never)).rejects.toThrow(
      "updateStage: update returned no row"
    );

    const invalid = mockDb({ pipeline_stages: [{ data: S1, error: null }] });
    await expect(updateStage("biz-1", "s1", { name: " " }, invalid as never)).rejects.toThrow(
      "Stage names"
    );
  });

  it("treats a null retag scan as no tagged contacts", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: [S1], error: null },
        { data: { ...S1, name: "Fresh" }, error: null }
      ],
      contacts: [{ data: null, error: null }]
    });
    const { retagged } = await updateStage("biz-1", "s1", { name: "Fresh" }, db as never);
    expect(retagged).toBe(0);
  });

  it("surfaces retag read/write failures", async () => {
    const badScan = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: [S1], error: null },
        { data: { ...S1, name: "Fresh" }, error: null }
      ],
      contacts: [{ data: null, error: { message: "scan" } }]
    });
    await expect(
      updateStage("biz-1", "s1", { name: "Fresh" }, badScan as never)
    ).rejects.toThrow("retagContacts: scan");

    const badUpdate = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: [S1], error: null },
        { data: { ...S1, name: "Fresh" }, error: null }
      ],
      contacts: [
        { data: [{ id: "c1", tags: ["New Lead"] }], error: null },
        { data: null, error: { message: "upd" } }
      ]
    });
    await expect(
      updateStage("biz-1", "s1", { name: "Fresh" }, badUpdate as never)
    ).rejects.toThrow("retagContacts: update: upd");
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: S1, error: null }
      ]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateStage("biz-1", "s1", {});
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("reorderStages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes 0-based positions in the given order", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: [S1, S2], error: null }, // getStages
        { data: null, error: null } // updates (repeat)
      ]
    });
    await reorderStages("biz-1", "p1", ["s2", "s1"], db as never);
    expect(db.chains.pipeline_stages[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0 })
    );
    expect(db.chains.pipeline_stages[1].eq).toHaveBeenCalledWith("id", "s2");
    expect(db.chains.pipeline_stages[2].update).toHaveBeenCalledWith(
      expect.objectContaining({ position: 1 })
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: [S1], error: null },
        { data: null, error: null }
      ]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await reorderStages("biz-1", "p1", ["s1"]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("rejects anything that is not an exact permutation, and surfaces write errors", async () => {
    const twoStages = () =>
      mockDb({ pipeline_stages: [{ data: [S1, S2], error: null }] });
    await expect(reorderStages("biz-1", "p1", ["s1"], twoStages() as never)).rejects.toThrow(
      "exactly once"
    );
    await expect(
      reorderStages("biz-1", "p1", ["s1", "s9"], twoStages() as never)
    ).rejects.toThrow("exactly once");
    await expect(
      reorderStages("biz-1", "p1", ["s1", "s1"], twoStages() as never)
    ).rejects.toThrow("exactly once");

    const badWrite = mockDb({
      pipeline_stages: [
        { data: [S1], error: null },
        { data: null, error: { message: "w" } }
      ]
    });
    await expect(reorderStages("biz-1", "p1", ["s1"], badWrite as never)).rejects.toThrow(
      "reorderStages: w"
    );
  });
});

describe("deleteStage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes without retagging when no destination is given", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null }, // getStage
        { data: null, error: null } // delete
      ]
    });
    const { retagged } = await deleteStage("biz-1", "s1", null, db as never);
    expect(retagged).toBe(0);
    expect(db.from.mock.calls.map((c) => c[0])).toEqual([
      "pipeline_stages",
      "pipeline_stages"
    ]);
  });

  it("moves the stage's contacts to the destination stage", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null }, // getStage (deleted)
        { data: S2, error: null }, // getStage (destination)
        { data: null, error: null } // delete
      ],
      contacts: [
        {
          data: [
            { id: "c1", tags: ["New Lead"] },
            { id: "c2", tags: ["New Lead", "Contacted"] }
          ],
          error: null
        },
        { data: null, error: null }
      ]
    });
    const { retagged } = await deleteStage("biz-1", "s1", "s2", db as never);
    expect(retagged).toBe(2);
    // c1: swap. c2: already had the destination tag; de-dup keeps one copy.
    expect(db.chains.contacts[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["Contacted"] })
    );
    expect(db.chains.contacts[2].update).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["Contacted"] })
    );
  });

  it("rejects self/cross-pipeline destinations and surfaces delete errors", async () => {
    const self = mockDb({ pipeline_stages: [{ data: S1, error: null }] });
    await expect(deleteStage("biz-1", "s1", "s1", self as never)).rejects.toThrow(
      "different stage"
    );

    const cross = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: { ...S2, pipeline_id: "p9" }, error: null }
      ]
    });
    await expect(deleteStage("biz-1", "s1", "s2", cross as never)).rejects.toThrow(
      "same pipeline"
    );

    const badDelete = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: null, error: { message: "del" } }
      ]
    });
    await expect(deleteStage("biz-1", "s1", null, badDelete as never)).rejects.toThrow(
      "deleteStage: del"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb({
      pipeline_stages: [
        { data: S1, error: null },
        { data: null, error: null }
      ]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteStage("biz-1", "s1", null);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
