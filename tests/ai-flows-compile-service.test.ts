/**
 * Shared AiFlow compile pipeline (src/lib/ai-flows/compile-service.ts):
 * document option loading, metering (including billed-but-empty), schema
 * validation, the one-shot self-repair round, salvage, and every failure
 * classification. Factored from POST /api/aiflows/compile; also drives the
 * dashboard-chat create_aiflow tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import type { GeminiGenerateTextParams } from "@/lib/gemini-generate-content";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { recordSystemLog } from "@/lib/db/system-logs";
import {
  compileAiFlowFromDescription,
  invalidDraftMessage
} from "@/lib/ai-flows/compile-service";
import type { BusinessDocumentRow } from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const meter = vi.mocked(meterGeminiSpendForBusiness);
const systemLog = vi.mocked(recordSystemLog);

const VALID_DEFINITION_JSON = JSON.stringify({
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "hi" }]
});

// Trigger schema failure that the SALVAGE pass can still mend (bad step
// dropped, valid trunk kept).
const INVALID_DEFINITION_JSON = JSON.stringify({
  version: 1,
  trigger: { channel: "manual" },
  steps: [
    { id: "s1", type: "notify_owner", message: "hi" },
    { id: "s2", type: "made_up_step" }
  ]
});

// Unsalvageable: parses as JSON but isn't an object (salvage returns null
// for arrays), while still failing schema validation.
const HOPELESS_JSON = "[1, 2]";

function readyDoc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: DOC_ID,
    business_id: BIZ,
    title: "Price sheet",
    category: "general",
    audience: "clients",
    storage_path: `${BIZ}/${DOC_ID}/prices.pdf`,
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "# Prices",
    summary: "Prices for everything.",
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
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "AIFLOW_COMPILE_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.AIFLOW_COMPILE_MODEL;
  meter.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function generateSeq(...texts: string[]) {
  const fn = vi.fn<(p: GeminiGenerateTextParams) => Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } | null }>>();
  for (const text of texts) {
    fn.mockResolvedValueOnce({ text, usage: { promptTokens: 100, outputTokens: 50 } });
  }
  return fn;
}

const noDocs = vi.fn(async () => [] as BusinessDocumentRow[]);

describe("compileAiFlowFromDescription — configuration & happy path", () => {
  it("reports not_configured without an API key (and accepts GEMINI_API_KEY alone)", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate: vi.fn(), fetchDocuments: noDocs }
    );
    expect(res).toMatchObject({ ok: false, error: "not_configured" });

    // Key parity with the inline chat surfaces: either env name works.
    process.env.GEMINI_API_KEY = "alt";
    const generate = generateSeq(VALID_DEFINITION_JSON);
    const res2 = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res2.ok).toBe(true);
    expect(generate.mock.calls[0][0].apiKey).toBe("alt");
  });

  it("compiles a valid definition first try and meters the call", async () => {
    const generate = generateSeq(VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res).toMatchObject({ ok: true, warnings: [] });
    if (res.ok) expect(res.definition.steps).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].userText).toContain("none on file");
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "aiflow_compile" })
    );
  });

  it("offers client-eligible ready documents to the model (and honors the env model)", async () => {
    process.env.AIFLOW_COMPILE_MODEL = "gemini-custom";
    const fetchDocuments = vi.fn(async () => [
      readyDoc(),
      readyDoc({ id: "33333333-3333-4333-8333-333333333333", audience: "staff", title: "Internal" })
    ]);
    const generate = generateSeq(VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "share the price sheet" },
      { generate, fetchDocuments }
    );
    expect(res.ok).toBe(true);
    const call = generate.mock.calls[0][0];
    expect(call.model).toBe("gemini-custom");
    expect(call.userText).toContain(DOC_ID);
    expect(call.userText).not.toContain("Internal");
  });

  it("offers ENABLED agents to the model (disabled filtered, summaries clipped)", async () => {
    const AGENT_ID = "44444444-4444-4444-8444-444444444444";
    const fetchAgents = vi.fn(async () => [
      {
        id: AGENT_ID,
        business_id: BIZ,
        name: "Intake summarizer",
        instructions: `Summarize   the\nintake ${"x".repeat(300)}`,
        output_format: "markdown" as const,
        enabled: true,
        created_at: "now",
        updated_at: "now"
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        business_id: BIZ,
        name: "Disabled agent",
        instructions: "n/a",
        output_format: "markdown" as const,
        enabled: false,
        created_at: "now",
        updated_at: "now"
      }
    ]);
    const generate = generateSeq(VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "summarize inbound leads" },
      { generate, fetchDocuments: noDocs, fetchAgents }
    );
    expect(res.ok).toBe(true);
    const userText = generate.mock.calls[0][0].userText;
    expect(userText).toContain(AGENT_ID);
    expect(userText).toContain("Intake summarizer");
    expect(userText).not.toContain("Disabled agent");
    // Whitespace-collapsed and clipped to 160 chars.
    expect(userText).not.toContain("Summarize   the");
  });

  it("compiles without agents when the list read fails (Error and non-Error throws)", async () => {
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      {
        generate: generateSeq(VALID_DEFINITION_JSON),
        fetchDocuments: noDocs,
        fetchAgents: vi.fn(async () => {
          throw new Error("agents db down");
        })
      }
    );
    expect(res.ok).toBe(true);

    const generate2 = generateSeq(VALID_DEFINITION_JSON);
    const res2 = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      {
        generate: generate2,
        fetchDocuments: noDocs,
        fetchAgents: vi.fn(async () => {
          throw "string failure";
        })
      }
    );
    expect(res2.ok).toBe(true);
    expect(generate2.mock.calls[0][0].userText).toContain("none saved");
  });

  it("run_agent bindings are validated against the DB (repair fed the issue)", async () => {
    const AGENT_ID = "44444444-4444-4444-8444-444444444444";
    const withBadAgent = JSON.stringify({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s1",
          type: "run_agent",
          agentId: "99999999-9999-4999-8999-999999999999",
          input: "hello",
          saveAs: "out"
        }
      ]
    });
    const fetchAgents = vi.fn(async () => [
      {
        id: AGENT_ID,
        business_id: BIZ,
        name: "Real agent",
        instructions: "Summarize.",
        output_format: "markdown" as const,
        enabled: true,
        created_at: "now",
        updated_at: "now"
      }
    ]);
    const generate = generateSeq(withBadAgent, VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "run my agent" },
      { generate, fetchDocuments: noDocs, fetchAgents }
    );
    expect(res.ok).toBe(true);
    expect(generate.mock.calls[1][0].userText).toContain("FAILED validation");
    expect(generate.mock.calls[1][0].userText).toContain("doesn't exist");
  });

  it("compiles without documents when the list read fails (Error and non-Error throws)", async () => {
    const fetchDocuments = vi.fn(async () => {
      throw new Error("db down");
    });
    const generate = generateSeq(VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments }
    );
    expect(res.ok).toBe(true);
    expect(generate.mock.calls[0][0].userText).toContain("none on file");

    const fetchDocuments2 = vi.fn(async () => {
      throw "string failure";
    });
    const res2 = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate: generateSeq(VALID_DEFINITION_JSON), fetchDocuments: fetchDocuments2 }
    );
    expect(res2.ok).toBe(true);
  });
});

describe("compileAiFlowFromDescription — failure classes", () => {
  it("meters a billed-but-empty first call then rethrows", async () => {
    const generate = vi.fn(async () => {
      throw new GeminiEmptyError({ promptTokens: 500, outputTokens: 100 });
    });
    await expect(
      compileAiFlowFromDescription(
        { businessId: BIZ, description: "notify me" },
        { generate, fetchDocuments: noDocs }
      )
    ).rejects.toThrow("gemini_empty");
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ outputChars: 0 }));
  });

  it("rethrows transport errors unmetered", async () => {
    const generate = vi.fn(async () => {
      throw new Error("gemini_http_500");
    });
    await expect(
      compileAiFlowFromDescription(
        { businessId: BIZ, description: "notify me" },
        { generate, fetchDocuments: noDocs }
      )
    ).rejects.toThrow("gemini_http_500");
    expect(meter).not.toHaveBeenCalled();
  });

  it("classifies unparseable output and records a system log (usage may be absent)", async () => {
    const generate = vi.fn(async () => ({ text: "total garbage no json", usage: null }));
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res).toMatchObject({ ok: false, error: "unparseable" });
    expect(systemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "aiflow_compile_failed" })
    );
  });

  it("rethrows a NON-validation error from the DB-backed document check", async () => {
    const withDoc = JSON.stringify({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s1",
          type: "share_document",
          documentId: DOC_ID,
          to: "+15551230000",
          via: "sms",
          messageTemplate: "Here: {{share_url}}"
        }
      ]
    });
    const fetchDocuments = vi
      .fn<() => Promise<BusinessDocumentRow[]>>()
      .mockResolvedValueOnce([readyDoc()])
      .mockRejectedValue(new Error("db exploded"));
    const generate = generateSeq(withDoc);
    await expect(
      compileAiFlowFromDescription(
        { businessId: BIZ, description: "share it" },
        { generate, fetchDocuments }
      )
    ).rejects.toThrow("db exploded");
  });
});

describe("compileAiFlowFromDescription — self-repair & salvage", () => {
  it("repairs an invalid first draft on the second model call (usage may be absent)", async () => {
    const generate = vi
      .fn<(p: GeminiGenerateTextParams) => Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } | null }>>()
      .mockResolvedValueOnce({ text: INVALID_DEFINITION_JSON, usage: null })
      .mockResolvedValueOnce({ text: VALID_DEFINITION_JSON, usage: null });
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res).toMatchObject({ ok: true, warnings: [] });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].userText).toContain("FAILED validation");
  });

  it("salvages when the repair output is also invalid (warnings surface)", async () => {
    const generate = generateSeq(INVALID_DEFINITION_JSON, INVALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.definition.steps).toHaveLength(1);
    }
    expect(systemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "aiflow_compile_salvaged" })
    );
  });

  it("salvages when the repair output is unparseable (original candidate salvaged)", async () => {
    const generate = generateSeq(INVALID_DEFINITION_JSON, "garbage");
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("meters a billed-but-empty repair call then salvages", async () => {
    const generate = vi
      .fn<(p: GeminiGenerateTextParams) => Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } | null }>>()
      .mockResolvedValueOnce({
        text: INVALID_DEFINITION_JSON,
        usage: { promptTokens: 100, outputTokens: 50 }
      })
      .mockRejectedValueOnce(new GeminiEmptyError({ promptTokens: 200, outputTokens: 30 }));
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res.ok).toBe(true);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { promptTokens: 200, outputTokens: 30 }, outputChars: 0 })
    );
  });

  it("logs a transient repair failure and still salvages (Error and non-Error throws)", async () => {
    const generate = vi
      .fn<(p: GeminiGenerateTextParams) => Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } | null }>>()
      .mockResolvedValueOnce({
        text: INVALID_DEFINITION_JSON,
        usage: { promptTokens: 100, outputTokens: 50 }
      })
      .mockRejectedValueOnce(new Error("gemini_http_503"));
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res.ok).toBe(true);

    const generate2 = vi
      .fn<(p: GeminiGenerateTextParams) => Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } | null }>>()
      .mockResolvedValueOnce({
        text: INVALID_DEFINITION_JSON,
        usage: { promptTokens: 100, outputTokens: 50 }
      })
      .mockRejectedValueOnce("string failure");
    const res2 = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate: generate2, fetchDocuments: noDocs }
    );
    expect(res2.ok).toBe(true);
  });

  it("a document-validation failure during salvage degrades to no extra warnings", async () => {
    // Candidate: a schema-invalid extra step forces the salvage path, while
    // the valid share_document step survives it — so the salvage-time
    // document re-check runs, and its thrown read is swallowed.
    const withDocAndJunk = JSON.stringify({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s1",
          type: "share_document",
          documentId: DOC_ID,
          to: "+15551230000",
          via: "sms",
          messageTemplate: "Here: {{share_url}}"
        },
        { id: "s2", type: "made_up_step" }
      ]
    });
    const fetchDocuments = vi
      .fn<() => Promise<BusinessDocumentRow[]>>()
      .mockResolvedValueOnce([readyDoc()])
      .mockRejectedValue(new Error("db down mid-salvage"));
    const generate = generateSeq(withDocAndJunk, "garbage");
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "share the sheet" },
      { generate, fetchDocuments }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.steps.some((s) => s.type === "share_document")).toBe(true);
      expect(res.warnings.some((w) => w.includes("db down"))).toBe(false);
    }
  });

  it("an agent-validation failure during salvage degrades to no extra warnings", async () => {
    const withAgentAndJunk = JSON.stringify({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s1",
          type: "run_agent",
          agentId: "44444444-4444-4444-8444-444444444444",
          input: "hello",
          saveAs: "out"
        },
        { id: "s2", type: "made_up_step" }
      ]
    });
    const fetchAgents = vi
      .fn<() => Promise<never[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("agents db down mid-salvage"));
    const generate = generateSeq(withAgentAndJunk, "garbage");
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "run my agent" },
      { generate, fetchDocuments: noDocs, fetchAgents }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.steps.some((s) => s.type === "run_agent")).toBe(true);
      expect(res.warnings.some((w) => w.includes("db down"))).toBe(false);
    }
  });

  it("returns invalid (humanized) when even salvage can't help", async () => {
    const generate = generateSeq(HOPELESS_JSON, HOPELESS_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "notify me" },
      { generate, fetchDocuments: noDocs }
    );
    expect(res).toMatchObject({ ok: false, error: "invalid" });
    if (!res.ok) {
      expect(res.message).toContain("needs a tweak");
      expect(res.issues.length).toBeGreaterThan(0);
    }
  });

  it("share_document bindings are validated against the DB (repair fed the issue)", async () => {
    // First draft binds a document that does NOT exist → DB-backed issue →
    // repair returns a clean definition.
    const withBadDoc = JSON.stringify({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "s1",
          type: "share_document",
          documentId: "99999999-9999-4999-8999-999999999999",
          to: "+15551230000",
          via: "sms",
          messageTemplate: "Here: {{share_url}}"
        }
      ]
    });
    const generate = generateSeq(withBadDoc, VALID_DEFINITION_JSON);
    const res = await compileAiFlowFromDescription(
      { businessId: BIZ, description: "share the sheet" },
      { generate, fetchDocuments: vi.fn(async () => [readyDoc()]) }
    );
    expect(res.ok).toBe(true);
    expect(generate.mock.calls[1][0].userText).toContain("FAILED validation");
  });
});

describe("invalidDraftMessage", () => {
  it("prefixes, bullets, and humanizes issues", () => {
    const msg = invalidDraftMessage(["trigger.channel: bad value"]);
    expect(msg).toContain("needs a tweak");
    expect(msg).toContain("• ");
  });
});
