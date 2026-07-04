import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/gemini-generate-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini-generate-content")>();
  return { ...actual, geminiGenerateTextDetailed: vi.fn() };
});
vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  CALL_SUMMARY_DEFAULT_MODEL,
  CALL_SUMMARY_MAX_CHARS,
  CALL_SUMMARY_MAX_TRANSCRIPT_CHARS,
  clampTranscriptText,
  parseCallSummaryJson,
  summarizeCallTranscript
} from "@/lib/call-summaries/summarizer";
import { callSummariesAllowedForTier } from "@/lib/plans/call-summaries";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";

type DbResult = { data: unknown; error: { message: string } | null };

const BIZ = "00000000-0000-4000-8000-000000000001";
const TID = "00000000-0000-4000-8000-000000000002";

const COMPLETED_ROW = {
  id: TID,
  status: "completed",
  summarized_at: null,
  summary_attempts: 0
};

const TURNS = [
  { role: "caller", content: "Hi, do you do same-day plumbing repairs?" },
  { role: "assistant", content: "We do! I can book you for this afternoon." }
];

function makeDb(overrides: {
  row?: DbResult;
  biz?: DbResult;
  turns?: DbResult;
  onUpdate?: (values: Record<string, unknown>) => DbResult;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: async () => overrides.row ?? { data: COMPLETED_ROW, error: null }
        })),
        maybeSingle: async () =>
          table === "businesses"
            ? (overrides.biz ?? { data: { tier: "standard" }, error: null })
            : { data: null, error: null },
        order: async () => overrides.turns ?? { data: TURNS, error: null }
      }))
    })),
    update: vi.fn((values: Record<string, unknown>) => ({
      eq: vi.fn(async () => {
        updates.push(values);
        return overrides.onUpdate?.(values) ?? { data: null, error: null };
      })
    }))
  }));
  return { db: { from } as never, from, updates };
}

const GOOD_JSON = JSON.stringify({
  summary: "Caller asked about same-day plumbing repairs and booked an afternoon slot.",
  sentiment: "positive"
});

function generateOk(text = GOOD_JSON) {
  return vi
    .fn()
    .mockResolvedValue({ text, usage: { promptTokens: 100, outputTokens: 40 } }) as never;
}

const meterMock = vi.fn().mockResolvedValue(undefined) as never;

describe("callSummariesAllowedForTier", () => {
  it("gates on standard/enterprise", () => {
    expect(callSummariesAllowedForTier("standard")).toBe(true);
    expect(callSummariesAllowedForTier("enterprise")).toBe(true);
    expect(callSummariesAllowedForTier("starter")).toBe(false);
    expect(callSummariesAllowedForTier(null)).toBe(false);
    expect(callSummariesAllowedForTier(undefined)).toBe(false);
  });
});

describe("clampTranscriptText", () => {
  it("passes short text through untouched", () => {
    expect(clampTranscriptText("short call")).toBe("short call");
  });

  it("elides the middle of an over-budget transcript", () => {
    const text = "a".repeat(CALL_SUMMARY_MAX_TRANSCRIPT_CHARS + 100);
    const clamped = clampTranscriptText(text);
    expect(clamped).toContain("[... middle of call omitted ...]");
    expect(clamped.length).toBeLessThan(text.length);
  });

  it("honors a custom max", () => {
    const clamped = clampTranscriptText("0123456789", 6);
    expect(clamped).toBe("01\n[... middle of call omitted ...]\n6789");
  });
});

describe("parseCallSummaryJson", () => {
  it("parses clean JSON", () => {
    expect(parseCallSummaryJson(GOOD_JSON)).toEqual({
      summary: "Caller asked about same-day plumbing repairs and booked an afternoon slot.",
      sentiment: "positive"
    });
  });

  it("strips code fences and surrounding prose", () => {
    const fenced = "```json\n" + GOOD_JSON + "\n```";
    expect(parseCallSummaryJson(fenced)?.sentiment).toBe("positive");
  });

  it("returns null when no JSON object is present", () => {
    expect(parseCallSummaryJson("no braces here")).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    expect(parseCallSummaryJson("{not json}")).toBeNull();
  });

  it("returns null when summary is missing, non-string, or empty", () => {
    expect(parseCallSummaryJson(JSON.stringify({ sentiment: "positive" }))).toBeNull();
    expect(parseCallSummaryJson(JSON.stringify({ summary: 42 }))).toBeNull();
    expect(parseCallSummaryJson(JSON.stringify({ summary: "   " }))).toBeNull();
  });

  it("nulls an unknown sentiment and caps the summary length", () => {
    const parsed = parseCallSummaryJson(
      JSON.stringify({ summary: "x".repeat(CALL_SUMMARY_MAX_CHARS + 50), sentiment: "ecstatic" })
    );
    expect(parsed?.sentiment).toBeNull();
    expect(parsed?.summary).toHaveLength(CALL_SUMMARY_MAX_CHARS);
  });
});

describe("summarizeCallTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_CALL_SUMMARY_MODEL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails on a transcript lookup error", async () => {
    const { db } = makeDb({ row: { data: null, error: { message: "db down" } } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "db_failed", detail: "db down" });
  });

  it("skips a missing transcript", async () => {
    const { db } = makeDb({ row: { data: null, error: null } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("skips an in-progress transcript", async () => {
    const { db } = makeDb({
      row: { data: { ...COMPLETED_ROW, status: "in_progress" }, error: null }
    });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "not_completed" });
  });

  it("skips an already-summarized transcript", async () => {
    const { db } = makeDb({
      row: { data: { ...COMPLETED_ROW, summarized_at: "2026-07-27T00:00:00Z" }, error: null }
    });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "already_summarized" });
  });

  it("fails on a tier lookup error", async () => {
    const { db } = makeDb({ biz: { data: null, error: { message: "biz down" } } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "db_failed", detail: "biz down" });
  });

  it("skips a non-entitled tier without calling Gemini", async () => {
    const generate = generateOk();
    const { db } = makeDb({ biz: { data: { tier: "starter" }, error: null } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate,
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "tier" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails on a turns lookup error", async () => {
    const { db } = makeDb({ turns: { data: null, error: { message: "turns down" } } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "db_failed", detail: "turns down" });
  });

  it("terminally marks an empty transcript (null turns payload)", async () => {
    const { db, updates } = makeDb({ turns: { data: null, error: null } });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "empty_transcript" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ summary_error: "empty_transcript" });
    expect(updates[0].summarized_at).toEqual(expect.any(String));
  });

  it("fails when the empty-transcript mark cannot be persisted", async () => {
    const { db } = makeDb({
      turns: { data: [], error: null },
      onUpdate: () => ({ data: null, error: { message: "mark down" } })
    });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "db_failed", detail: "mark down" });
  });

  it("records an attempt when no Gemini API key is configured", async () => {
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    vi.stubEnv("GEMINI_API_KEY", undefined);
    const { db, updates } = makeDb({});
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "no_api_key" });
    expect(updates[0]).toEqual({ summary_attempts: 1, summary_error: "no_api_key" });
  });

  it("warns (but does not throw) when attempt bookkeeping fails", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    const { db } = makeDb({
      onUpdate: () => ({ data: null, error: { message: "bookkeeping down" } })
    });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "no_api_key" });
    expect(logger.warn).toHaveBeenCalledWith(
      "call-summary: attempt bookkeeping failed",
      expect.objectContaining({ error: "bookkeeping down" })
    );
  });

  it("falls back to GEMINI_API_KEY when GOOGLE_API_KEY is unset", async () => {
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    const generate = generateOk();
    const { db } = makeDb({});
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate,
      meter: meterMock
    });
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "gemini-key", model: CALL_SUMMARY_DEFAULT_MODEL })
    );
  });

  it("honors the GEMINI_CALL_SUMMARY_MODEL override", async () => {
    vi.stubEnv("GEMINI_CALL_SUMMARY_MODEL", "gemini-9-turbo");
    const generate = generateOk();
    const { db } = makeDb({});
    await summarizeCallTranscript(BIZ, TID, { client: db, generate, meter: meterMock });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-9-turbo" }));
  });

  it("records a retryable failure when Gemini throws (Error and non-Error)", async () => {
    const err = makeDb({});
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: err.db,
      generate: vi.fn().mockRejectedValue(new Error("gemini_http_500:boom")) as never,
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "gemini_failed", detail: "gemini_http_500:boom" });
    expect(err.updates[0]).toEqual({
      summary_attempts: 1,
      summary_error: "gemini_http_500:boom"
    });
    expect(meterMock).not.toHaveBeenCalled();

    const nonError = makeDb({});
    const result2 = await summarizeCallTranscript(BIZ, TID, {
      client: nonError.db,
      generate: vi.fn().mockRejectedValue("string blowup") as never,
      meter: meterMock
    });
    expect(result2).toEqual({ ok: false, reason: "gemini_failed", detail: "string blowup" });
  });

  it("meters billed-but-empty Gemini replies before recording the failure", async () => {
    const { db, updates } = makeDb({});
    const usage = { promptTokens: 900, outputTokens: 300 };
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: vi.fn().mockRejectedValue(new GeminiEmptyError(usage)) as never,
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "gemini_failed", detail: "gemini_empty" });
    expect(meterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        surface: "call_summary",
        usage,
        outputChars: 0
      })
    );
    expect(updates[0]).toMatchObject({ summary_attempts: 1 });
  });

  it("records a retryable bad_json failure after metering", async () => {
    const { db, updates } = makeDb({});
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk("total nonsense"),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "bad_json" });
    expect(meterMock).toHaveBeenCalledTimes(1);
    expect(updates[0]).toEqual({ summary_attempts: 1, summary_error: "bad_json" });
  });

  it("keeps the row retryable when the final persist fails", async () => {
    const { db, updates } = makeDb({
      onUpdate: (values) =>
        "summary" in values
          ? { data: null, error: { message: "persist down" } }
          : { data: null, error: null }
    });
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate: generateOk(),
      meter: meterMock
    });
    expect(result).toEqual({ ok: false, reason: "db_failed", detail: "persist down" });
    expect(updates[1]).toEqual({
      summary_attempts: 1,
      summary_error: "persist:persist down"
    });
  });

  it("persists summary + sentiment and meters the spend on success", async () => {
    const generate = generateOk();
    const { db, updates } = makeDb({});
    const result = await summarizeCallTranscript(BIZ, TID, {
      client: db,
      generate,
      meter: meterMock
    });
    expect(result).toEqual({
      ok: true,
      summary: "Caller asked about same-day plumbing repairs and booked an afternoon slot.",
      sentiment: "positive",
      turnCount: 2
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        responseMimeType: "application/json",
        thinkingLevel: "low",
        userText: expect.stringContaining("Caller: Hi, do you do same-day plumbing repairs?")
      })
    );
    expect(meterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        model: CALL_SUMMARY_DEFAULT_MODEL,
        surface: "call_summary",
        usage: { promptTokens: 100, outputTokens: 40 },
        outputChars: GOOD_JSON.length
      })
    );
    expect(updates[0]).toMatchObject({
      summary: "Caller asked about same-day plumbing repairs and booked an afternoon slot.",
      sentiment: "positive",
      summary_error: null
    });
    expect(updates[0].summarized_at).toEqual(expect.any(String));
  });

  it("uses the default client / generate / meter dependencies", async () => {
    const { db } = makeDb({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.mocked(geminiGenerateTextDetailed).mockResolvedValue({
      text: GOOD_JSON,
      usage: { promptTokens: 10, outputTokens: 5 }
    });
    const result = await summarizeCallTranscript(BIZ, TID);
    expect(result.ok).toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(geminiGenerateTextDetailed).toHaveBeenCalled();
    expect(meterGeminiSpendForBusiness).toHaveBeenCalled();
  });
});
