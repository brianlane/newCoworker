/**
 * Direct tests for the shared business-knowledge core
 * (src/lib/knowledge-tools/handlers.ts) used by the voice adapter and the
 * Rowboat tool webhook. classifyGeminiError's branch matrix is pinned in
 * tests/voice-tools-knowledge-classify.test.ts via the route re-export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/configs", () => ({ getBusinessConfig: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  listBusinessDocuments: vi.fn()
}));
vi.mock("@/lib/gemini-generate-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini-generate-content")>()),
  geminiGenerateTextDetailed: vi.fn()
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));

import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import { getBusinessConfig } from "@/lib/db/configs";
import { getBusiness } from "@/lib/db/businesses";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { GeminiEmptyError, geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

const BIZ = "11111111-1111-4111-8111-111111111111";

function documentRow(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    title: "Price sheet",
    category: "pricing",
    audience: "both",
    storage_path: "p",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "- Haircut: $40",
    summary: "Service prices.",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    contact_id: null,
    renewal_date: null,
    assigned_employee_id: null,
    renewal_due_notified_at: null,
    renewal_final_notified_at: null,
    renewal_overdue_notified_at: null,
    renewal_outreach_enqueued_at: null,
    record_fields: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const gemini = vi.mocked(geminiGenerateTextDetailed);
const meter = vi.mocked(meterGeminiSpendForBusiness);

function geminiOk(text: string, usage: { promptTokens: number; outputTokens: number } | null) {
  return { text, usage };
}

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GEMINI_ROWBOAT_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_ROWBOAT_MODEL;
  meter.mockResolvedValue(undefined);
  vi.mocked(getBusiness).mockResolvedValue({ name: "Amy Laidlaw Team" } as never);
  vi.mocked(listBusinessDocuments).mockResolvedValue([]);
  vi.mocked(getBusinessConfig).mockResolvedValue({
    identity_md: "identity",
    soul_md: "soul",
    website_md: "website",
    memory_md: "memory"
  } as never);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("lookupBusinessKnowledge", () => {
  it("answers from the vault context and meters the spend with exact usage", async () => {
    gemini.mockResolvedValue(geminiOk("Open 9-5 weekdays.", { promptTokens: 900, outputTokens: 20 }));
    const result = await lookupBusinessKnowledge(BIZ, "What are your hours?");
    expect(result).toEqual({ ok: true, data: { answer: "Open 9-5 weekdays." } });
    const call = gemini.mock.calls[0][0];
    expect(call.userText).toContain("Business name: Amy Laidlaw Team");
    expect(call.userText).toContain("# website.md");
    expect(call.userText).toContain("Caller question: What are your hours?");
    // Regression pin (Truly, 2026-07-15): Gemini 3.x hidden thinking counts
    // against maxOutputTokens — at the old cap of 200 with default (high)
    // thinking the visible answer truncated mid-sentence ("D&O"). Gemini 3
    // models must run thinkingLevel=minimal with the 300 answer budget.
    expect(call.maxOutputTokens).toBe(300);
    expect(call.thinkingLevel).toBe("minimal");

    expect(meter).toHaveBeenCalledOnce();
    expect(meter.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: "gemini-3.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 900, outputTokens: 20 },
      outputChars: "Open 9-5 weekdays.".length
    });
    expect(meter.mock.calls[0][0].inputChars).toBeGreaterThan(0);
  });

  it("includes the rendered Business-profile block in the context when profile_md is set", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      identity_md: "identity",
      soul_md: "soul",
      website_md: "website",
      memory_md: "memory",
      profile_md: "## Business profile\n- Monday: 9:00 AM to 5:00 PM"
    } as never);
    gemini.mockResolvedValue(geminiOk("Open Mondays 9-5.", null));
    const result = await lookupBusinessKnowledge(BIZ, "Are you open Monday?");
    expect(result.ok).toBe(true);
    const call = gemini.mock.calls[0][0];
    expect(call.userText).toContain("# profile.md");
    expect(call.userText).toContain("Monday: 9:00 AM to 5:00 PM");
    // Profile sits between identity and soul, mirroring the instructions
    // composition order.
    expect(call.userText.indexOf("# profile.md")).toBeGreaterThan(
      call.userText.indexOf("# identity.md")
    );
    expect(call.userText.indexOf("# profile.md")).toBeLessThan(
      call.userText.indexOf("# soul.md")
    );
  });

  it("meters with null usage when the response carried no usageMetadata", async () => {
    gemini.mockResolvedValue(geminiOk("answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
    expect(meter.mock.calls[0][0].usage).toBeNull();
  });

  it("returns knowledge_empty when the vault has no content", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    vi.mocked(getBusinessConfig).mockResolvedValue(null as never);
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "knowledge_empty" });
    expect(gemini).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
  });

  it("packs a relevant document's full content into the context (clients default)", async () => {
    vi.mocked(listBusinessDocuments).mockResolvedValue([documentRow()]);
    gemini.mockResolvedValue(geminiOk("Haircuts are $40.", null));
    const result = await lookupBusinessKnowledge(BIZ, "how much is a haircut price?");
    expect(result.ok).toBe(true);
    const call = gemini.mock.calls[0][0];
    expect(call.userText).toContain("# document: Price sheet");
    expect(call.userText).toContain("- Haircut: $40");
  });

  it("hides staff-only documents from client surfaces but shows them to the dashboard", async () => {
    vi.mocked(listBusinessDocuments).mockResolvedValue([
      documentRow({ title: "Internal SOP", audience: "staff", content_md: "escalation ladder" })
    ]);
    gemini.mockResolvedValue(geminiOk("answer", null));

    await lookupBusinessKnowledge(BIZ, "what is the escalation ladder SOP?");
    expect(gemini.mock.calls[0][0].userText).not.toContain("Internal SOP");

    await lookupBusinessKnowledge(BIZ, "what is the escalation ladder SOP?", {
      audience: "staff"
    });
    expect(gemini.mock.calls[1][0].userText).toContain("# document: Internal SOP");
  });

  it("excludes expired documents from the context", async () => {
    vi.mocked(listBusinessDocuments).mockResolvedValue([
      documentRow({ expires_at: "2020-01-01T00:00:00Z" })
    ]);
    gemini.mockResolvedValue(geminiOk("answer", null));
    await lookupBusinessKnowledge(BIZ, "haircut price?");
    expect(gemini.mock.calls[0][0].userText).not.toContain("Price sheet");
  });

  it("mentions non-included documents by title+summary", async () => {
    vi.mocked(listBusinessDocuments).mockResolvedValue([
      documentRow({ id: "d2", title: "Holiday hours", summary: "Seasonal schedule.", content_md: "closed" })
    ]);
    gemini.mockResolvedValue(geminiOk("answer", null));
    await lookupBusinessKnowledge(BIZ, "what is the haircut price?");
    const call = gemini.mock.calls[0][0];
    expect(call.userText).toContain("# other documents on file");
    expect(call.userText).toContain("Holiday hours: Seasonal schedule.");
  });

  it("answers from the vault alone when the document read fails", async () => {
    vi.mocked(listBusinessDocuments).mockRejectedValue(new Error("table missing"));
    gemini.mockResolvedValue(geminiOk("vault answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: true, data: { answer: "vault answer" } });
    expect(gemini.mock.calls[0][0].userText).toContain("# identity.md");
  });

  it("tolerates a non-Error document read failure", async () => {
    vi.mocked(listBusinessDocuments).mockRejectedValue("string failure");
    gemini.mockResolvedValue(geminiOk("vault answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
  });

  it("maps a missing API key to summarizer_unavailable", async () => {
    delete process.env.GOOGLE_API_KEY;
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "summarizer_unavailable" });
    expect(meter).not.toHaveBeenCalled();
  });

  it("accepts GEMINI_API_KEY as the key source", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt-key";
    gemini.mockResolvedValue(geminiOk("answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
    expect(gemini.mock.calls[0][0].apiKey).toBe("alt-key");
  });

  it("omits thinkingLevel for non-Gemini-3 model overrides (2.5 rejects the field)", async () => {
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-2.5-flash";
    gemini.mockResolvedValue(geminiOk("answer", null));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result.ok).toBe(true);
    expect(gemini.mock.calls[0][0].model).toBe("gemini-2.5-flash");
    expect(gemini.mock.calls[0][0].thinkingLevel).toBeUndefined();
    expect(gemini.mock.calls[0][0].maxOutputTokens).toBe(300);
  });

  it("retries the default model when a configured override 404s and meters the fallback model", async () => {
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-9.9-nonexistent";
    gemini
      .mockRejectedValueOnce(new Error("gemini_http_404: model not found"))
      .mockResolvedValueOnce(geminiOk("fallback answer", { promptTokens: 5, outputTokens: 3 }));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: true, data: { answer: "fallback answer" } });
    expect(gemini.mock.calls[0][0].model).toBe("gemini-9.9-nonexistent");
    expect(gemini.mock.calls[1][0].model).toBe("gemini-3.5-flash-lite");
    expect(meter.mock.calls[0][0].model).toBe("gemini-3.5-flash-lite");
  });

  it("does NOT retry when the default model itself 404s", async () => {
    gemini.mockRejectedValue(new Error("gemini_http_404: gone"));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "upstream_client_error" });
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(meter).not.toHaveBeenCalled();
  });

  it("aborts a hung Gemini call after the 3s deadline (timeout)", async () => {
    vi.useFakeTimers();
    try {
      gemini.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      const pending = lookupBusinessKnowledge(BIZ, "hours?");
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toEqual({ ok: false, detail: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("meters a billed-but-empty reply (thinking-only output) before classifying it", async () => {
    gemini.mockRejectedValue(new GeminiEmptyError({ promptTokens: 800, outputTokens: 200 }));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "empty_answer" });
    expect(meter).toHaveBeenCalledOnce();
    expect(meter.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: "gemini-3.5-flash-lite",
      surface: "knowledge_lookup",
      usage: { promptTokens: 800, outputTokens: 200 },
      outputChars: 0
    });
  });

  it("tolerates non-Error throw values (classified as gemini_error)", async () => {
    gemini.mockRejectedValue("string failure");
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "gemini_error" });
  });

  it("classifies non-404 upstream failures (e.g. 500 → upstream_error)", async () => {
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-custom";
    gemini.mockRejectedValue(new Error("gemini_http_500: boom"));
    const result = await lookupBusinessKnowledge(BIZ, "hours?");
    expect(result).toEqual({ ok: false, detail: "upstream_error" });
    expect(gemini).toHaveBeenCalledTimes(1);
  });
});
