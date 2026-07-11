import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_FLOW_NAME_MAX,
  CANCELABLE_RUN_STATUSES,
  cancelAiFlowRun,
  createAiFlow,
  decideAiFlowApproval,
  deleteAiFlow,
  enqueueAiFlowRun,
  getAiFlow,
  getAiFlowRun,
  listAiFlowRunSteps,
  listAiFlowRuns,
  listAiFlows,
  updateAiFlow
} from "@/lib/ai-flows/db";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const VALID_DEF = {
  version: 1,
  trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
  steps: [
    { id: "s1", type: "extract_url", saveAs: "lead_url" },
    { id: "s2", type: "notify_owner", message: "got {{trigger.url}}" }
  ]
};

const FLOW_ROW = {
  id: "flow-1",
  business_id: "biz-1",
  name: "ReferralExchange",
  enabled: true,
  definition: VALID_DEF,
  created_by: null,
  created_at: "2026-06-08T00:00:00Z",
  updated_at: "2026-06-08T00:00:00Z"
};

const RUN_ROW = {
  id: "run-1",
  flow_id: "flow-1",
  business_id: "biz-1",
  status: "awaiting_approval",
  context: { trigger: { url: "https://x" } },
  current_step: 1,
  attempt_count: 1,
  last_error: null,
  claimed_at: null,
  dedupe_key: "evt-1",
  created_at: "2026-06-08T00:00:00Z",
  updated_at: "2026-06-08T00:00:00Z"
};

const STEP_ROW = {
  id: "step-1",
  run_id: "run-1",
  business_id: "biz-1",
  step_index: 0,
  step_type: "extract_url",
  status: "done",
  result: { vars: { lead_url: "https://x" } },
  error: null,
  created_at: "2026-06-08T00:00:00Z",
  updated_at: "2026-06-08T00:00:00Z"
};

type StubErr = { message: string } | null;
type StubOpts = {
  array?: unknown;
  maybe?: unknown;
  single?: unknown;
  error?: StubErr;
  singleError?: StubErr;
  // Storage.createSignedUrls stub for the run-step screenshot signer.
  signed?: unknown;
  signedError?: StubErr;
  // Rows for the ai_flow_runs lookup inside listAiFlows (last-run sort). When
  // present, `from("ai_flow_runs")` resolves these instead of `array`.
  runs?: unknown;
};

function makeBuilder(opts: StubOpts) {
   
  const b: any = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "is", "ilike", "in", "order", "limit"]) {
    b[m] = vi.fn(() => b);
  }
  b.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: opts.maybe ?? null, error: opts.error ?? null })
  );
  b.single = vi.fn(() =>
    Promise.resolve({ data: opts.single ?? null, error: opts.singleError ?? opts.error ?? null })
  );
   
  b.then = (resolve: any, reject: any) =>
    Promise.resolve({
      data: "array" in opts ? opts.array : [],
      error: opts.error ?? null
    }).then(resolve, reject);
  return b;
}

function makeDb(opts: StubOpts) {
  const b = makeBuilder(opts);
  // Separate builder for the ai_flow_runs last-run lookup so listAiFlows can
  // fetch flows AND runs from the same db stub without conflating their rows.
  const runsBuilder = makeBuilder({ array: opts.runs });
  const createSignedUrls = vi.fn(() =>
    Promise.resolve({ data: opts.signed ?? null, error: opts.signedError ?? null })
  );
  return {
    builder: b,
    runsBuilder,
    createSignedUrls,
    db: {
      from: vi.fn((table?: string) =>
        table === "ai_flow_runs" && "runs" in opts ? runsBuilder : b
      ),
      storage: { from: vi.fn(() => ({ createSignedUrls })) }
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDb fallback", () => {
  it("creates a service client when none is passed", async () => {
    const { db } = makeDb({ array: [FLOW_ROW], runs: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
       
      db as any
    );
    expect(await listAiFlows("biz-1")).toEqual([{ ...FLOW_ROW, last_run_at: null }]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listAiFlows", () => {
  it("attaches last_run_at from the newest run per flow", async () => {
    const { db } = makeDb({
      array: [FLOW_ROW],
      // Newest-first, as the query orders them; first-seen per flow wins.
      runs: [
        { flow_id: "flow-1", created_at: "2026-06-10T00:00:00Z" },
        { flow_id: "flow-1", created_at: "2026-06-09T00:00:00Z" }
      ]
    });
     
    expect(await listAiFlows("biz-1", db as any)).toEqual([
      { ...FLOW_ROW, last_run_at: "2026-06-10T00:00:00Z" }
    ]);
  });
  it("sorts most-recently-run first and puts never-run flows last", async () => {
    const flowA = { ...FLOW_ROW, id: "flow-a", name: "A" };
    const flowB = { ...FLOW_ROW, id: "flow-b", name: "B" };
    const flowC = { ...FLOW_ROW, id: "flow-c", name: "C (never run)" };
    const { db } = makeDb({
      array: [flowA, flowB, flowC],
      runs: [
        { flow_id: "flow-b", created_at: "2026-06-12T00:00:00Z" },
        { flow_id: "flow-a", created_at: "2026-06-11T00:00:00Z" }
      ]
    });
     
    const out = await listAiFlows("biz-1", db as any);
    expect(out.map((f) => f.id)).toEqual(["flow-b", "flow-a", "flow-c"]);
    expect(out[2].last_run_at).toBeNull();
  });
  it("orders an out-of-order pair (later array element ran more recently)", async () => {
    // Input is already created_at-desc; here the SECOND flow ran more recently,
    // exercising the a<b and a-has-run/b-null comparator branches.
    const older = { ...FLOW_ROW, id: "older", name: "older run" };
    const newer = { ...FLOW_ROW, id: "newer", name: "newer run" };
    const never = { ...FLOW_ROW, id: "never", name: "never run" };
    const { db } = makeDb({
      array: [never, newer, older],
      runs: [
        { flow_id: "newer", created_at: "2026-06-12T00:00:00Z" },
        { flow_id: "older", created_at: "2026-06-11T00:00:00Z" }
      ]
    });
     
    const out = await listAiFlows("biz-1", db as any);
    expect(out.map((f) => f.id)).toEqual(["newer", "older", "never"]);
  });
  it("treats a null ai_flow_runs payload as no runs (all flows never-run)", async () => {
    const { db } = makeDb({ array: [FLOW_ROW], runs: null });
     
    expect(await listAiFlows("biz-1", db as any)).toEqual([
      { ...FLOW_ROW, last_run_at: null }
    ]);
  });
  it("keeps stable order for equal last-run times and for multiple never-run flows", async () => {
    const f1 = { ...FLOW_ROW, id: "f1", name: "F1" };
    const f2 = { ...FLOW_ROW, id: "f2", name: "F2" };
    const f3 = { ...FLOW_ROW, id: "f3", name: "F3" };
    const f4 = { ...FLOW_ROW, id: "f4", name: "F4" };
    const { db } = makeDb({
      array: [f1, f2, f3, f4],
      // f1 and f2 share a timestamp (tie); f3 and f4 never ran (both null).
      runs: [
        { flow_id: "f1", created_at: "2026-06-12T00:00:00Z" },
        { flow_id: "f2", created_at: "2026-06-12T00:00:00Z" }
      ]
    });
     
    const out = await listAiFlows("biz-1", db as any);
    expect(out.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });
  it("defaults to empty when data is null", async () => {
    const { db } = makeDb({ array: null, runs: [] });
     
    expect(await listAiFlows("biz-1", db as any)).toEqual([]);
  });
  it("throws on error", async () => {
    const { db } = makeDb({ array: null, error: { message: "boom" } });
     
    await expect(listAiFlows("biz-1", db as any)).rejects.toThrow("listAiFlows: boom");
  });
});

describe("getAiFlow", () => {
  it("returns a row", async () => {
    const { db } = makeDb({ maybe: FLOW_ROW });
     
    expect(await getAiFlow("biz-1", "flow-1", db as any)).toEqual(FLOW_ROW);
  });
  it("returns null when missing", async () => {
    const { db } = makeDb({ maybe: null });
     
    expect(await getAiFlow("biz-1", "x", db as any)).toBeNull();
  });
  it("throws on error", async () => {
    const { db } = makeDb({ maybe: null, error: { message: "bad" } });
     
    await expect(getAiFlow("biz-1", "x", db as any)).rejects.toThrow("getAiFlow: bad");
  });
});

describe("createAiFlow", () => {
  it("inserts with defaults", async () => {
    const { db, builder } = makeDb({ single: FLOW_ROW });
    const row = await createAiFlow(
      { businessId: "biz-1", name: "  ReferralExchange  ", definition: VALID_DEF },
       
      db as any
    );
    expect(row).toEqual(FLOW_ROW);
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ReferralExchange", enabled: true, created_by: null })
    );
  });
  it("honors an explicit enabled:false (e.g. the duplicate path)", async () => {
    const { db, builder } = makeDb({ single: FLOW_ROW });
    await createAiFlow(
      { businessId: "biz-1", name: "x", enabled: false, definition: VALID_DEF },
      db as any
    );
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it("honors enabled + createdBy", async () => {
    const { db, builder } = makeDb({ single: FLOW_ROW });
    await createAiFlow(
      { businessId: "biz-1", name: "x", enabled: true, createdBy: "user-1", definition: VALID_DEF },
       
      db as any
    );
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, created_by: "user-1" })
    );
  });
  it("rejects an empty name", async () => {
    const { db } = makeDb({ single: FLOW_ROW });
    await expect(
       
      createAiFlow({ businessId: "biz-1", name: "   ", definition: VALID_DEF }, db as any)
    ).rejects.toThrow(/name must be/);
  });
  it("rejects an over-long name", async () => {
    const { db } = makeDb({ single: FLOW_ROW });
    await expect(
      createAiFlow(
        { businessId: "biz-1", name: "a".repeat(AI_FLOW_NAME_MAX + 1), definition: VALID_DEF },
         
        db as any
      )
    ).rejects.toThrow(/name must be/);
  });
  it("rejects an invalid definition", async () => {
    const { db } = makeDb({ single: FLOW_ROW });
    await expect(
       
      createAiFlow({ businessId: "biz-1", name: "x", definition: { version: 2 } }, db as any)
    ).rejects.toThrow(/Invalid AiFlow definition/);
  });
  it("throws on db error", async () => {
    const { db } = makeDb({ single: null, error: { message: "dup" } });
    await expect(
       
      createAiFlow({ businessId: "biz-1", name: "x", definition: VALID_DEF }, db as any)
    ).rejects.toThrow("createAiFlow: dup");
  });
});

describe("updateAiFlow", () => {
  it("updates name/enabled/definition", async () => {
    const { db, builder } = makeDb({ single: FLOW_ROW });
    await updateAiFlow(
      { businessId: "biz-1", id: "flow-1", name: "New", enabled: false, definition: VALID_DEF },
       
      db as any
    );
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New", enabled: false })
    );
  });
  it("throws when nothing to update", async () => {
    const { db } = makeDb({ single: FLOW_ROW });
    await expect(
       
      updateAiFlow({ businessId: "biz-1", id: "flow-1" }, db as any)
    ).rejects.toThrow("nothing to update");
  });
  it("throws on db error", async () => {
    const { db } = makeDb({ single: null, error: { message: "nope" } });
    await expect(
       
      updateAiFlow({ businessId: "biz-1", id: "flow-1", enabled: true }, db as any)
    ).rejects.toThrow("updateAiFlow: nope");
  });
});

describe("deleteAiFlow", () => {
  it("deletes", async () => {
    const { db } = makeDb({ array: null });
     
    await expect(deleteAiFlow("biz-1", "flow-1", db as any)).resolves.toBeUndefined();
  });
  it("throws on error", async () => {
    const { db } = makeDb({ array: null, error: { message: "x" } });
     
    await expect(deleteAiFlow("biz-1", "flow-1", db as any)).rejects.toThrow("deleteAiFlow: x");
  });
});

describe("enqueueAiFlowRun", () => {
  const input = {
    businessId: "biz-1",
    flowId: "flow-1",
    trigger: { channel: "manual", windowText: "", url: null, from: "owner@x.com" },
    dedupeKey: "manual:abc"
  };

  it("inserts a queued run and returns the row", async () => {
    const { db, builder } = makeDb({ single: RUN_ROW });
    expect(await enqueueAiFlowRun(input, db as never)).toEqual(RUN_ROW);
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        flow_id: "flow-1",
        business_id: "biz-1",
        status: "queued",
        context: { trigger: input.trigger },
        current_step: 0,
        dedupe_key: "manual:abc"
      })
    );
  });

  it("defaults a missing dedupeKey to null", async () => {
    const { db, builder } = makeDb({ single: RUN_ROW });
    await enqueueAiFlowRun({ ...input, dedupeKey: undefined }, db as never);
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: null })
    );
  });

  it("passes earliestClaimAt through as earliest_claim_at (drip release)", async () => {
    const { db, builder } = makeDb({ single: RUN_ROW });
    const at = "2026-07-10T21:00:00.000Z";
    await enqueueAiFlowRun({ ...input, earliestClaimAt: at }, db as never);
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ earliest_claim_at: at })
    );
  });

  it("omits earliest_claim_at when not provided, so the run is claimable immediately", async () => {
    const { db, builder } = makeDb({ single: RUN_ROW });
    await enqueueAiFlowRun(input, db as never);
    expect(builder.insert.mock.calls[0][0]).not.toHaveProperty("earliest_claim_at");
  });

  it("returns null on a dedupe collision (23505)", async () => {
    const { db } = makeDb({ singleError: { message: "dup", code: "23505" } as never });
    expect(await enqueueAiFlowRun(input, db as never)).toBeNull();
  });

  it("throws on any other insert error", async () => {
    const { db } = makeDb({ singleError: { message: "boom" } });
    await expect(enqueueAiFlowRun(input, db as never)).rejects.toThrow(
      "enqueueAiFlowRun: boom"
    );
  });
});

describe("enqueueAiFlowRun drip pacing", () => {
  const input = {
    businessId: "biz-1",
    flowId: "flow-1",
    trigger: { channel: "webhook", windowText: "lead", url: null, from: "meta" },
    dedupeKey: "webhook:e1"
  };

  /**
   * Per-table stub: ai_flows resolves the definition read, the ai_flow_runs
   * SELECT (drip last-slot lookup) resolves `lastRow`, and the ai_flow_runs
   * INSERT resolves RUN_ROW. `.not` is only used by the drip lookup.
   */
  function makeDripDb(opts: {
    drip?: { intervalMinutes: number } | null;
    lastRow?: { earliest_claim_at: string | null } | null;
    flowReadThrows?: boolean;
  }) {
    const inserts: Record<string, unknown>[] = [];
    const flowsBuilder: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) flowsBuilder[m] = vi.fn(() => flowsBuilder);
    flowsBuilder.maybeSingle = vi.fn(async () => {
      if (opts.flowReadThrows) throw new Error("flows read down");
      return {
        data: { definition: { drip: opts.drip ?? undefined } },
        error: null
      };
    });
    const runsBuilder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit"]) {
      runsBuilder[m] = vi.fn(() => runsBuilder);
    }
    runsBuilder.maybeSingle = vi.fn(async () => ({ data: opts.lastRow ?? null, error: null }));
    runsBuilder.insert = vi.fn((row: Record<string, unknown>) => {
      inserts.push(row);
      return {
        select: () => ({ single: async () => ({ data: RUN_ROW, error: null }) })
      };
    });
    return {
      inserts,
      db: {
        from: vi.fn((table: string) => (table === "ai_flows" ? flowsBuilder : runsBuilder))
      }
    };
  }

  it("staggers a dripped flow's run after the latest scheduled slot", async () => {
    const lastIso = new Date(Date.now() + 10 * 60_000).toISOString();
    const { db, inserts } = makeDripDb({
      drip: { intervalMinutes: 5 },
      lastRow: { earliest_claim_at: lastIso }
    });
    await enqueueAiFlowRun(input, db as never);
    const claimAt = Date.parse(inserts[0].earliest_claim_at as string);
    expect(claimAt).toBe(Date.parse(lastIso) + 5 * 60_000);
  });

  it("the first dripped run starts now (no scheduled predecessor)", async () => {
    const before = Date.now();
    const { db, inserts } = makeDripDb({ drip: { intervalMinutes: 5 }, lastRow: null });
    await enqueueAiFlowRun(input, db as never);
    const claimAt = Date.parse(inserts[0].earliest_claim_at as string);
    expect(claimAt).toBeGreaterThanOrEqual(before);
    expect(claimAt).toBeLessThanOrEqual(Date.now());
  });

  it("a predecessor already in the past never schedules backwards", async () => {
    const before = Date.now();
    const { db, inserts } = makeDripDb({
      drip: { intervalMinutes: 5 },
      lastRow: { earliest_claim_at: new Date(before - 60 * 60_000).toISOString() }
    });
    await enqueueAiFlowRun(input, db as never);
    expect(Date.parse(inserts[0].earliest_claim_at as string)).toBeGreaterThanOrEqual(before);
  });

  it("no drip configured → no stagger (and no earliest_claim_at)", async () => {
    const { db, inserts } = makeDripDb({ drip: null });
    await enqueueAiFlowRun(input, db as never);
    expect(inserts[0]).not.toHaveProperty("earliest_claim_at");
  });

  it("an explicit earliestClaimAt wins over drip (the caller computed its own spacing)", async () => {
    const at = "2026-07-11T09:00:00.000Z";
    const { db, inserts } = makeDripDb({ drip: { intervalMinutes: 5 } });
    await enqueueAiFlowRun({ ...input, earliestClaimAt: at }, db as never);
    expect(inserts[0].earliest_claim_at).toBe(at);
  });

  it("a drip read failure enqueues immediately (pacing is best-effort)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, inserts } = makeDripDb({ flowReadThrows: true });
    await enqueueAiFlowRun(input, db as never);
    expect(inserts[0]).not.toHaveProperty("earliest_claim_at");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("listAiFlowRuns", () => {
  it("applies flowId + status filters and clamps a large limit", async () => {
    const { db, builder } = makeDb({ array: [RUN_ROW] });
    const rows = await listAiFlowRuns(
      "biz-1",
      { flowId: "flow-1", status: "awaiting_approval", limit: 9999 },
       
      db as any
    );
    expect(rows).toEqual([RUN_ROW]);
    expect(builder.eq).toHaveBeenCalledWith("flow_id", "flow-1");
    expect(builder.eq).toHaveBeenCalledWith("status", "awaiting_approval");
    expect(builder.limit).toHaveBeenCalledWith(200);
  });
  it("uses defaults with no options", async () => {
    const { db, builder } = makeDb({ array: null });
     
    expect(await listAiFlowRuns("biz-1", undefined, db as any)).toEqual([]);
    expect(builder.limit).toHaveBeenCalledWith(50);
  });
  it("throws on error", async () => {
    const { db } = makeDb({ array: null, error: { message: "r" } });
     
    await expect(listAiFlowRuns("biz-1", {}, db as any)).rejects.toThrow("listAiFlowRuns: r");
  });
});

describe("getAiFlowRun", () => {
  it("returns a run", async () => {
    const { db } = makeDb({ maybe: RUN_ROW });
     
    expect(await getAiFlowRun("biz-1", "run-1", db as any)).toEqual(RUN_ROW);
  });
  it("returns null when missing", async () => {
    const { db } = makeDb({ maybe: null });
     
    expect(await getAiFlowRun("biz-1", "x", db as any)).toBeNull();
  });
  it("throws on error", async () => {
    const { db } = makeDb({ maybe: null, error: { message: "e" } });
     
    await expect(getAiFlowRun("biz-1", "x", db as any)).rejects.toThrow("getAiFlowRun: e");
  });
});

describe("listAiFlowRunSteps", () => {
  it("returns steps", async () => {
    const { db } = makeDb({ array: [STEP_ROW] });
     
    expect(await listAiFlowRunSteps("biz-1", "run-1", db as any)).toEqual([STEP_ROW]);
  });
  it("defaults to empty when null", async () => {
    const { db } = makeDb({ array: null });
     
    expect(await listAiFlowRunSteps("biz-1", "run-1", db as any)).toEqual([]);
  });
  it("throws on error", async () => {
    const { db } = makeDb({ array: null, error: { message: "s" } });
     
    await expect(listAiFlowRunSteps("biz-1", "run-1", db as any)).rejects.toThrow(
      "listAiFlowRunSteps: s"
    );
  });
});

describe("listAiFlowRunSteps screenshot signing", () => {
  const STEP_NULL = { ...STEP_ROW, id: "s0", step_index: 0, result: null };
  // A failed browse_action with both screenshots AND both paired page sources.
  const STEP_BOTH = {
    ...STEP_ROW,
    id: "s1",
    step_index: 1,
    step_type: "browse_action",
    status: "failed",
    result: {
      screenshot_path: "biz-1/run-1/s1.jpg",
      screenshot_before_path: "biz-1/run-1/s1-before.jpg",
      source_path: "biz-1/run-1/s1.html",
      source_before_path: "biz-1/run-1/s1-before.html"
    },
    error: "browse_action: action_failed"
  };
  const STEP_MAIN_ONLY = {
    ...STEP_ROW,
    id: "s2",
    step_index: 2,
    step_type: "browse_action",
    result: { screenshot_path: "biz-1/run-1/s2.jpg" }
  };

  it("signs and attaches screenshot + source URLs (before + failure), leaving path-less steps untouched", async () => {
    const { db, createSignedUrls } = makeDb({
      array: [STEP_NULL, STEP_BOTH, STEP_MAIN_ONLY],
      signed: [
        { path: "biz-1/run-1/s1.jpg", signedUrl: "https://signed/s1" },
        { path: "biz-1/run-1/s1-before.jpg", signedUrl: "https://signed/s1-before" },
        { path: "biz-1/run-1/s1.html", signedUrl: "https://signed/s1-src" },
        { path: "biz-1/run-1/s1-before.html", signedUrl: "https://signed/s1-before-src" },
        { path: "biz-1/run-1/s2.jpg", signedUrl: "https://signed/s2" }
      ]
    });

    const out = await listAiFlowRunSteps("biz-1", "run-1", db as any);
    expect(createSignedUrls).toHaveBeenCalledWith(
      [
        "biz-1/run-1/s1.jpg",
        "biz-1/run-1/s1-before.jpg",
        "biz-1/run-1/s1.html",
        "biz-1/run-1/s1-before.html",
        "biz-1/run-1/s2.jpg"
      ],
      600
    );
    expect(out[0].screenshot_url).toBeUndefined();
    expect(out[0].source_url).toBeUndefined();
    expect(out[1].screenshot_url).toBe("https://signed/s1");
    expect(out[1].screenshot_before_url).toBe("https://signed/s1-before");
    expect(out[1].source_url).toBe("https://signed/s1-src");
    expect(out[1].source_before_url).toBe("https://signed/s1-before-src");
    // A step with only a main screenshot keeps the source/before URLs undefined.
    expect(out[2].screenshot_url).toBe("https://signed/s2");
    expect(out[2].screenshot_before_url).toBeUndefined();
    expect(out[2].source_url).toBeUndefined();
    expect(out[2].source_before_url).toBeUndefined();
  });

  it("skips entries missing a path or signedUrl; signs only the before shot when the main fails", async () => {
    const { db } = makeDb({
      array: [STEP_BOTH],
      // Main entry has no signedUrl and an orphan entry has no path (both
      // skipped); only the before shot signs → step keeps just the before URL.
      signed: [
        { path: "biz-1/run-1/s1.jpg", signedUrl: null },
        { path: null, signedUrl: "https://orphan" },
        { path: "biz-1/run-1/s1-before.jpg", signedUrl: "https://signed/before-only" }
      ]
    });

    const out = await listAiFlowRunSteps("biz-1", "run-1", db as any);
    expect(out[0].screenshot_url).toBeUndefined();
    expect(out[0].screenshot_before_url).toBe("https://signed/before-only");
    // Sources weren't in the signed payload → their URLs stay undefined.
    expect(out[0].source_url).toBeUndefined();
    expect(out[0].source_before_url).toBeUndefined();
  });

  it("leaves URLs off when the signing call errors", async () => {
    const { db } = makeDb({ array: [STEP_BOTH], signedError: { message: "denied" } });

    const out = await listAiFlowRunSteps("biz-1", "run-1", db as any);
    expect(out[0].screenshot_url).toBeUndefined();
    expect(out[0].source_url).toBeUndefined();
  });

  it("tolerates a null signing payload", async () => {
    const { db } = makeDb({ array: [STEP_MAIN_ONLY] });

    const out = await listAiFlowRunSteps("biz-1", "run-1", db as any);
    expect(out[0].screenshot_url).toBeUndefined();
  });

  it("skips signing entirely when no step has a stored path", async () => {
    const { db, createSignedUrls } = makeDb({ array: [STEP_NULL, STEP_ROW] });

    const out = await listAiFlowRunSteps("biz-1", "run-1", db as any);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(out).toEqual([STEP_NULL, STEP_ROW]);
  });
});

describe("decideAiFlowApproval", () => {
  it("approves: flips to queued and records the decision", async () => {
    const { db, builder } = makeDb({ maybe: RUN_ROW, single: { ...RUN_ROW, status: "queued" } });
    const out = await decideAiFlowApproval(
      { businessId: "biz-1", runId: "run-1", decision: "approve", decidedBy: "user-1", note: "ok" },
       
      db as any
    );
    expect(out.status).toBe("queued");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued" })
    );
  });
  it("skips: re-queues the run with the skip decision recorded (worker skips the gated step)", async () => {
    const { db, builder } = makeDb({ maybe: RUN_ROW, single: { ...RUN_ROW, status: "queued" } });
    const out = await decideAiFlowApproval(
      { businessId: "biz-1", runId: "run-1", decision: "skip", decidedBy: "user-1" },
       
      db as any
    );
    expect(out.status).toBe("queued");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
        context: expect.objectContaining({
          approval: expect.objectContaining({ decision: "skip" })
        })
      })
    );
  });
  it("bypass_quiet_hours: re-queues the run with the bypass decision recorded", async () => {
    const { db, builder } = makeDb({ maybe: RUN_ROW, single: { ...RUN_ROW, status: "queued" } });
    const out = await decideAiFlowApproval(
      { businessId: "biz-1", runId: "run-1", decision: "bypass_quiet_hours", decidedBy: "user-1" },
       
      db as any
    );
    expect(out.status).toBe("queued");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
        context: expect.objectContaining({
          approval: expect.objectContaining({ decision: "bypass_quiet_hours" })
        })
      })
    );
  });
  it("denies: flips to canceled with null decidedBy/note defaults", async () => {
    const { db, builder } = makeDb({ maybe: RUN_ROW, single: { ...RUN_ROW, status: "canceled" } });
    const out = await decideAiFlowApproval(
      { businessId: "biz-1", runId: "run-1", decision: "deny" },
       
      db as any
    );
    expect(out.status).toBe("canceled");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "canceled" })
    );
  });
  it("throws when the run is missing", async () => {
    const { db } = makeDb({ maybe: null });
    await expect(
       
      decideAiFlowApproval({ businessId: "biz-1", runId: "x", decision: "approve" }, db as any)
    ).rejects.toThrow("run not found");
  });
  it("throws when the run is not awaiting approval", async () => {
    const { db } = makeDb({ maybe: { ...RUN_ROW, status: "done" } });
    await expect(
       
      decideAiFlowApproval({ businessId: "biz-1", runId: "run-1", decision: "approve" }, db as any)
    ).rejects.toThrow("not awaiting approval");
  });
  it("throws on update error", async () => {
    const { db } = makeDb({ maybe: RUN_ROW, single: null, singleError: { message: "u" } });
    await expect(
       
      decideAiFlowApproval({ businessId: "biz-1", runId: "run-1", decision: "approve" }, db as any)
    ).rejects.toThrow("decideAiFlowApproval: u");
  });
});

describe("cancelAiFlowRun", () => {
  it("stops every waiting state, recording who and from which state", async () => {
    for (const status of CANCELABLE_RUN_STATUSES) {
      const { db, builder } = makeDb({
        maybe: { ...RUN_ROW, status },
        single: { ...RUN_ROW, status: "canceled" }
      });
      const out = await cancelAiFlowRun(
        { businessId: "biz-1", runId: "run-1", canceledBy: "user-1" },
         
        db as any
      );
      expect(out.status).toBe("canceled");
      expect(builder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "canceled",
          claimed_at: null,
          context: expect.objectContaining({
            canceled: expect.objectContaining({ by: "user-1", from_status: status })
          })
        })
      );
      // The write is status-guarded so racing the worker's claim loses cleanly.
      expect(builder.in).toHaveBeenCalledWith("status", [...CANCELABLE_RUN_STATUSES]);
    }
  });
  it("defaults canceledBy to null", async () => {
    const { db, builder } = makeDb({
      maybe: RUN_ROW,
      single: { ...RUN_ROW, status: "canceled" }
    });
     
    await cancelAiFlowRun({ businessId: "biz-1", runId: "run-1" }, db as any);
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ canceled: expect.objectContaining({ by: null }) })
      })
    );
  });
  it("throws when the run is missing", async () => {
    const { db } = makeDb({ maybe: null });
    await expect(
       
      cancelAiFlowRun({ businessId: "biz-1", runId: "x" }, db as any)
    ).rejects.toThrow("run not found");
  });
  it("refuses terminal states", async () => {
    for (const status of ["done", "failed", "canceled"]) {
      const { db } = makeDb({ maybe: { ...RUN_ROW, status } });
      await expect(
         
        cancelAiFlowRun({ businessId: "biz-1", runId: "run-1" }, db as any)
      ).rejects.toThrow(`run is ${status} and cannot be stopped`);
    }
  });
  it("maps a lost race (guarded update matched nothing) to the stoppable error", async () => {
    // Pre-read said awaiting, but the worker claimed the run before the write:
    // PostgREST reports zero rows as PGRST116 on .single().
    const { db } = makeDb({
      maybe: RUN_ROW,
      single: null,
      singleError: { message: "0 rows", code: "PGRST116" } as never
    });
    await expect(
       
      cancelAiFlowRun({ businessId: "biz-1", runId: "run-1" }, db as any)
    ).rejects.toThrow("no longer waiting and cannot be stopped");
  });
  it("throws on update error", async () => {
    const { db } = makeDb({ maybe: RUN_ROW, single: null, singleError: { message: "u" } });
    await expect(
       
      cancelAiFlowRun({ businessId: "biz-1", runId: "run-1" }, db as any)
    ).rejects.toThrow("cancelAiFlowRun: u");
  });
});
