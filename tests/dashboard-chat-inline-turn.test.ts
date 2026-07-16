/**
 * Inline dashboard-chat turn engine
 * (src/lib/dashboard-chat/inline-turn.ts): attachment rendering, the model
 * ↔ tool loop (create_aiflow / create_agent drafts / business_knowledge_lookup),
 * the 404 model fallback, metering, and every failure classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import type { GeminiChatStepParams, GeminiChatStepResult } from "@/lib/gemini-chat";
import {
  CHAT_ATTACHMENT_MAX_TEXT_CHARS,
  buildAttachmentParts,
  runInlineChatTurn,
  type InlineTurnAttachment
} from "@/lib/dashboard-chat/inline-turn";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

const BIZ = "11111111-1111-4111-8111-111111111111";
const meter = vi.mocked(meterGeminiSpendForBusiness);

const VALID_DEFINITION: AiFlowDefinition = parseAiFlowDefinition({
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "hi" }]
});

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "DASHBOARD_CHAT_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.DASHBOARD_CHAT_MODEL;
  meter.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function textStep(text: string): GeminiChatStepResult {
  return {
    text,
    functionCalls: [],
    modelContent: { role: "model", parts: [{ text }] },
    usage: { promptTokens: 100, outputTokens: 20 }
  };
}

function toolStep(name: string, args: Record<string, unknown>): GeminiChatStepResult {
  return {
    text: null,
    functionCalls: [{ name, args }],
    modelContent: { role: "model", parts: [{ functionCall: { name, args } }] },
    usage: { promptTokens: 100, outputTokens: 10 }
  };
}

function baseArgs(overrides: Partial<Parameters<typeof runInlineChatTurn>[0]> = {}) {
  return {
    businessId: BIZ,
    systemInstruction: "OWNER MODE",
    userMessage: "[Dashboard] hello",
    ...overrides
  };
}

describe("buildAttachmentParts", () => {
  it("inlines text formats (NUL-stripped, clipped) with the filename", () => {
    const att: InlineTurnAttachment = {
      filename: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("\u0000" + "z".repeat(CHAT_ATTACHMENT_MAX_TEXT_CHARS + 100))
    };
    const { textBlock, inlinePart } = buildAttachmentParts(att);
    expect(textBlock).toContain('Attached file "notes.txt"');
    expect(textBlock).not.toContain("\u0000");
    expect(textBlock!.length).toBeLessThan(CHAT_ATTACHMENT_MAX_TEXT_CHARS + 200);
    expect(inlinePart).toBeNull();
  });

  it("converts VTT transcripts to speaker lines inline — NEVER as a PDF part", () => {
    const att: InlineTurnAttachment = {
      filename: "meeting.vtt",
      mimeType: "text/vtt",
      data: Buffer.from(
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nDania: The premium is $1,240 per year."
      )
    };
    const { textBlock, inlinePart } = buildAttachmentParts(att);
    expect(textBlock).toContain("Dania: The premium is $1,240 per year.");
    expect(textBlock).not.toContain("-->");
    expect(inlinePart).toBeNull();
  });

  it("rides PDFs along as inlineData", () => {
    const att: InlineTurnAttachment = {
      filename: "menu.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF")
    };
    const { textBlock, inlinePart } = buildAttachmentParts(att);
    expect(textBlock).toContain('The file "menu.pdf" is attached.');
    expect(inlinePart).toEqual({
      inlineData: { mimeType: "application/pdf", data: Buffer.from("%PDF").toString("base64") }
    });
  });
});

describe("runInlineChatTurn — plain turns", () => {
  it("returns the model text and meters the step", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("Hello owner"));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toEqual({ ok: true, content: "Hello owner", drafts: [] });
    expect(chatStep).toHaveBeenCalledTimes(1);
    expect(chatStep.mock.calls[0][0].contents[0].parts).toEqual([{ text: "[Dashboard] hello" }]);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "dashboard_chat" })
    );
  });

  it("defaults to a model that exists on the Gemini API (gemini-3.5-flash)", async () => {
    // Regression pin: the launch default was gemini-3.1-flash, an id that
    // does not exist on the API — every inline turn 404'd, silently
    // demoting text turns to the worker and hard-failing attachment turns.
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(baseArgs(), { chatStep });
    expect(chatStep.mock.calls[0][0].model).toBe("gemini-3.5-flash");
  });

  it("declares the knowledge tool by default and omits it when the toggle is off", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(baseArgs(), { chatStep });
    const declared = chatStep.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared).toContain("business_knowledge_lookup");

    const chatStep2 = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(baseArgs({ knowledgeToolEnabled: false }), { chatStep: chatStep2 });
    const declared2 = chatStep2.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared2).not.toContain("business_knowledge_lookup");
    expect(declared2).toEqual(["create_aiflow", "create_agent"]);
  });

  it("degrades to the fallback model when the configured model 404s, and stays there", async () => {
    process.env.DASHBOARD_CHAT_MODEL = "gemini-9.9-retired";
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockRejectedValueOnce(new Error("gemini_http_404:not found"))
      .mockResolvedValueOnce(toolStep("create_agent", { name: "A", instructions: "B" }))
      .mockResolvedValueOnce(textStep("Drafted."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toMatchObject({ ok: true, content: "Drafted." });
    expect(chatStep.mock.calls.map((c) => c[0].model)).toEqual([
      "gemini-9.9-retired",
      "gemini-3-flash-preview",
      // Later steps of the SAME turn keep the fallback — no re-404 per step.
      "gemini-3-flash-preview"
    ]);
    // Metering reflects the model that actually answered.
    expect(meter.mock.calls[0][0]).toMatchObject({ model: "gemini-3-flash-preview" });
  });

  it("does NOT retry when the fallback model itself 404s", async () => {
    process.env.DASHBOARD_CHAT_MODEL = "gemini-3-flash-preview";
    const chatStep = vi.fn(async () => {
      throw new Error("gemini_http_404:gone");
    });
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "gemini_http_404:gone" });
    expect(chatStep).toHaveBeenCalledTimes(1);
  });

  it("attaches text and PDF parts to the user turn", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("Read it"));
    await runInlineChatTurn(
      baseArgs({
        attachment: { filename: "a.csv", mimeType: "text/csv", data: Buffer.from("a,b") }
      }),
      { chatStep }
    );
    const parts = chatStep.mock.calls[0][0].contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toContain("a,b");

    const chatStep2 = vi.fn(async (_p: GeminiChatStepParams) => textStep("Read it"));
    await runInlineChatTurn(
      baseArgs({
        attachment: { filename: "a.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") }
      }),
      { chatStep: chatStep2 }
    );
    expect(chatStep2.mock.calls[0][0].contents[0].parts).toHaveLength(3);
  });

  it("fails without an API key", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await runInlineChatTurn(baseArgs(), { chatStep: vi.fn() });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "not_configured" });
  });

  it("accepts GEMINI_API_KEY and a configured model", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt";
    process.env.DASHBOARD_CHAT_MODEL = "gemini-custom";
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res.ok).toBe(true);
    expect(chatStep.mock.calls[0][0]).toMatchObject({ apiKey: "alt", model: "gemini-custom" });
  });

  it("classifies a thrown model step as model_failed", async () => {
    const chatStep = vi.fn(async () => {
      throw new Error("gemini_http_500:boom");
    });
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "gemini_http_500:boom" });
    expect(meter).not.toHaveBeenCalled();
  });

  it("tolerates a non-Error throw", async () => {
    const chatStep = vi.fn(async () => {
      throw "string failure";
    });
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "string failure" });
  });

  it("classifies an empty candidate (no text, no calls) as empty", async () => {
    const chatStep = vi.fn(
      async (): Promise<GeminiChatStepResult> => ({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: null
      })
    );
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toEqual({ ok: false, error: "empty" });
  });
});

describe("runInlineChatTurn — creation tools", () => {
  it("create_aiflow: compiles, collects the draft, and hands the wrap-up text back", async () => {
    const compileFlow = vi.fn(async () => ({
      ok: true as const,
      definition: VALID_DEFINITION,
      warnings: ["check step 2"]
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("create_aiflow", { description: "text every new lead" }))
      .mockResolvedValueOnce(textStep("Drafted! Open it in the builder."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, compileFlow });
    expect(res).toEqual({
      ok: true,
      content: "Drafted! Open it in the builder.",
      drafts: [{ kind: "aiflow", definition: VALID_DEFINITION, warnings: ["check step 2"] }]
    });
    expect(compileFlow).toHaveBeenCalledWith({ businessId: BIZ, description: "text every new lead" });
    // The second model step received the functionResponse turn.
    const secondContents = chatStep.mock.calls[1][0].contents;
    expect(secondContents).toHaveLength(3);
    expect(secondContents[2].parts[0]).toMatchObject({
      functionResponse: { name: "create_aiflow" }
    });
  });

  it("create_aiflow: surfaces a compile failure into the tool response", async () => {
    const compileFlow = vi.fn(async () => ({
      ok: false as const,
      error: "invalid" as const,
      message: "needs a tweak",
      issues: ["broken"]
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("create_aiflow", { description: "do things" }))
      .mockResolvedValueOnce(textStep("That draft needs a tweak."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, compileFlow });
    expect(res).toMatchObject({ ok: true, drafts: [] });
    const fr = chatStep.mock.calls[1][0].contents[2].parts[0] as {
      functionResponse: { response: { result: { ok: boolean; message: string } } };
    };
    expect(fr.functionResponse.response.result).toEqual({ ok: false, message: "needs a tweak" });
  });

  it("create_aiflow: survives a NON-Error thrown compile too", async () => {
    const compileFlow = vi.fn(async () => {
      throw "compile blew up";
    });
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("create_aiflow", { description: "spec" }))
      .mockResolvedValueOnce(textStep("Couldn't draft it."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, compileFlow });
    expect(res).toMatchObject({ ok: true, drafts: [] });
  });

  it("create_agent: rejects non-string name/instructions args", async () => {
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("create_agent", { name: 123, instructions: { x: 1 } }))
      .mockResolvedValueOnce(textStep("Missing fields."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toMatchObject({ ok: true, drafts: [] });
    const fr = chatStep.mock.calls[1][0].contents[2].parts[0] as {
      functionResponse: { response: { result: { ok: boolean } } };
    };
    expect(fr.functionResponse.response.result.ok).toBe(false);
  });

  it("create_aiflow: rejects a missing description and survives a thrown compile", async () => {
    const compileFlow = vi.fn(async () => {
      throw new Error("gemini down");
    });
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          { name: "create_aiflow", args: {} },
          { name: "create_aiflow", args: { description: "spec" } }
        ],
        modelContent: { role: "model", parts: [{ text: "" }] },
        usage: null
      })
      .mockResolvedValueOnce(textStep("Couldn't draft it."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, compileFlow });
    expect(res).toMatchObject({ ok: true, drafts: [] });
    const responses = chatStep.mock.calls[1][0].contents[2].parts as Array<{
      functionResponse: { response: { result: { ok: boolean } } };
    }>;
    expect(responses[0].functionResponse.response.result.ok).toBe(false);
    expect(responses[1].functionResponse.response.result.ok).toBe(false);
  });

  it("create_agent: collects the draft (clipped, format-defaulted) and rejects missing fields", async () => {
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          {
            name: "create_agent",
            args: { name: "Summarizer", instructions: "Summarize.", output_format: "same_as_input" }
          },
          { name: "create_agent", args: { name: "", instructions: "x" } },
          { name: "mystery_tool", args: {} }
        ],
        modelContent: { role: "model", parts: [{ text: "" }] },
        usage: null
      })
      .mockResolvedValueOnce(textStep("Agent drafted."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res).toMatchObject({
      ok: true,
      content: "Agent drafted.",
      drafts: [
        {
          kind: "agent",
          name: "Summarizer",
          instructions: "Summarize.",
          outputFormat: "same_as_input"
        }
      ]
    });
    const responses = chatStep.mock.calls[1][0].contents[2].parts as Array<{
      functionResponse: { name: string; response: { result: { ok: boolean; message?: string } } };
    }>;
    expect(responses[1].functionResponse.response.result.ok).toBe(false);
    expect(responses[2].functionResponse.response.result).toMatchObject({
      ok: false,
      message: "unknown tool: mystery_tool"
    });
  });

  it("falls back to a stock line when a draft exists but the wrap-up step was silent", async () => {
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(
        toolStep("create_agent", { name: "A", instructions: "B" })
      )
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: null
      });
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain("prepared a draft");
      expect(res.drafts).toHaveLength(1);
    }
  });

  it("keeps accumulated drafts when a LATER model step fails (compile spend is real)", async () => {
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("create_agent", { name: "A", instructions: "B" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.drafts).toHaveLength(1);
      expect(res.content).toContain("prepared a draft");
    }
  });

  it("bounds the tool loop at MAX_TOOL_STEPS", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) =>
      toolStep("create_agent", { name: "A", instructions: "B" })
    );
    const res = await runInlineChatTurn(baseArgs(), { chatStep });
    expect(chatStep).toHaveBeenCalledTimes(4);
    // Every bounded step created a draft; content falls back to the stock line.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.drafts).toHaveLength(4);
  });
});

describe("runInlineChatTurn — business_knowledge_lookup", () => {
  function knowledgeResponseOf(chatStep: ReturnType<typeof vi.fn>): unknown {
    const fr = chatStep.mock.calls[1][0].contents[2].parts[0] as {
      functionResponse: { name: string; response: { result: unknown } };
    };
    expect(fr.functionResponse.name).toBe("business_knowledge_lookup");
    return fr.functionResponse.response.result;
  }

  it("answers from the knowledge core (staff audience, clipped question)", async () => {
    const lookupKnowledge = vi.fn(async () => ({
      ok: true as const,
      data: { answer: "Renewals: we reach out 60 days before the term ends." }
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(
        toolStep("business_knowledge_lookup", { question: "  What is our renewal process?  " })
      )
      .mockResolvedValueOnce(textStep("Per your knowledge base: 60 days before term end."));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, lookupKnowledge });
    expect(res).toMatchObject({
      ok: true,
      content: "Per your knowledge base: 60 days before term end."
    });
    expect(lookupKnowledge).toHaveBeenCalledWith(BIZ, "What is our renewal process?", {
      audience: "staff"
    });
    expect(knowledgeResponseOf(chatStep)).toEqual({
      ok: true,
      answer: "Renewals: we reach out 60 days before the term ends."
    });
  });

  it("returns an honest do-not-invent message when the lookup reports failure", async () => {
    // Both failure shapes: ok:false, and the defensive ok:true-with-no-data.
    for (const result of [
      { ok: false as const, detail: "timeout" },
      { ok: true as const }
    ]) {
      vi.clearAllMocks();
      meter.mockResolvedValue(undefined);
      const lookupKnowledge = vi.fn(async () => result);
      const chatStep = vi
        .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
        .mockResolvedValueOnce(toolStep("business_knowledge_lookup", { question: "hours?" }))
        .mockResolvedValueOnce(textStep("I couldn't check the knowledge base just now."));
      const res = await runInlineChatTurn(baseArgs(), { chatStep, lookupKnowledge });
      expect(res.ok).toBe(true);
      expect(knowledgeResponseOf(chatStep)).toMatchObject({
        ok: false,
        message: expect.stringContaining("do NOT invent")
      });
    }
  });

  it("survives a thrown lookup (Error and non-Error alike)", async () => {
    for (const thrown of [new Error("db down"), "string blast"]) {
      vi.clearAllMocks();
      meter.mockResolvedValue(undefined);
      const lookupKnowledge = vi.fn(async () => {
        throw thrown;
      });
      const chatStep = vi
        .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
        .mockResolvedValueOnce(toolStep("business_knowledge_lookup", { question: "hours?" }))
        .mockResolvedValueOnce(textStep("Couldn't check right now."));
      const res = await runInlineChatTurn(baseArgs(), { chatStep, lookupKnowledge });
      expect(res.ok).toBe(true);
      expect(knowledgeResponseOf(chatStep)).toMatchObject({ ok: false });
    }
  });

  it("rejects a missing/non-string question without calling the core", async () => {
    const lookupKnowledge = vi.fn();
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("business_knowledge_lookup", { question: 42 }))
      .mockResolvedValueOnce(textStep("What would you like to know?"));
    const res = await runInlineChatTurn(baseArgs(), { chatStep, lookupKnowledge });
    expect(res.ok).toBe(true);
    expect(lookupKnowledge).not.toHaveBeenCalled();
    expect(knowledgeResponseOf(chatStep)).toEqual({ ok: false, message: "question is required" });
  });
});

describe("runInlineChatTurn — action tools (send_sms + calendar)", () => {
  const ALL_ON = {
    send_sms: true,
    send_whatsapp: false,
    calendar_find_slots: true,
    calendar_book_appointment: true,
    calendar_reschedule_appointment: true,
    calendar_cancel_appointment: true,
    list_aiflows: true,
    run_aiflow: true
  };

  it("declares gated action tools alongside the creation tools", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), { chatStep });
    const declared = chatStep.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared).toEqual([
      "create_aiflow",
      "create_agent",
      "business_knowledge_lookup",
      "send_sms",
      "calendar_find_slots",
      "calendar_book_appointment",
      "calendar_reschedule_appointment",
      "calendar_cancel_appointment",
      "list_aiflows",
      "run_aiflow"
    ]);
  });

  it("omits Settings-disabled action tools and declares none without gates", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(
      baseArgs({ actionToolGates: { ...ALL_ON, send_sms: false } }),
      { chatStep }
    );
    const declared = chatStep.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared).not.toContain("send_sms");
    expect(declared).toContain("calendar_find_slots");

    const chatStep2 = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(baseArgs(), { chatStep: chatStep2 });
    const declared2 = chatStep2.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared2).toEqual(["create_aiflow", "create_agent", "business_knowledge_lookup"]);
  });

  it("dispatches a declared action tool call to the executor and feeds the result back", async () => {
    const runActionTool = vi.fn(async () => ({
      ok: true,
      messageId: "msg-9",
      sentBody: "This is a test message."
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(
        toolStep("send_sms", { toE164: "+15145188192", body: "This is a test message." })
      )
      .mockResolvedValueOnce(textStep("Sent: \"This is a test message.\""));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res).toMatchObject({ ok: true, content: 'Sent: "This is a test message."' });
    expect(runActionTool).toHaveBeenCalledWith(BIZ, {
      name: "send_sms",
      args: { toE164: "+15145188192", body: "This is a test message." }
    });
    const fr = chatStep.mock.calls[1][0].contents[2].parts[0] as {
      functionResponse: { name: string; response: { result: { messageId: string } } };
    };
    expect(fr.functionResponse.name).toBe("send_sms");
    expect(fr.functionResponse.response.result.messageId).toBe("msg-9");
  });

  it("never bounces to the worker after a side-effecting tool ran — wrap-up FAILURE degrades to an honest line", async () => {
    // Bugbot High (PR #668): an inline failure after send_sms already ran
    // would re-enqueue the turn on the worker, which re-answers the same
    // owner message and could text/book AGAIN.
    const runActionTool = vi.fn(async () => ({
      ok: true,
      messageId: "msg-1",
      toE164: "+15145188192",
      sentBody: "This is a test message."
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("send_sms", { toE164: "+15145188192", body: "hi" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The degraded line carries the FACTS the lost wrap-up would have
      // relayed — recipient and exact body.
      expect(res.content).toContain("hit a hiccup writing my summary");
      expect(res.content).toContain('Text sent to +15145188192 — "This is a test message."');
    }
  });

  it("never bounces to the worker after a side-effecting tool ran — an EMPTY wrap-up degrades too", async () => {
    const runActionTool = vi.fn(async () => ({ ok: true }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(
        toolStep("calendar_cancel_appointment", { attendeePhone: "+15145188192" })
      )
      .mockResolvedValueOnce({ text: null, functionCalls: [], modelContent: null, usage: null });
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain("requested action went through");
      expect(res.content).toContain("The appointment was canceled.");
    }
  });

  it("preserves a Calendly reschedule/booking LINK in the degraded wrap-up", async () => {
    // Bugbot Medium (3rd round): reschedule_link_created succeeded but the
    // wrap-up died — the stored reply must still hand the owner the link.
    for (const [tool, resultData, needle] of [
      [
        "calendar_reschedule_appointment",
        { rescheduleLink: "https://calendly.com/r/abc" },
        "NOT moved until the attendee picks the new time): https://calendly.com/r/abc"
      ],
      [
        "calendar_book_appointment",
        { bookingLink: "https://calendly.com/b/xyz" },
        "NOT booked until the attendee completes it): https://calendly.com/b/xyz"
      ]
    ] as const) {
      const runActionTool = vi.fn(async () => ({ ok: true, data: resultData }));
      const chatStep = vi
        .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
        .mockResolvedValueOnce(
          toolStep(tool, {
            newStartIso: "2026-07-21T15:00:00-04:00",
            newEndIso: "2026-07-21T15:30:00-04:00",
            startIso: "2026-07-21T15:00:00-04:00",
            endIso: "2026-07-21T15:30:00-04:00",
            summary: "Call",
            attendeeName: "Uday"
          })
        )
        .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
      const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
        chatStep,
        runActionTool
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.content).toContain(needle);
    }
  });

  it("reports BOTH the draft hand-off and the side-effect notes when the wrap-up dies after both", async () => {
    // Bugbot Medium (4th round): draft-only fallback copy hid that a text
    // had also been sent in the same turn.
    const runActionTool = vi.fn(async () => ({
      ok: true,
      toE164: "+15145188192",
      sentBody: "hi"
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          { name: "create_agent", args: { name: "A", instructions: "B" } },
          { name: "send_sms", args: { toE164: "+15145188192", body: "hi" } }
        ],
        modelContent: { role: "model", parts: [{ text: "" }] },
        usage: null
      })
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.drafts).toHaveLength(1);
      expect(res.content).toContain("prepared a draft");
      expect(res.content).toContain("Also completed");
      expect(res.content).toContain('Text sent to +15145188192 — "hi"');
    }
  });

  it("uses the linkless note arms when book/reschedule succeed without links, and tolerates a linkless send result", async () => {
    for (const [tool, needle] of [
      ["calendar_book_appointment", "The appointment was booked."],
      ["calendar_reschedule_appointment", "The appointment was rescheduled."],
      ["send_sms", "Text sent to the recipient."],
      ["send_whatsapp", "WhatsApp message sent to the recipient."]
    ] as const) {
      const runActionTool = vi.fn(async () => ({ ok: true }));
      const chatStep = vi
        .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
        .mockResolvedValueOnce(toolStep(tool, {}))
        .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
      const res = await runInlineChatTurn(
        baseArgs({ actionToolGates: { ...ALL_ON, send_whatsapp: true } }),
        {
          chatStep,
          runActionTool
        }
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.content).toContain(needle);
    }
  });

  it("carries the WhatsApp side-effect note (recipient + body) through a degraded wrap-up", async () => {
    const runActionTool = vi.fn(async () => ({
      ok: true,
      toE164: "+15145188192",
      sentBody: "hola"
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("send_whatsapp", { toE164: "+15145188192", body: "hola" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(
      baseArgs({ actionToolGates: { ...ALL_ON, send_whatsapp: true } }),
      { chatStep, runActionTool }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('WhatsApp message sent to +15145188192 — "hola"');
    }
  });

  it("a pure READ tool (calendar_find_slots) does NOT suppress the worker fallback", async () => {
    const runActionTool = vi.fn(async () => ({ ok: true, data: { slots: [] } }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("calendar_find_slots", {}))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    // Nothing irreversible happened — the worker fallback stays available.
    expect(res).toEqual({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_500:wrap-up died"
    });
  });

  it("a successful run_aiflow is side-effect pinned — wrap-up failure keeps ok:true with the flow note", async () => {
    // Bugbot High (PR #687): an enqueued automation run is committed; a
    // fallback rerun would enqueue the same flow twice.
    const runActionTool = vi.fn(async () => ({
      ok: true,
      runId: "run-9",
      flowName: "Proposal send + follow-up"
    }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("run_aiflow", { flow: "Proposal" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('Automation run started ("Proposal send + follow-up")');
    }

    // Nameless result (defensive arm): the note still lands, without quotes.
    const namelessTool = vi.fn(async () => ({ ok: true, runId: "run-10" }));
    const chatStep2 = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("run_aiflow", { flow: "Proposal" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res2 = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep: chatStep2,
      runActionTool: namelessTool
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.content).toContain("Automation run started — it can be watched");
  });

  it("stops starting new steps once budgetMs is exhausted — fails fast when nothing committed", async () => {
    // Bugbot High (PR #687): a slow turn must not keep committing tools
    // after the SMS worker's own timeout already fell back to Rowboat.
    const runActionTool = vi.fn(async () => ({ ok: true, data: { slots: [] } }));
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => {
      await new Promise((r) => setTimeout(r, 10));
      return toolStep("calendar_find_slots", {});
    });
    const res = await runInlineChatTurn(
      baseArgs({ actionToolGates: ALL_ON, budgetMs: 5 }),
      { chatStep, runActionTool }
    );
    expect(res).toEqual({ ok: false, error: "model_failed", detail: "budget_exhausted" });
    // Only the first step ran; the second was refused by the budget check.
    expect(chatStep).toHaveBeenCalledTimes(1);
  });

  it("budget exhaustion AFTER a committed side effect degrades to the honest ok:true line", async () => {
    const runActionTool = vi.fn(async () => ({ ok: true, messageId: "m1", toE164: "+15145188192" }));
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => {
      await new Promise((r) => setTimeout(r, 10));
      return toolStep("send_sms", { toE164: "+15145188192", body: "hi" });
    });
    const res = await runInlineChatTurn(
      baseArgs({ actionToolGates: ALL_ON, budgetMs: 5 }),
      { chatStep, runActionTool }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toContain("Text sent to +15145188192");
    expect(chatStep).toHaveBeenCalledTimes(1);
  });

  it("omits the creation tools when includeCreationTools is false (no builder UI on the surface)", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    await runInlineChatTurn(
      baseArgs({ actionToolGates: ALL_ON, includeCreationTools: false }),
      { chatStep }
    );
    const declared = chatStep.mock.calls[0][0].tools.map((t) => t.name);
    expect(declared).not.toContain("create_aiflow");
    expect(declared).not.toContain("create_agent");
    expect(declared).toContain("business_knowledge_lookup");
    expect(declared).toContain("send_sms");
  });

  it("a FAILED side-effect tool (ok:false) does NOT suppress the worker fallback either", async () => {
    // Bugbot Medium (2nd round): a cleanly-refused send (opt-out, quota,
    // validation) committed nothing — pinning the turn would suppress a
    // legitimate fallback AND let the degraded copy imply a send happened.
    const runActionTool = vi.fn(async () => ({ ok: false, message: "recipient_opted_out" }));
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("send_sms", { toE164: "+15145188192", body: "hi" }))
      .mockRejectedValueOnce(new Error("gemini_http_500:wrap-up died"));
    const res = await runInlineChatTurn(baseArgs({ actionToolGates: ALL_ON }), {
      chatStep,
      runActionTool
    });
    expect(res).toEqual({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_500:wrap-up died"
    });
  });

  it("fails CLOSED on an action tool the model calls but that was not declared", async () => {
    const runActionTool = vi.fn();
    const chatStep = vi
      .fn<(p: GeminiChatStepParams) => Promise<GeminiChatStepResult>>()
      .mockResolvedValueOnce(toolStep("send_sms", { toE164: "+15145188192", body: "hi" }))
      .mockResolvedValueOnce(textStep("I can't send texts right now."));
    // Gates present but send_sms OFF — a hallucinated call must not execute.
    const res = await runInlineChatTurn(
      baseArgs({ actionToolGates: { ...ALL_ON, send_sms: false } }),
      { chatStep, runActionTool }
    );
    expect(res.ok).toBe(true);
    expect(runActionTool).not.toHaveBeenCalled();
    const fr = chatStep.mock.calls[1][0].contents[2].parts[0] as {
      functionResponse: { response: { result: { ok: boolean; message: string } } };
    };
    expect(fr.functionResponse.response.result).toEqual({
      ok: false,
      message: "unknown tool: send_sms"
    });
  });
});
