/**
 * Wire-level shapes for the memory-graph PostgREST wrappers
 * (src/lib/memory/graph-db.ts) — table names, column filters, update
 * payloads, and error mapping, with both the injected-client and
 * default-client paths exercised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/admin/platform-settings", () => ({
  getAdminPlatformSetting: vi.fn(async () => null)
}));

import {
  getMemoryGraphDefaultMode,
  getMemoryGraphMode,
  insertMemoryEntity,
  insertMemoryFact,
  listActiveFacts,
  listMemoryEntities,
  resetMemoryGraphDefaultCache,
  resolveMemoryGraphMode,
  supersedeMemoryFacts,
  updateMemoryEntity
} from "@/lib/memory/graph-db";
import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  resetMemoryGraphDefaultCache();
});

type Chain = Record<string, ReturnType<typeof vi.fn>>;

/** Self-returning chain that resolves to `result` at the given terminal. */
function chain(result: { data?: unknown; error?: unknown }, terminal: string): Chain {
  const c: Chain = {};
  for (const m of ["from", "select", "insert", "update", "eq", "in", "single", "maybeSingle"]) {
    c[m] = vi.fn(() => (m === terminal ? Promise.resolve(result) : c));
  }
  return c;
}

describe("listMemoryEntities", () => {
  it("selects by business_id and returns rows", async () => {
    const c = chain({ data: [{ id: "e1" }], error: null }, "eq");
    const rows = await listMemoryEntities(BIZ, c as never);
    expect(rows).toEqual([{ id: "e1" }]);
    expect(c.from).toHaveBeenCalledWith("memory_entities");
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("maps null data to [] and throws on error", async () => {
    const empty = chain({ data: null, error: null }, "eq");
    expect(await listMemoryEntities(BIZ, empty as never)).toEqual([]);
    const failing = chain({ data: null, error: { message: "boom" } }, "eq");
    await expect(listMemoryEntities(BIZ, failing as never)).rejects.toThrow(
      "listMemoryEntities: boom"
    );
  });

  it("falls back to the default client when none is injected", async () => {
    const c = chain({ data: [], error: null }, "eq");
    defaultClientSpy.mockReturnValue(c);
    await listMemoryEntities(BIZ);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("insertMemoryEntity", () => {
  const entity = {
    business_id: BIZ,
    kind: "person",
    canonical_name: "Amy",
    aliases: [],
    phones: [],
    emails: []
  };

  it("inserts and returns the created row", async () => {
    const c = chain({ data: { id: "new-id" }, error: null }, "single");
    const row = await insertMemoryEntity(entity, c as never);
    expect(row).toEqual({ id: "new-id" });
    expect(c.from).toHaveBeenCalledWith("memory_entities");
    expect(c.insert).toHaveBeenCalledWith(entity);
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ data: null, error: { message: "denied" } }, "single");
    await expect(insertMemoryEntity(entity, failing as never)).rejects.toThrow(
      "insertMemoryEntity: denied"
    );
    const ok = chain({ data: { id: "x" }, error: null }, "single");
    defaultClientSpy.mockReturnValue(ok);
    await insertMemoryEntity(entity);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("updateMemoryEntity", () => {
  it("patches by id with a fresh updated_at", async () => {
    const c = chain({ error: null }, "eq");
    await updateMemoryEntity("e1", { aliases: ["a"] }, c as never);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ aliases: ["a"], updated_at: expect.any(String) })
    );
    expect(c.eq).toHaveBeenCalledWith("id", "e1");
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ error: { message: "nope" } }, "eq");
    await expect(updateMemoryEntity("e1", {}, failing as never)).rejects.toThrow(
      "updateMemoryEntity: nope"
    );
    const ok = chain({ error: null }, "eq");
    defaultClientSpy.mockReturnValue(ok);
    await updateMemoryEntity("e1", {});
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("listActiveFactsForBusiness", () => {
  it("filters business + active and returns rows", async () => {
    const c = chain({ data: [{ id: "f1" }], error: null }, "noop");
    let eqCount = 0;
    c.eq = vi.fn(() => {
      eqCount += 1;
      return eqCount === 2 ? Promise.resolve({ data: [{ id: "f1" }], error: null }) : c;
    });
    const { listActiveFactsForBusiness } = await import("@/lib/memory/graph-db");
    const rows = await listActiveFactsForBusiness(BIZ, c as never);
    expect(rows).toEqual([{ id: "f1" }]);
    expect(c.from).toHaveBeenCalledWith("memory_facts");
  });

  it("maps null data to [], throws on error, supports the default client", async () => {
    const { listActiveFactsForBusiness } = await import("@/lib/memory/graph-db");
    const failing = chain({ data: null, error: null }, "noop");
    let n = 0;
    failing.eq = vi.fn(() => {
      n += 1;
      return n === 2 ? Promise.resolve({ data: null, error: { message: "bad" } }) : failing;
    });
    await expect(listActiveFactsForBusiness(BIZ, failing as never)).rejects.toThrow(
      "listActiveFactsForBusiness: bad"
    );

    const empty = chain({ data: null, error: null }, "noop");
    let m = 0;
    empty.eq = vi.fn(() => {
      m += 1;
      return m === 2 ? Promise.resolve({ data: null, error: null }) : empty;
    });
    defaultClientSpy.mockReturnValue(empty);
    expect(await listActiveFactsForBusiness(BIZ)).toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("listActiveFacts", () => {
  it("filters business + subject + predicate + active", async () => {
    const calls: unknown[][] = [];
    const c = chain({ data: [{ id: "f1" }], error: null }, "eq");
    // The 4th .eq resolves; capture all filter args.
    let eqCount = 0;
    c.eq = vi.fn((...args: unknown[]) => {
      calls.push(args);
      eqCount += 1;
      return eqCount === 4 ? Promise.resolve({ data: [{ id: "f1" }], error: null }) : c;
    });
    const rows = await listActiveFacts(BIZ, "subj", "phone", c as never);
    expect(rows).toEqual([{ id: "f1" }]);
    expect(calls).toEqual([
      ["business_id", BIZ],
      ["subject_entity_id", "subj"],
      ["predicate", "phone"],
      ["active", true]
    ]);
  });

  it("maps null data to [], throws on error, supports the default client", async () => {
    const failing = chain({ data: null, error: { message: "bad" } }, "eq");
    let eqCount = 0;
    const failEq = failing.eq;
    failing.eq = vi.fn((...args: unknown[]) => {
      eqCount += 1;
      return eqCount === 4 ? Promise.resolve({ data: null, error: { message: "bad" } }) : failing;
    });
    void failEq;
    await expect(listActiveFacts(BIZ, "s", "p", failing as never)).rejects.toThrow(
      "listActiveFacts: bad"
    );

    const empty = chain({ data: null, error: null }, "noop");
    let n = 0;
    empty.eq = vi.fn(() => {
      n += 1;
      return n === 4 ? Promise.resolve({ data: null, error: null }) : empty;
    });
    defaultClientSpy.mockReturnValue(empty);
    expect(await listActiveFacts(BIZ, "s", "p")).toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("insertMemoryFact", () => {
  const fact = {
    business_id: BIZ,
    subject_entity_id: "subj",
    predicate: "phone",
    object_value: "602",
    source_text: "- bullet"
  };

  it("inserts and returns the created row", async () => {
    const c = chain({ data: { id: "f-new" }, error: null }, "single");
    const row = await insertMemoryFact(fact, c as never);
    expect(row).toEqual({ id: "f-new" });
    expect(c.from).toHaveBeenCalledWith("memory_facts");
    expect(c.insert).toHaveBeenCalledWith(fact);
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ data: null, error: { message: "constraint" } }, "single");
    await expect(insertMemoryFact(fact, failing as never)).rejects.toThrow(
      "insertMemoryFact: constraint"
    );
    const ok = chain({ data: { id: "x" }, error: null }, "single");
    defaultClientSpy.mockReturnValue(ok);
    await insertMemoryFact(fact);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("supersedeMemoryFacts", () => {
  it("marks the ids inactive with the superseding fact id", async () => {
    const c = chain({ error: null }, "in");
    await supersedeMemoryFacts(["f1", "f2"], "f-new", c as never);
    expect(c.update).toHaveBeenCalledWith({ active: false, superseded_by: "f-new" });
    expect(c.in).toHaveBeenCalledWith("id", ["f1", "f2"]);
  });

  it("no-ops on an empty id list without touching the client", async () => {
    await supersedeMemoryFacts([], "f-new");
    expect(defaultClientSpy).not.toHaveBeenCalled();
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ error: { message: "locked" } }, "in");
    await expect(supersedeMemoryFacts(["f1"], "f2", failing as never)).rejects.toThrow(
      "supersedeMemoryFacts: locked"
    );
    const ok = chain({ error: null }, "in");
    defaultClientSpy.mockReturnValue(ok);
    await supersedeMemoryFacts(["f1"], "f2");
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("resolveMemoryGraphMode / getMemoryGraphDefaultMode", () => {
  beforeEach(() => {
    resetMemoryGraphDefaultCache();
  });

  it("passes explicit modes through without touching the settings read", async () => {
    const getSetting = vi.fn(async () => "active");
    expect(await resolveMemoryGraphMode("off", { getSetting })).toBe("off");
    expect(await resolveMemoryGraphMode("shadow", { getSetting })).toBe("shadow");
    expect(await resolveMemoryGraphMode("active", { getSetting })).toBe("active");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("resolves inherit/absent/unknown through the fleet default", async () => {
    const getSetting = vi.fn(async () => "active");
    expect(await resolveMemoryGraphMode("inherit", { getSetting })).toBe("active");
    resetMemoryGraphDefaultCache();
    expect(await resolveMemoryGraphMode(null, { getSetting })).toBe("active");
    resetMemoryGraphDefaultCache();
    expect(await resolveMemoryGraphMode("banana", { getSetting })).toBe("active");
  });

  it("caches the fleet default for ~60s and re-reads after the TTL", async () => {
    const getSetting = vi.fn(async () => "off");
    let clock = 1_000_000;
    const now = () => clock;
    expect(await getMemoryGraphDefaultMode({ getSetting, now })).toBe("off");
    expect(await getMemoryGraphDefaultMode({ getSetting, now })).toBe("off");
    expect(getSetting).toHaveBeenCalledTimes(1);
    clock += 61_000;
    expect(await getMemoryGraphDefaultMode({ getSetting, now })).toBe("off");
    expect(getSetting).toHaveBeenCalledTimes(2);
  });

  it("falls back to shadow on a missing, malformed, or failing setting", async () => {
    expect(await getMemoryGraphDefaultMode({ getSetting: vi.fn(async () => null) })).toBe("shadow");
    resetMemoryGraphDefaultCache();
    expect(await getMemoryGraphDefaultMode({ getSetting: vi.fn(async () => "banana") })).toBe(
      "shadow"
    );
    resetMemoryGraphDefaultCache();
    expect(
      await getMemoryGraphDefaultMode({
        getSetting: vi.fn(async () => {
          throw new Error("settings table down");
        })
      })
    ).toBe("shadow");
  });
});

describe("getMemoryGraphMode", () => {
  beforeEach(() => {
    resetMemoryGraphDefaultCache();
  });

  it("returns explicit shadow/active; inherit and missing rows follow the fleet default", async () => {
    const shadow = chain({ data: { memory_graph_mode: "shadow" }, error: null }, "maybeSingle");
    expect(await getMemoryGraphMode(BIZ, shadow as never)).toBe("shadow");
    const active = chain({ data: { memory_graph_mode: "active" }, error: null }, "maybeSingle");
    expect(await getMemoryGraphMode(BIZ, active as never)).toBe("active");
    // 'inherit' + missing rows consult the fleet default; the mocked
    // platform-settings read reports 'off' here.
    vi.mocked(getAdminPlatformSetting).mockResolvedValue("off");
    const inherit = chain({ data: { memory_graph_mode: "inherit" }, error: null }, "maybeSingle");
    expect(await getMemoryGraphMode(BIZ, inherit as never)).toBe("off");
    resetMemoryGraphDefaultCache();
    const missing = chain({ data: null, error: null }, "maybeSingle");
    expect(await getMemoryGraphMode(BIZ, missing as never)).toBe("off");
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ data: null, error: { message: "read denied" } }, "maybeSingle");
    await expect(getMemoryGraphMode(BIZ, failing as never)).rejects.toThrow(
      "getMemoryGraphMode: read denied"
    );
    const ok = chain({ data: { memory_graph_mode: "off" }, error: null }, "maybeSingle");
    defaultClientSpy.mockReturnValue(ok);
    expect(await getMemoryGraphMode(BIZ)).toBe("off");
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
