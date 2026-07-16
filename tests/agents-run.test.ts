/**
 * Agent run executor (src/lib/agents/run.ts): mime routing (text inline vs
 * PDF inlineData), output-format targets, metering (including
 * billed-but-empty replies), and every failure classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));

import type { GeminiGenerateTextParams } from "@/lib/gemini-generate-content";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { AGENT_INPUT_MAX_TEXT_CHARS } from "@/lib/agents/core";
import { executeAgentRun, type AgentRunInput } from "@/lib/agents/run";

const BIZ = "11111111-1111-4111-8111-111111111111";
const meter = vi.mocked(meterGeminiSpendForBusiness);

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "AGENT_RUN_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.AGENT_RUN_MODEL;
  meter.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function generateOk(text: string) {
  return vi.fn(async (_params: GeminiGenerateTextParams) => ({
    text,
    usage: { promptTokens: 100, outputTokens: 50 }
  }));
}

function textInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    businessId: BIZ,
    agent: { instructions: "Summarize the intake form.", output_format: "markdown" },
    inputFilename: "intake.txt",
    inputMime: "text/plain",
    data: Buffer.from("Name: Pat\nService: haircut"),
    ...overrides
  };
}

describe("executeAgentRun (text)", () => {
  it("runs the transformation and meters the spend", async () => {
    const generate = generateOk("# Intake Summary\n- Pat: haircut");
    const res = await executeAgentRun(textInput(), { generate });
    expect(res).toEqual({
      ok: true,
      outputMd: "# Intake Summary\n- Pat: haircut",
      outputFilename: "intake.md",
      outputMime: "text/markdown",
      usage: { promptTokens: 100, outputTokens: 50 }
    });
    const call = generate.mock.calls[0][0];
    expect(call.userText).toContain("Summarize the intake form.");
    expect(call.userText).toContain("Name: Pat");
    expect(call.inlineParts).toBeUndefined();
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "agent_run" })
    );
  });

  it("echoes CSV in kind for same_as_input agents", async () => {
    const generate = generateOk("name,service\nPat,haircut");
    const res = await executeAgentRun(
      textInput({
        agent: { instructions: "Clean up the rows.", output_format: "same_as_input" },
        inputFilename: "leads.csv",
        inputMime: "text/csv",
        data: Buffer.from("name , service\nPat,haircut")
      }),
      { generate }
    );
    expect(res).toMatchObject({
      ok: true,
      outputFilename: "leads.csv",
      outputMime: "text/csv"
    });
    expect(generate.mock.calls[0][0].userText).toContain("Produce the result as CSV.");
  });

  it("converts a VTT transcript to speaker lines before prompting (markdown out)", async () => {
    const generate = generateOk("# Minutes");
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Dania: The premium is $1,240 per year."
    ].join("\n");
    const res = await executeAgentRun(
      textInput({
        agent: { instructions: "Write the minutes.", output_format: "same_as_input" },
        inputFilename: "meeting.vtt",
        inputMime: "text/vtt",
        data: Buffer.from(vtt)
      }),
      { generate }
    );
    // same_as_input still produces markdown for transcripts — echoing VTT
    // back would be subtitle soup, not minutes.
    expect(res).toMatchObject({ ok: true, outputFilename: "meeting.md", outputMime: "text/markdown" });
    const call = generate.mock.calls[0][0];
    expect(call.userText).toContain("Dania: The premium is $1,240 per year.");
    expect(call.userText).not.toContain("-->");
  });

  it("strips NUL bytes and clips oversized text", async () => {
    const generate = generateOk("done");
    const res = await executeAgentRun(
      textInput({ data: Buffer.from("\u0000" + "z".repeat(AGENT_INPUT_MAX_TEXT_CHARS + 500)) }),
      { generate }
    );
    expect(res.ok).toBe(true);
    const call = generate.mock.calls[0][0];
    expect(call.userText).not.toContain("\u0000");
    expect(call.userText.length).toBeLessThan(AGENT_INPUT_MAX_TEXT_CHARS + 2_000);
  });

  it("rejects an empty text attachment without calling Gemini", async () => {
    const generate = generateOk("x");
    const res = await executeAgentRun(textInput({ data: Buffer.from("   ") }), { generate });
    expect(res).toEqual({ ok: false, error: "empty_content" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("maps a blank model reply to empty_content", async () => {
    const res = await executeAgentRun(textInput(), { generate: generateOk("   ") });
    expect(res).toEqual({ ok: false, error: "empty_content" });
  });
});

describe("executeAgentRun (pdf)", () => {
  it("sends the PDF as inlineData", async () => {
    const generate = generateOk("# Extracted");
    const res = await executeAgentRun(
      textInput({
        inputFilename: "invoice.pdf",
        inputMime: "application/pdf",
        data: Buffer.from("%PDF-1.4 fake")
      }),
      { generate }
    );
    expect(res).toMatchObject({ ok: true, outputFilename: "invoice.md" });
    const call = generate.mock.calls[0][0];
    expect(call.inlineParts).toEqual([
      {
        mimeType: "application/pdf",
        dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64")
      }
    ]);
    expect(call.userText).toContain('The file "invoice.pdf" is attached.');
  });

  it("rejects an empty PDF without calling Gemini", async () => {
    const generate = generateOk("x");
    const res = await executeAgentRun(
      textInput({ inputMime: "application/pdf", data: Buffer.alloc(0) }),
      { generate }
    );
    expect(res).toEqual({ ok: false, error: "empty_content" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("executeAgentRun (failure modes)", () => {
  it("rejects unsupported mime types", async () => {
    const res = await executeAgentRun(textInput({ inputMime: "image/png" }), {
      generate: generateOk("x")
    });
    expect(res).toEqual({ ok: false, error: "unsupported_type" });
  });

  it("reports model_unavailable without an API key", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await executeAgentRun(textInput(), { generate: generateOk("x") });
    expect(res).toEqual({ ok: false, error: "model_unavailable" });
  });

  it("accepts GEMINI_API_KEY and a configured model", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt";
    process.env.AGENT_RUN_MODEL = "gemini-custom";
    const generate = generateOk("out");
    const res = await executeAgentRun(textInput(), { generate });
    expect(res.ok).toBe(true);
    expect(generate.mock.calls[0][0]).toMatchObject({ apiKey: "alt", model: "gemini-custom" });
  });

  it("classifies a thrown generate as model_failed with detail", async () => {
    const generate = vi.fn(async () => {
      throw new Error("gemini_http_500: boom");
    });
    const res = await executeAgentRun(textInput(), { generate });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "gemini_http_500: boom" });
    expect(meter).not.toHaveBeenCalled();
  });

  it("meters a billed-but-empty reply before failing", async () => {
    const generate = vi.fn(async () => {
      throw new GeminiEmptyError({ promptTokens: 500, outputTokens: 100 });
    });
    const res = await executeAgentRun(textInput(), { generate });
    expect(res.ok).toBe(false);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "agent_run",
        usage: { promptTokens: 500, outputTokens: 100 },
        outputChars: 0
      })
    );
  });

  it("tolerates non-Error throw values", async () => {
    const generate = vi.fn(async () => {
      throw "string failure";
    });
    const res = await executeAgentRun(textInput(), { generate });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "string failure" });
  });
});
