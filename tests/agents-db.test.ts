/**
 * DB access for business_agents / agent_runs (src/lib/agents/db.ts):
 * success + error paths for every helper, on both the injected-client and
 * default-client code paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  countBusinessAgents,
  deleteBusinessAgent,
  getAgentRun,
  getBusinessAgent,
  insertAgentRun,
  insertBusinessAgent,
  listAgentRunInputPaths,
  listAgentRuns,
  listBusinessAgents,
  patchAgentRun,
  patchBusinessAgent
} from "@/lib/agents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "not", "order", "limit"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn();
  c.maybeSingle = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listBusinessAgents", () => {
  it("returns rows (explicit client)", async () => {
    const c = chain({ data: [{ id: AGENT }], error: null });
    expect(await listBusinessAgents(BIZ, makeDb(c))).toEqual([{ id: AGENT }]);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("returns [] for a null payload and uses the default client", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listBusinessAgents(BIZ)).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listBusinessAgents(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });
});

describe("getBusinessAgent", () => {
  it("returns the row (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: AGENT }, error: null });
    expect(await getBusinessAgent(BIZ, AGENT, makeDb(c))).toEqual({ id: AGENT });
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getBusinessAgent(BIZ, AGENT)).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(getBusinessAgent(BIZ, AGENT, makeDb(c))).rejects.toThrow(/nope/);
  });
});

describe("countBusinessAgents", () => {
  it("returns the exact count (explicit client)", async () => {
    const c = chain({ count: 4, error: null });
    expect(await countBusinessAgents(BIZ, makeDb(c))).toBe(4);
  });

  it("returns 0 for a null count (default client)", async () => {
    const c = chain({ count: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await countBusinessAgents(BIZ)).toBe(0);
  });

  it("throws on error", async () => {
    const c = chain({ count: null, error: { message: "count fail" } });
    await expect(countBusinessAgents(BIZ, makeDb(c))).rejects.toThrow(/count fail/);
  });
});

describe("insertBusinessAgent", () => {
  const row = {
    business_id: BIZ,
    name: "Intake Summarizer",
    instructions: "Summarize.",
    output_format: "markdown" as const
  };

  it("returns the inserted row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: AGENT, ...row }, error: null });
    expect(await insertBusinessAgent(row, makeDb(c))).toMatchObject({ id: AGENT });
    expect(c.insert).toHaveBeenCalledWith(row);
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertBusinessAgent(row)).rejects.toThrow(/insert fail/);
  });
});

describe("patchBusinessAgent", () => {
  it("stamps updated_at (explicit client)", async () => {
    const c = chain({ error: null });
    await patchBusinessAgent(BIZ, AGENT, { name: "New" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New", updated_at: expect.any(String) })
    );
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "patch fail" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(patchBusinessAgent(BIZ, AGENT, { enabled: false })).rejects.toThrow(/patch fail/);
  });
});

describe("deleteBusinessAgent", () => {
  it("scopes the delete to the business (explicit client)", async () => {
    const c = chain({ error: null });
    await deleteBusinessAgent(BIZ, AGENT, makeDb(c));
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", AGENT);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "delete fail" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(deleteBusinessAgent(BIZ, AGENT)).rejects.toThrow(/delete fail/);
  });
});

describe("insertAgentRun", () => {
  const row = { id: RUN, agent_id: AGENT, business_id: BIZ, input_filename: "a.txt" };

  it("returns the inserted row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...row, status: "running" }, error: null });
    expect(await insertAgentRun(row, makeDb(c))).toMatchObject({ id: RUN, status: "running" });
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "run insert fail" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertAgentRun(row)).rejects.toThrow(/run insert fail/);
  });
});

describe("patchAgentRun", () => {
  it("applies the patch scoped to business + run (explicit client)", async () => {
    const c = chain({ error: null });
    await patchAgentRun(BIZ, RUN, { status: "succeeded", output_md: "done" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith({ status: "succeeded", output_md: "done" });
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", RUN);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "run patch fail" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(patchAgentRun(BIZ, RUN, { status: "failed" })).rejects.toThrow(/run patch fail/);
  });
});

describe("getAgentRun", () => {
  it("returns the row (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: RUN }, error: null });
    expect(await getAgentRun(BIZ, RUN, makeDb(c))).toEqual({ id: RUN });
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getAgentRun(BIZ, RUN)).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "run get fail" } });
    await expect(getAgentRun(BIZ, RUN, makeDb(c))).rejects.toThrow(/run get fail/);
  });
});

describe("listAgentRunInputPaths", () => {
  it("returns non-empty paths only (explicit client)", async () => {
    const c = chain({
      data: [
        { input_storage_path: "b/agent-inputs/r1/a.txt" },
        { input_storage_path: null },
        { input_storage_path: "" }
      ],
      error: null
    });
    expect(await listAgentRunInputPaths(BIZ, AGENT, makeDb(c))).toEqual([
      "b/agent-inputs/r1/a.txt"
    ]);
    expect(c.not).toHaveBeenCalledWith("input_storage_path", "is", null);
  });

  it("returns [] for a null payload (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listAgentRunInputPaths(BIZ, AGENT)).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "paths fail" } });
    await expect(listAgentRunInputPaths(BIZ, AGENT, makeDb(c))).rejects.toThrow(/paths fail/);
  });
});

describe("listAgentRuns", () => {
  it("returns rows with the default limit (explicit client)", async () => {
    const c = chain({ data: [{ id: RUN }], error: null });
    expect(await listAgentRuns(BIZ, AGENT, undefined, makeDb(c))).toEqual([{ id: RUN }]);
    expect(c.limit).toHaveBeenCalledWith(20);
  });

  it("returns [] for a null payload and honors a custom limit (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listAgentRuns(BIZ, AGENT, 5)).toEqual([]);
    expect(c.limit).toHaveBeenCalledWith(5);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "runs list fail" } });
    await expect(listAgentRuns(BIZ, AGENT, 10, makeDb(c))).rejects.toThrow(/runs list fail/);
  });
});
