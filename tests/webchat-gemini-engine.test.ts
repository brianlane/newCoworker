import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWebchatGeminiTurn,
  splitWebchatJobInput,
  webchatEngineModel,
  WEBCHAT_ENGINE_DEFAULT_MODEL,
  WEBCHAT_ENGINE_MAX_TOOL_ROUNDS,
  WEBCHAT_ENGINE_OVER_CAP_REFUSAL,
  WEBCHAT_ENGINE_TURN_TIMEOUT_MS,
  type WebchatGeminiTurnDeps,
  type WebchatJobInputMessage
} from "@/lib/webchat/gemini-engine";
import { buildAgentInstructions } from "@/lib/vps/sync-vault";
import { customerLanguageLine } from "@/lib/i18n/customer-language";
import { WEBCHAT_TOOL_DECLARATIONS } from "@/lib/webchat/engine-tools";
import type { GeminiChatStepResult } from "@/lib/gemini-chat";
import type { ConfigRow } from "@/lib/db/configs";
import type { ChatSpendSnapshot } from "@/lib/db/chat-usage";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONFIG: ConfigRow = {
  business_id: BIZ,
  soul_md: "# soul\nBe warm.",
  identity_md: "# identity\nNew Coworker.",
  memory_md: "# memory\nStandard is $99/mo on 24-month.",
  website_md: "# website\nAI coworker platform.",
  profile_md: "# profile\nOpen 9-5.",
  updated_at: "2026-07-14T00:00:00Z"
};

const SNAPSHOT_UNDER: ChatSpendSnapshot = {
  periodStart: "2026-07-01T00:00:00.000Z",
  spendMicros: 1_000,
  baseCapMicros: 10_000_000,
  creditMicros: 50_000_000,
  effectiveCapMicros: 60_000_000
};

const INPUT: WebchatJobInputMessage[] = [
  { role: "system", content: "WEBSITE CHAT MODE — READ FIRST ..." },
  { role: "system", content: "Current date/time: Tuesday, July 14, 2026" },
  { role: "user", content: "[Webchat] How much is the Standard plan?" }
];

function textStep(text: string, usage = { promptTokens: 100, outputTokens: 20 }): GeminiChatStepResult {
  return { text, functionCalls: [], modelContent: { role: "model", parts: [{ text }] }, usage };
}

function toolStep(name: string, args: Record<string, unknown>): GeminiChatStepResult {
  return {
    text: null,
    functionCalls: [{ name, args }],
    modelContent: { role: "model", parts: [{ functionCall: { name, args } }] },
    usage: { promptTokens: 50, outputTokens: 10 }
  };
}

function makeDeps(overrides: Partial<WebchatGeminiTurnDeps> = {}): Required<
  Pick<
    WebchatGeminiTurnDeps,
    | "fetchConfig"
    | "fetchDocuments"
    | "getSpendSnapshot"
    | "chatStep"
    | "executeTool"
    | "meter"
    | "env"
    | "now"
  >
> {
  return {
    fetchConfig: vi.fn(async () => CONFIG),
    fetchDocuments: vi.fn(async () => []),
    getSpendSnapshot: vi.fn(async () => SNAPSHOT_UNDER),
    chatStep: vi.fn(async () => textStep("The Standard plan is $99/mo on a 24-month contract.")),
    executeTool: vi.fn(async () => ({ ok: true, data: { answer: "$99/mo" } })),
    meter: vi.fn(async () => undefined),
    env: { GOOGLE_API_KEY: "k" },
    now: () => new Date("2026-07-14T16:00:00Z"),
    ...overrides
  };
}

const ARGS = { businessId: BIZ, inputMessages: INPUT, tier: "enterprise" as const };

afterEach(() => {
  vi.useRealTimers();
});

describe("splitWebchatJobInput", () => {
  it("separates system blocks from the user turn, last user wins", () => {
    const { systemBlocks, userTurn } = splitWebchatJobInput([
      { role: "system", content: "A" },
      { role: "system", content: "   " },
      { role: "assistant", content: "ignored" },
      null as unknown as WebchatJobInputMessage,
      { role: "user", content: 42 as unknown as string },
      { role: "user", content: "first" },
      { role: "user", content: "[Webchat] second" }
    ]);
    expect(systemBlocks).toEqual(["A"]);
    expect(userTurn).toBe("[Webchat] second");
  });

  it("returns null userTurn when no user row exists", () => {
    expect(splitWebchatJobInput([{ role: "system", content: "A" }]).userTurn).toBeNull();
  });
});

describe("webchatEngineModel", () => {
  it("defaults to the box path's SMS chat model", () => {
    expect(webchatEngineModel({})).toBe(WEBCHAT_ENGINE_DEFAULT_MODEL);
    expect(webchatEngineModel({ WEBCHAT_GEMINI_ENGINE_MODEL: "   " })).toBe(
      WEBCHAT_ENGINE_DEFAULT_MODEL
    );
  });

  it("honors the env override", () => {
    expect(webchatEngineModel({ WEBCHAT_GEMINI_ENGINE_MODEL: "gemini-3-flash" })).toBe(
      "gemini-3-flash"
    );
  });
});

describe("runWebchatGeminiTurn", () => {
  it("throws webchat_engine_no_key without a Google key (GEMINI_API_KEY accepted)", async () => {
    const deps = makeDeps({ env: {} });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_key");

    const alt = makeDeps({ env: { GEMINI_API_KEY: "alt" } });
    const res = await runWebchatGeminiTurn(ARGS, alt);
    expect(res.reply).toContain("$99");
    expect(vi.mocked(alt.chatStep).mock.calls[0][0].apiKey).toBe("alt");
  });

  it("throws webchat_engine_no_input when the job has no (non-blank) user turn", async () => {
    const deps = makeDeps();
    await expect(
      runWebchatGeminiTurn(
        { ...ARGS, inputMessages: [{ role: "system", content: "A" }] },
        deps
      )
    ).rejects.toThrow("webchat_engine_no_input");
    await expect(
      runWebchatGeminiTurn(
        { ...ARGS, inputMessages: [{ role: "user", content: "   " }] },
        deps
      )
    ).rejects.toThrow("webchat_engine_no_input");
    expect(deps.chatStep).not.toHaveBeenCalled();
  });

  it("refuses over-cap turns with the worker's copy, without calling Google or metering", async () => {
    const deps = makeDeps({
      getSpendSnapshot: vi.fn(async () => ({
        ...SNAPSHOT_UNDER,
        spendMicros: SNAPSHOT_UNDER.effectiveCapMicros
      }))
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res).toEqual({
      reply: WEBCHAT_ENGINE_OVER_CAP_REFUSAL,
      refusedOverCap: true,
      toolRounds: 0,
      model: WEBCHAT_ENGINE_DEFAULT_MODEL,
      usage: null,
      costMicros: 0
    });
    expect(deps.chatStep).not.toHaveBeenCalled();
    expect(deps.meter).not.toHaveBeenCalled();
    expect(deps.getSpendSnapshot).toHaveBeenCalledWith(BIZ, "enterprise");
  });

  it("grounds the system instruction with the vault instructions then the job's system blocks", async () => {
    const deps = makeDeps();
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res).toEqual({
      reply: "The Standard plan is $99/mo on a 24-month contract.",
      refusedOverCap: false,
      toolRounds: 0,
      model: WEBCHAT_ENGINE_DEFAULT_MODEL,
      usage: { promptTokens: 100, outputTokens: 20 },
      // Same math the meter records: 100 * $0.1/1M + 20 * $0.4/1M in micros.
      costMicros: 18
    });

    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    const expectedInstructions = buildAgentInstructions(CONFIG, "");
    expect(step.systemInstruction).toBe(
      [expectedInstructions, customerLanguageLine({ defaultLang: "en" }), INPUT[0].content, INPUT[1].content]
        .filter(Boolean)
        .join("\n\n")
    );
    // Vault field order parity with deploy-client.sh: identity → profile →
    // soul → website → memory (documents digest empty here).
    expect(expectedInstructions.indexOf("# identity")).toBeLessThan(
      expectedInstructions.indexOf("# profile")
    );
    expect(expectedInstructions.indexOf("# profile")).toBeLessThan(
      expectedInstructions.indexOf("# soul")
    );
    expect(expectedInstructions.indexOf("# soul")).toBeLessThan(
      expectedInstructions.indexOf("# website")
    );
    expect(expectedInstructions.indexOf("# website")).toBeLessThan(
      expectedInstructions.indexOf("# memory")
    );
    expect(step.contents).toEqual([
      { role: "user", parts: [{ text: "[Webchat] How much is the Standard plan?" }] }
    ]);
    expect(step.tools).toBe(WEBCHAT_TOOL_DECLARATIONS);
    expect(step.model).toBe(WEBCHAT_ENGINE_DEFAULT_MODEL);

    // One meter call with the exact billed tokens.
    expect(deps.meter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.meter).mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: WEBCHAT_ENGINE_DEFAULT_MODEL,
      surface: "webchat_gemini_engine",
      usage: { promptTokens: 100, outputTokens: 20 }
    });
  });

  it("falls back to the default-persona instructions when the config row is missing", async () => {
    const deps = makeDeps({ fetchConfig: vi.fn(async () => null) });
    await runWebchatGeminiTurn(ARGS, deps);
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("You are a professional AI coworker.");
  });

  it("continues without the documents digest when the list read fails", async () => {
    const deps = makeDeps({ fetchDocuments: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res.reply).toContain("$99");

    // Non-Error rejection shapes (libraries throwing strings) log safely too.
    const stringy = makeDeps({ fetchDocuments: vi.fn(async () => Promise.reject("plain refusal")) });
    const res2 = await runWebchatGeminiTurn(ARGS, stringy);
    expect(res2.reply).toContain("$99");
  });

  it("runs a tool round: executes the call, feeds the result back, aggregates usage", async () => {
    const deps = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce(toolStep("webchat_business_knowledge_lookup", { question: "price?" }))
        .mockResolvedValueOnce(textStep("It is $99/mo.", { promptTokens: 200, outputTokens: 30 }))
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res).toEqual({
      reply: "It is $99/mo.",
      refusedOverCap: false,
      toolRounds: 1,
      model: WEBCHAT_ENGINE_DEFAULT_MODEL,
      usage: { promptTokens: 250, outputTokens: 40 },
      // 250 * $0.1/1M + 40 * $0.4/1M in micros.
      costMicros: 41
    });

    expect(deps.executeTool).toHaveBeenCalledWith(BIZ, "webchat_business_knowledge_lookup", {
      question: "price?"
    });
    // Second step carries: user turn, model functionCall echo, functionResponse.
    const second = vi.mocked(deps.chatStep).mock.calls[1][0];
    expect(second.contents).toHaveLength(3);
    expect(second.contents[1].role).toBe("model");
    expect(second.contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "webchat_business_knowledge_lookup",
            response: { result: { ok: true, data: { answer: "$99/mo" } } }
          }
        }
      ]
    });
    // 50+200 prompt, 10+30 output.
    expect(vi.mocked(deps.meter).mock.calls[0][0].usage).toEqual({
      promptTokens: 250,
      outputTokens: 40
    });
  });

  it("feeds a structured failure to the model when a tool handler throws", async () => {
    const deps = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce(toolStep("webchat_capture_lead", { name: "Ann" }))
        .mockResolvedValueOnce(textStep("Saved your details.")),
      executeTool: vi.fn(async () => {
        throw new Error("core exploded");
      })
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res.reply).toBe("Saved your details.");
    const second = vi.mocked(deps.chatStep).mock.calls[1][0];
    expect(second.contents[2].parts[0]).toEqual({
      functionResponse: {
        name: "webchat_capture_lead",
        response: { result: { ok: false, detail: "internal_error" } }
      }
    });

    // Non-Error throw shapes log safely and degrade the same way.
    const stringy = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce(toolStep("webchat_capture_lead", { name: "Ann" }))
        .mockResolvedValueOnce(textStep("Noted.")),
      executeTool: vi.fn(async () => {
        throw "plain string failure";
      })
    });
    expect((await runWebchatGeminiTurn(ARGS, stringy)).reply).toBe("Noted.");
  });

  it("withholds tools on the final round so the model must answer in text", async () => {
    const always = toolStep("webchat_business_knowledge_lookup", { question: "q" });
    const deps = makeDeps({
      chatStep: vi.fn(async (params) =>
        params.tools.length === 0 ? textStep("Final answer.") : always
      )
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res.reply).toBe("Final answer.");
    expect(res.toolRounds).toBe(WEBCHAT_ENGINE_MAX_TOOL_ROUNDS);
    expect(deps.chatStep).toHaveBeenCalledTimes(WEBCHAT_ENGINE_MAX_TOOL_ROUNDS + 1);
    const finalCall = vi.mocked(deps.chatStep).mock.calls[WEBCHAT_ENGINE_MAX_TOOL_ROUNDS][0];
    expect(finalCall.tools).toEqual([]);
  });

  it("throws webchat_engine_no_reply when the final round still produces no text — after metering", async () => {
    const always = toolStep("webchat_business_knowledge_lookup", { question: "q" });
    const deps = makeDeps({ chatStep: vi.fn(async () => always) });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_reply");
    // 5 steps billed 50/10 each — metering still ran in the failure path.
    expect(vi.mocked(deps.meter).mock.calls[0][0].usage).toEqual({
      promptTokens: 250,
      outputTokens: 50
    });
  });

  it("throws webchat_engine_no_reply on an empty step (no text, no calls)", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: { promptTokens: 5, outputTokens: 0 }
      }))
    });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_reply");
    expect(deps.meter).toHaveBeenCalledTimes(1);
  });

  it("skips a functionCalls step whose modelContent is missing (cannot echo history)", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: null,
        functionCalls: [{ name: "webchat_capture_lead", args: {} }],
        modelContent: null,
        usage: null
      }))
    });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_reply");
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it("meters with the chars estimate when no step reported usage", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: "Answer.",
        functionCalls: [],
        modelContent: { role: "model" as const, parts: [{ text: "Answer." }] },
        usage: null
      }))
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    const call = vi.mocked(deps.meter).mock.calls[0][0];
    expect(call.usage).toBeNull();
    expect(call.outputChars).toBe("Answer.".length);
    expect(call.inputChars).toBeGreaterThan(0);
    // The returned stats mirror the estimate path too: no usage, but a
    // positive chars-derived cost for the per-conversation ledger.
    expect(res.usage).toBeNull();
    expect(res.costMicros).toBeGreaterThan(0);
  });

  it("meters on a tool-round-only failure even with zero output chars", async () => {
    const deps = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce({
          ...toolStep("webchat_capture_lead", {}),
          usage: null
        })
        .mockResolvedValueOnce({ text: null, functionCalls: [], modelContent: null, usage: null })
    });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_reply");
    expect(deps.meter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.meter).mock.calls[0][0].usage).toBeNull();
  });

  it("does not meter when nothing was plausibly billed", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: null
      }))
    });
    await expect(runWebchatGeminiTurn(ARGS, deps)).rejects.toThrow("webchat_engine_no_reply");
    expect(deps.meter).not.toHaveBeenCalled();
  });

  it("does not meter zero-token usage reports", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () =>
        textStep("Free answer?", { promptTokens: 0, outputTokens: 0 })
      )
    });
    const res = await runWebchatGeminiTurn(ARGS, deps);
    expect(res.reply).toBe("Free answer?");
    expect(deps.meter).not.toHaveBeenCalled();
  });

  it("aborts a hung step at the turn deadline", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      chatStep: vi.fn(
        ({ signal }) =>
          new Promise<GeminiChatStepResult>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("gemini_aborted")));
          })
      )
    });
    const pending = runWebchatGeminiTurn(ARGS, deps);
    const assertion = expect(pending).rejects.toThrow("gemini_aborted");
    await vi.advanceTimersByTimeAsync(WEBCHAT_ENGINE_TURN_TIMEOUT_MS + 1);
    await assertion;
    expect(deps.meter).not.toHaveBeenCalled();
  });

  it("exports the worker-parity visitor copy", () => {
    expect(WEBCHAT_ENGINE_OVER_CAP_REFUSAL).toContain("temporarily unavailable");
  });
});
