/**
 * Conversational KG extraction (src/lib/memory/graph-conversational.ts):
 * the mode gate, the daily cost fuse, metering, the customer-source
 * provenance, and the never-throws contract — plus the pure helpers
 * (dominant source, cap parsing, today-count wire shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: vi.fn(async () => undefined)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  countKgExtractionsToday,
  dailyExtractionCap,
  dominantConversationSource,
  extractConversationGraph,
  CONVERSATION_EXTRACT_MAX_CHARS
} from "@/lib/memory/graph-conversational";
import { CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT } from "@/lib/memory/graph-extract";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

const BIZ = "11111111-1111-4111-8111-111111111111";

const EXTRACTION_JSON = JSON.stringify({
  entities: [
    { ref: "e1", kind: "person", name: "Bryan Buyer", aliases: [], phones: ["+15550001111"], emails: [] }
  ],
  facts: [{ subject_ref: "e1", predicate: "interested_in", object_value: "3-bed homes", source_index: 0 }]
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    generate: vi.fn(async () => ({
      text: EXTRACTION_JSON,
      usage: { promptTokens: 100, outputTokens: 50 },
      model: "gemini-3.5-flash-lite",
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

describe("extractConversationGraph", () => {
  const input = {
    transcript: "customer: I'm Bryan Buyer, +15550001111, looking at 3-bed homes",
    source: "voice_call" as const,
    attributedTo: "+15550001111"
  };

  it("extracts under the customer prompt and applies with customer provenance", async () => {
    const deps = makeDeps();
    const out = await extractConversationGraph(BIZ, input, deps);
    expect(out).toMatchObject({ ran: true, result: { entitiesCreated: 1 } });
    const d = deps as { generate: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
    expect(d.generate.mock.calls[0][0]).toMatchObject({
      systemInstruction: CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT,
      temperature: 0,
      responseMimeType: "application/json"
    });
    expect(d.apply).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ entities: [expect.objectContaining({ name: "Bryan Buyer" })] }),
      [input.transcript],
      {},
      { source: "voice_call", trust: 1, attributedTo: "+15550001111" }
    );
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "memory_graph" })
    );
  });

  it("no-ops on empty transcripts, missing api key, and off mode", async () => {
    const deps = makeDeps();
    expect(await extractConversationGraph(BIZ, { ...input, transcript: "  " }, deps)).toEqual({
      ran: false,
      reason: "empty"
    });

    delete process.env.GOOGLE_API_KEY;
    expect((await extractConversationGraph(BIZ, input, deps)).reason).toBe("no_api_key");
    process.env.GOOGLE_API_KEY = "test-key";

    const off = makeDeps({ getMode: vi.fn(async () => "off" as const) });
    expect((await extractConversationGraph(BIZ, input, off)).reason).toBe("mode_off");
    expect((off as { generate: ReturnType<typeof vi.fn> }).generate).not.toHaveBeenCalled();
  });

  it("defers on the daily cap — counted via the ledger, generation never invoked", async () => {
    const deps = makeDeps({ countToday: vi.fn(async () => 200) });
    const out = await extractConversationGraph(BIZ, input, deps);
    expect(out).toEqual({ ran: false, reason: "daily_cap" });
    expect((deps as { generate: ReturnType<typeof vi.fn> }).generate).not.toHaveBeenCalled();

    // Env-tunable: a lower cap bites earlier.
    process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP = "5";
    const low = makeDeps({ countToday: vi.fn(async () => 5) });
    expect((await extractConversationGraph(BIZ, input, low)).reason).toBe("daily_cap");
  });

  it("tail-trims oversized transcripts to the max window (newest kept)", async () => {
    const deps = makeDeps();
    const long = "x".repeat(CONVERSATION_EXTRACT_MAX_CHARS + 500) + "TAIL";
    await extractConversationGraph(BIZ, { ...input, transcript: long }, deps);
    const applied = (deps as { apply: ReturnType<typeof vi.fn> }).apply.mock.calls[0][2][0];
    expect(applied.length).toBe(CONVERSATION_EXTRACT_MAX_CHARS);
    expect(applied.endsWith("TAIL")).toBe(true);
  });

  it("meters GeminiEmptyError usage, degrades on failures, and tolerates non-Error throws", async () => {
    const emptyErr = new GeminiEmptyError({ promptTokens: 10, outputTokens: 0 });
    const emptyDeps = makeDeps({ generate: vi.fn(async () => Promise.reject(emptyErr)) });
    expect((await extractConversationGraph(BIZ, input, emptyDeps)).reason).toBe("extract_failed");
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { promptTokens: 10, outputTokens: 0 }, outputChars: 0 })
    );

    const plainFail = makeDeps({ generate: vi.fn(async () => Promise.reject(new Error("503"))) });
    expect((await extractConversationGraph(BIZ, input, plainFail)).reason).toBe("extract_failed");

    const applyFail = makeDeps({ apply: vi.fn(async () => Promise.reject("string throw")) });
    expect((await extractConversationGraph(BIZ, input, applyFail)).reason).toBe("error");

    const modeFail = makeDeps({
      getMode: vi.fn(async () => Promise.reject(new Error("db down")))
    });
    expect((await extractConversationGraph(BIZ, input, modeFail)).reason).toBe("error");
  });

  it("honors MEMORY_GRAPH_EXTRACT_MODEL and tolerates non-Error generate throws", async () => {
    process.env.MEMORY_GRAPH_EXTRACT_MODEL = "gemini-custom";
    const deps = makeDeps();
    await extractConversationGraph(BIZ, input, deps);
    expect((deps as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0]).toMatchObject(
      { model: "gemini-custom" }
    );
    delete process.env.MEMORY_GRAPH_EXTRACT_MODEL;

    const weird = makeDeps({ generate: vi.fn(async () => Promise.reject("plain string")) });
    expect((await extractConversationGraph(BIZ, input, weird)).reason).toBe("extract_failed");
  });

  it("an extraction with no entities runs without applying", async () => {
    const deps = makeDeps({
      generate: vi.fn(async () => ({
        text: '{"entities": [], "facts": []}',
        usage: { promptTokens: 10, outputTokens: 5 },
        model: "m",
        inputChars: 1,
        finishReason: "STOP"
      }))
    });
    const out = await extractConversationGraph(BIZ, input, deps);
    expect(out).toEqual({ ran: true, result: undefined });
    expect((deps as { apply: ReturnType<typeof vi.fn> }).apply).not.toHaveBeenCalled();
  });

  it("passes the known-entity index to the prompt composer", async () => {
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
    await extractConversationGraph(BIZ, input, deps);
    const userText = (deps as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0][0]
      .userText as string;
    expect(userText).toContain("KNOWN ENTITIES");
    expect(userText).toContain('"name":"Amy"');
  });
});

describe("dominantConversationSource", () => {
  it("prefers voice, then sms, then replied email", () => {
    expect(dominantConversationSource({ voiceTurns: 2, smsTurns: 5, emails: 1 })).toBe("voice_call");
    expect(dominantConversationSource({ voiceTurns: 0, smsTurns: 5, emails: 1 })).toBe("customer_sms");
    expect(dominantConversationSource({ voiceTurns: 0, smsTurns: 0, emails: 1 })).toBe("email_replied");
  });
});

describe("dailyExtractionCap", () => {
  it("defaults to 200; env overrides; garbage/zero falls back", () => {
    expect(dailyExtractionCap()).toBe(200);
    process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP = "50";
    expect(dailyExtractionCap()).toBe(50);
    process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP = "0";
    expect(dailyExtractionCap()).toBe(200);
    process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP = "banana";
    expect(dailyExtractionCap()).toBe(200);
  });
});

describe("countKgExtractionsToday", () => {
  function chain(result: { data?: unknown; error?: unknown }) {
    const c: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["from", "select"]) c[m] = vi.fn(() => c);
    let eqCalls = 0;
    c.eq = vi.fn(() => {
      eqCalls += 1;
      return eqCalls === 3 ? Promise.resolve(result) : c;
    });
    return c;
  }

  it("sums today's memory_graph call_count rows (per-model rows add up)", async () => {
    const c = chain({ data: [{ call_count: 3 }, { call_count: 4 }], error: null });
    expect(await countKgExtractionsToday(BIZ, c as never)).toBe(7);
    expect(c.from).toHaveBeenCalledWith("gemini_spend_daily");
    expect(c.eq).toHaveBeenCalledWith("surface", "memory_graph");
  });

  it("null data → 0; errors throw; default client works", async () => {
    const empty = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(empty);
    expect(await countKgExtractionsToday(BIZ)).toBe(0);

    const failing = chain({ data: null, error: { message: "denied" } });
    await expect(countKgExtractionsToday(BIZ, failing as never)).rejects.toThrow(
      "countKgExtractionsToday: denied"
    );
  });
});
