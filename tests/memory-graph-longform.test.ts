/**
 * Long-form KG extraction (src/lib/memory/graph-longform.ts): chunking,
 * per-chunk fuse checks, source lines, metering, chunk-failure resilience,
 * and the never-throws contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: vi.fn(async () => undefined)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  LONGFORM_CHUNK_CHARS,
  LONGFORM_GRAPH_EXTRACTION_SYSTEM_PROMPT,
  LONGFORM_MAX_CHUNKS,
  chunkLongFormText,
  extractLongFormGraph
} from "@/lib/memory/graph-longform";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

const BIZ = "11111111-1111-4111-8111-111111111111";

const EXTRACTION_JSON = JSON.stringify({
  entities: [
    { ref: "e1", kind: "person", name: "Carla Counterparty", aliases: [], phones: [], emails: [] }
  ],
  facts: [{ subject_ref: "e1", predicate: "counterparty", object_value: "roofing contract", source_index: 0 }]
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    generate: vi.fn(async () => ({
      text: EXTRACTION_JSON,
      usage: { promptTokens: 100, outputTokens: 50 },
      model: "m",
      inputChars: 1,
      finishReason: "STOP"
    })),
    getMode: vi.fn(async () => "shadow" as const),
    listEntities: vi.fn(async () => []),
    apply: vi.fn(async () => ({
      entitiesCreated: 1,
      entitiesMerged: 0,
      factsInserted: 1,
      factsSuperseded: 0,
      factsSkipped: 0
    })),
    countToday: vi.fn(async () => 0),
    ...overrides
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP;
});

describe("chunkLongFormText", () => {
  it("returns [] for blank text and one chunk for short text", () => {
    expect(chunkLongFormText("   ")).toEqual([]);
    expect(chunkLongFormText("short doc")).toEqual(["short doc"]);
  });

  it("splits on paragraph boundaries in the back half of the window", () => {
    const para1 = "a".repeat(7000);
    const para2 = "b".repeat(7000);
    const chunks = chunkLongFormText(`${para1}\n\n${para2}`);
    expect(chunks).toEqual([para1, para2]);
  });

  it("hard-cuts when no paragraph break lands in the back half, and caps chunk count", () => {
    const unbroken = "x".repeat(LONGFORM_CHUNK_CHARS * (LONGFORM_MAX_CHUNKS + 2));
    const chunks = chunkLongFormText(unbroken);
    expect(chunks).toHaveLength(LONGFORM_MAX_CHUNKS);
    expect(chunks[0]).toHaveLength(LONGFORM_CHUNK_CHARS);
    // Early paragraph break (front half) is ignored in favor of the hard cut.
    const early = `${"y".repeat(100)}\n\n${"z".repeat(LONGFORM_CHUNK_CHARS * 2)}`;
    expect(chunkLongFormText(early)[0].length).toBe(LONGFORM_CHUNK_CHARS);
  });
});

describe("extractLongFormGraph", () => {
  const input = {
    text: "Contract between Acme Roofing and Carla Counterparty…",
    source: "document" as const,
    attributedTo: "Roofing contract 2026"
  };

  it("extracts each chunk under the long-form prompt with the document source line", async () => {
    const deps = makeDeps();
    const out = await extractLongFormGraph(BIZ, input, deps);
    expect(out).toMatchObject({ ran: true, chunks: 1 });
    expect(out.results).toHaveLength(1);
    const d = deps as { generate: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
    expect(d.generate.mock.calls[0][0]).toMatchObject({
      systemInstruction: LONGFORM_GRAPH_EXTRACTION_SYSTEM_PROMPT
    });
    expect(d.generate.mock.calls[0][0].userText).toContain(
      'SOURCE: filed business document titled "Roofing contract 2026"'
    );
    expect(d.apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      [input.text],
      {},
      { source: "document", trust: 2, attributedTo: "Roofing contract 2026" }
    );
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "memory_graph" })
    );
  });

  it("labels website and identity sources (identity at trust 3, untitled docs handled)", async () => {
    const site = makeDeps();
    await extractLongFormGraph(
      BIZ,
      { text: "About us…", source: "website", attributedTo: "https://amy.example" },
      site
    );
    expect((site as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0].userText).toContain(
      "SOURCE: the business's own website (https://amy.example)"
    );

    const identity = makeDeps();
    await extractLongFormGraph(BIZ, { text: "We are…", source: "identity", attributedTo: null }, identity);
    expect(
      (identity as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0].userText
    ).toContain("SOURCE: the owner's own identity write-up");
    expect((identity as { apply: ReturnType<typeof vi.fn> }).apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.anything(),
      {},
      expect.objectContaining({ trust: 3, attributedTo: null })
    );

    const untitledSite = makeDeps();
    await extractLongFormGraph(
      BIZ,
      { text: "doc body", source: "document", attributedTo: null },
      untitledSite
    );
    expect(
      (untitledSite as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0].userText
    ).toContain('titled "untitled"');
    const unknownUrl = makeDeps();
    await extractLongFormGraph(
      BIZ,
      { text: "site body", source: "website", attributedTo: null },
      unknownUrl
    );
    expect(
      (unknownUrl as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0].userText
    ).toContain("(unknown URL)");
  });

  it("no-ops on empty text, missing key, off mode", async () => {
    const deps = makeDeps();
    expect((await extractLongFormGraph(BIZ, { ...input, text: " " }, deps)).reason).toBe("empty");
    delete process.env.GOOGLE_API_KEY;
    expect((await extractLongFormGraph(BIZ, input, deps)).reason).toBe("no_api_key");
    process.env.GOOGLE_API_KEY = "k";
    const off = makeDeps({ getMode: vi.fn(async () => "off" as const) });
    expect((await extractLongFormGraph(BIZ, input, off)).reason).toBe("mode_off");
  });

  it("re-checks the fuse per chunk: blows before the first chunk → daily_cap; mid-run → partial", async () => {
    const blown = makeDeps({ countToday: vi.fn(async () => 999) });
    const out = await extractLongFormGraph(BIZ, input, blown);
    expect(out).toMatchObject({ ran: false, reason: "daily_cap" });
    expect((blown as { generate: ReturnType<typeof vi.fn> }).generate).not.toHaveBeenCalled();

    // Two chunks; the fuse blows after the first.
    process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP = "10";
    let calls = 0;
    const midRun = makeDeps({
      countToday: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? 0 : 10;
      })
    });
    const long = `${"a".repeat(9000)}\n\n${"b".repeat(9000)}`;
    const partial = await extractLongFormGraph(BIZ, { ...input, text: long }, midRun);
    expect(partial.ran).toBe(true);
    expect(partial.results).toHaveLength(1);
    expect((midRun as { generate: ReturnType<typeof vi.fn> }).generate).toHaveBeenCalledTimes(1);
  });

  it("a failed chunk meters (GeminiEmptyError) and the run continues; all-failed runs report error", async () => {
    const long = `${"a".repeat(9000)}\n\n${"b".repeat(9000)}`;
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new GeminiEmptyError({ promptTokens: 5, outputTokens: 0 }))
      .mockResolvedValueOnce({
        text: EXTRACTION_JSON,
        usage: { promptTokens: 100, outputTokens: 50 },
        model: "m",
        inputChars: 1,
        finishReason: "STOP"
      });
    const deps = makeDeps({ generate });
    const out = await extractLongFormGraph(BIZ, { ...input, text: long }, deps);
    expect(out.ran).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ outputChars: 0 })
    );

    const allFail = makeDeps({ generate: vi.fn(async () => Promise.reject("plain string")) });
    expect((await extractLongFormGraph(BIZ, input, allFail)).reason).toBe("error");
  });

  it("empty extractions run without applying; unexpected throws degrade to error", async () => {
    const empty = makeDeps({
      generate: vi.fn(async () => ({
        text: '{"entities": [], "facts": []}',
        usage: { promptTokens: 1, outputTokens: 1 },
        model: "m",
        inputChars: 1,
        finishReason: "STOP"
      }))
    });
    const out = await extractLongFormGraph(BIZ, input, empty);
    expect(out.ran).toBe(true);
    expect(out.results).toEqual([]);
    expect((empty as { apply: ReturnType<typeof vi.fn> }).apply).not.toHaveBeenCalled();

    const modeFail = makeDeps({ getMode: vi.fn(async () => Promise.reject(new Error("down"))) });
    expect((await extractLongFormGraph(BIZ, input, modeFail)).reason).toBe("error");
    const modeFailWeird = makeDeps({ getMode: vi.fn(async () => Promise.reject("weird")) });
    expect((await extractLongFormGraph(BIZ, input, modeFailWeird)).reason).toBe("error");
  });

  it("passes the known-entity index into the prompt and honors the model override", async () => {
    process.env.MEMORY_GRAPH_EXTRACT_MODEL = "gemini-custom";
    const deps = makeDeps({
      listEntities: vi.fn(async () => [
        {
          id: "e-1",
          business_id: BIZ,
          kind: "person",
          canonical_name: "Amy",
          aliases: [],
          phones: [],
          emails: [],
          customer_e164: null,
          source: "owner_chat",
          trust: 3,
          attributed_to: null,
          created_at: "",
          updated_at: ""
        }
      ])
    });
    await extractLongFormGraph(BIZ, input, deps);
    const call = (deps as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0];
    expect(call.model).toBe("gemini-custom");
    expect(call.userText).toContain("KNOWN ENTITIES");
    delete process.env.MEMORY_GRAPH_EXTRACT_MODEL;
  });
});
