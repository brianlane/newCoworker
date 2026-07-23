/**
 * Graph-ingest orchestrator (src/lib/memory/graph-ingest.ts): mode gating,
 * extraction call + spend metering, defensive no-ops, and the never-throws
 * contract. Also covers scheduleGraphIngest's after() deferral.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterMock(cb)
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/gemini-generate-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini-generate-content")>()),
  geminiGenerateTextDetailed: vi.fn()
}));

import { GeminiEmptyError, type GeminiGenerateTextParams } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { ingestBulletsIntoGraph } from "@/lib/memory/graph-ingest";
import { scheduleGraphIngest } from "@/lib/memory/schedule-graph-ingest";
import type { MemoryEntityRow } from "@/lib/memory/graph-db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const meter = vi.mocked(meterGeminiSpendForBusiness);

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "MEMORY_GRAPH_EXTRACT_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.MEMORY_GRAPH_EXTRACT_MODEL;
  meter.mockResolvedValue(undefined);
});

function entityRow(): MemoryEntityRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    business_id: BIZ,
    kind: "person",
    canonical_name: "Amy Laidlaw",
    aliases: ["Amy"],
    phones: ["602-695-1142"],
    emails: [],
    customer_e164: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z"
  };
}

const GOOD_EXTRACTION = JSON.stringify({
  entities: [{ ref: "e1", kind: "person", name: "Dave Lane", aliases: [], phones: [], emails: [] }],
  facts: [{ subject_ref: "e1", predicate: "role", object_value: "agent", source_index: 0 }]
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  const base = {
    generate: vi.fn(async (_p: GeminiGenerateTextParams) => ({
      text: GOOD_EXTRACTION,
      usage: { promptTokens: 100, outputTokens: 40 }
    })),
    getMode: vi.fn(async () => "shadow" as const),
    listEntities: vi.fn(async () => [entityRow()]),
    apply: vi.fn(async () => ({
      entitiesCreated: 1,
      entitiesMerged: 0,
      factsInserted: 1,
      factsSuperseded: 0,
      factsSkipped: 0
    }))
  };
  return Object.assign(base, overrides as Record<string, never>);
}

describe("ingestBulletsIntoGraph", () => {
  it("extracts, meters, and applies in shadow mode (index in the prompt)", async () => {
    const deps = makeDeps();
    const res = await ingestBulletsIntoGraph(BIZ, ["Dave Lane is an agent"], deps);
    expect(res.ran).toBe(true);
    expect(res.result?.factsInserted).toBe(1);
    const call = deps.generate.mock.calls[0][0];
    expect(call.userText).toContain("0. Dave Lane is an agent");
    expect(call.userText).toContain("Amy Laidlaw"); // entity index rides along
    expect(call.responseMimeType).toBe("application/json");
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "memory_graph", model: "gemini-3.5-flash-lite" })
    );
    expect(deps.apply).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ entities: [expect.objectContaining({ name: "Dave Lane" })] }),
      ["Dave Lane is an agent"]
    );
  });

  it("runs in active mode too, honoring the model override", async () => {
    process.env.MEMORY_GRAPH_EXTRACT_MODEL = "gemini-custom";
    const deps = makeDeps({ getMode: vi.fn(async () => "active" as const) });
    const res = await ingestBulletsIntoGraph(BIZ, ["bullet"], deps);
    expect(res.ran).toBe(true);
    expect(deps.generate.mock.calls[0][0].model).toBe("gemini-custom");
  });

  it("no-ops on empty bullets, a missing key, and mode=off", async () => {
    const deps = makeDeps();
    expect((await ingestBulletsIntoGraph(BIZ, ["  ", ""], deps)).ran).toBe(false);

    delete process.env.GOOGLE_API_KEY;
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], deps)).ran).toBe(false);
    process.env.GEMINI_API_KEY = "alt-key";

    const off = makeDeps({ getMode: vi.fn(async () => "off" as const) });
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], off)).ran).toBe(false);
    expect(off.generate).not.toHaveBeenCalled();
  });

  it("meters a billed-but-empty extraction and drops the ingest", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => {
        throw new GeminiEmptyError({ promptTokens: 60, outputTokens: 20 });
      })
    });
    const res = await ingestBulletsIntoGraph(BIZ, ["rule"], deps);
    expect(res.ran).toBe(false);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "memory_graph", outputChars: 0 })
    );
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("drops the ingest on a thrown extraction, tolerating non-Error throws", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => {
        throw new Error("gemini_http_500");
      })
    });
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], deps)).ran).toBe(false);
    expect(meter).not.toHaveBeenCalled();

    const stringThrow = makeDeps({
      generate: vi.fn(async () => {
        throw "string failure";
      })
    });
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], stringThrow)).ran).toBe(false);
  });

  it("reports ran without a result when the extraction found no entities", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => ({ text: '{"entities": [], "facts": []}', usage: null }))
    });
    const res = await ingestBulletsIntoGraph(BIZ, ["small talk"], deps);
    expect(res).toEqual({ ran: true, result: undefined });
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("never throws — a mode-read failure resolves to a no-op (non-Error too)", async () => {
    const deps = makeDeps({
      getMode: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], deps)).ran).toBe(false);

    const stringThrow = makeDeps({
      getMode: vi.fn(async () => {
        throw "config read blew up";
      })
    });
    expect((await ingestBulletsIntoGraph(BIZ, ["rule"], stringThrow)).ran).toBe(false);
  });
});

describe("scheduleGraphIngest", () => {
  it("defers the ingest via after() without running it synchronously", () => {
    scheduleGraphIngest(BIZ, ["rule"]);
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("runs the ingest when the deferred callback fires (no key → no-op)", async () => {
    delete process.env.GOOGLE_API_KEY;
    scheduleGraphIngest(BIZ, ["rule"]);
    const cb = afterMock.mock.calls[0][0] as () => Promise<unknown>;
    await expect(cb()).resolves.toEqual({ ran: false });
  });
});
