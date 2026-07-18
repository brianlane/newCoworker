/**
 * Tests for the Messenger/Instagram DM Gemini engine
 * (src/lib/messenger/engine.ts): history→contents mapping, the channel
 * preamble, budget refusal, grounding, tool rounds, metering, and the
 * turn deadline — structural parity with the webchat engine suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMessengerContents,
  buildMessengerPreamble,
  messengerEngineModel,
  MESSENGER_ENGINE_DEFAULT_MODEL,
  MESSENGER_ENGINE_HISTORY_LIMIT,
  MESSENGER_ENGINE_MAX_TOOL_ROUNDS,
  MESSENGER_ENGINE_OVER_CAP_REFUSAL,
  MESSENGER_ENGINE_TURN_TIMEOUT_MS,
  messengerOverCapRefusal,
  runMessengerGeminiTurn,
  type MessengerGeminiTurnDeps
} from "@/lib/messenger/engine";
import { buildAgentInstructions } from "@/lib/vps/sync-vault";
import { customerLanguageLine } from "@/lib/i18n/customer-language";
import { WEBCHAT_TOOL_DECLARATIONS } from "@/lib/webchat/engine-tools";
import type { GeminiChatStepResult } from "@/lib/gemini-chat";
import type {
  MessengerConversationRow,
  MessengerMessageRow
} from "@/lib/messenger/db";
import type { ConfigRow } from "@/lib/db/configs";
import type { ChatSpendSnapshot } from "@/lib/db/chat-usage";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";

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

const CONVERSATION: MessengerConversationRow = {
  id: CONV_ID,
  business_id: BIZ,
  page_id: "p1",
  platform: "messenger",
  psid: "psid-1",
  display_name: "Jane Doe",
  contact_phone: null,
  status: "active",
  last_user_message_at: "2026-07-15T20:00:00Z",
  created_at: "2026-07-15T19:00:00Z",
  updated_at: "2026-07-15T20:00:00Z"
};

function msg(
  id: number,
  role: MessengerMessageRow["role"],
  content: string
): MessengerMessageRow {
  return {
    id,
    conversation_id: CONV_ID,
    business_id: BIZ,
    role,
    content,
    mid: role === "user" ? `m-${id}` : null,
    created_at: "2026-07-15T20:00:00Z"
  };
}

const HISTORY = [msg(1, "user", "Hi! How much is the Standard plan?")];

function textStep(
  text: string,
  usage = { promptTokens: 100, outputTokens: 20 }
): GeminiChatStepResult {
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

function makeDeps(overrides: Partial<MessengerGeminiTurnDeps> = {}): Required<
  Pick<
    MessengerGeminiTurnDeps,
    | "fetchConfig"
    | "fetchDocuments"
    | "getSpendSnapshot"
    | "chatStep"
    | "executeTool"
    | "meter"
    | "env"
    | "now"
    | "getCustomerLanguages"
    | "persistConversationLanguage"
    | "fetchContactLanguage"
  >
> {
  return {
    fetchConfig: vi.fn(async () => CONFIG),
    fetchDocuments: vi.fn(async () => []),
    getSpendSnapshot: vi.fn(async () => SNAPSHOT_UNDER),
    chatStep: vi.fn(async () => textStep("Standard is $99/mo on a 24-month plan.")),
    executeTool: vi.fn(async () => ({ ok: true, data: { answer: "$99/mo" } })),
    meter: vi.fn(async () => undefined),
    env: { GOOGLE_API_KEY: "k" },
    now: () => new Date("2026-07-15T20:05:00Z"),
    getCustomerLanguages: vi.fn(async () => ({
      defaultLanguage: "en" as const,
      supported: ["en" as const, "es" as const]
    })),
    persistConversationLanguage: vi.fn(async () => undefined),
    fetchContactLanguage: vi.fn(async () => ({
      preferred_language: null,
      language_source: null
    })),
    ...overrides
  };
}

const ARGS = {
  businessId: BIZ,
  conversation: CONVERSATION,
  history: HISTORY,
  tier: "standard" as const
};

afterEach(() => {
  vi.useRealTimers();
});

describe("buildMessengerPreamble", () => {
  it("carries platform, name, the conversation ref, and the datetime", () => {
    const preamble = buildMessengerPreamble(CONVERSATION, new Date("2026-07-15T20:05:00Z"));
    expect(preamble).toContain("Facebook Messenger");
    expect(preamble).toContain("Jane Doe");
    expect(preamble).toContain(`sessionRef (pass verbatim to capture_lead): ${CONV_ID}`);
    expect(preamble).toContain("2026-07-15T20:05:00.000Z");
  });

  it("handles unknown names and the instagram platform label", () => {
    const preamble = buildMessengerPreamble(
      { ...CONVERSATION, platform: "instagram", display_name: null },
      new Date()
    );
    expect(preamble).toContain("Instagram Direct Messages");
    expect(preamble).toContain("name is not known yet");
  });
});

describe("buildMessengerContents", () => {
  it("maps roles (owner and assistant both read as model) ending on the user turn", () => {
    const contents = buildMessengerContents([
      msg(1, "user", "Hi"),
      msg(2, "assistant", "Hello! How can I help?"),
      msg(3, "owner", "James here, happy to help too."),
      msg(4, "user", "What are your prices?")
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello! How can I help?" }] },
      { role: "model", parts: [{ text: "James here, happy to help too." }] },
      { role: "user", parts: [{ text: "What are your prices?" }] }
    ]);
  });

  it("returns null when there is no user turn, no rows, or a trailing model row", () => {
    expect(buildMessengerContents([])).toBeNull();
    expect(buildMessengerContents([msg(1, "assistant", "hello")])).toBeNull();
    expect(buildMessengerContents([msg(1, "user", "   ")])).toBeNull();
    expect(
      buildMessengerContents([msg(1, "user", "Hi"), msg(2, "owner", "Handled it myself")])
    ).toBeNull();
  });

  it("caps the window at the history limit", () => {
    const rows = Array.from({ length: MESSENGER_ENGINE_HISTORY_LIMIT + 10 }, (_, i) =>
      msg(i + 1, "user", `message ${i + 1}`)
    );
    const contents = buildMessengerContents(rows);
    expect(contents).toHaveLength(MESSENGER_ENGINE_HISTORY_LIMIT);
    expect(contents?.[0].parts[0].text).toBe("message 11");
  });
});

describe("messengerEngineModel", () => {
  it("defaults and honors the env override", () => {
    expect(messengerEngineModel({})).toBe(MESSENGER_ENGINE_DEFAULT_MODEL);
    expect(messengerEngineModel({ MESSENGER_GEMINI_ENGINE_MODEL: "  " })).toBe(
      MESSENGER_ENGINE_DEFAULT_MODEL
    );
    expect(messengerEngineModel({ MESSENGER_GEMINI_ENGINE_MODEL: "gemini-3-flash" })).toBe(
      "gemini-3-flash"
    );
  });
});

describe("runMessengerGeminiTurn", () => {
  it("throws messenger_engine_no_key without a Google key (GEMINI_API_KEY accepted)", async () => {
    const deps = makeDeps({ env: {} });
    await expect(runMessengerGeminiTurn(ARGS, deps)).rejects.toThrow(
      "messenger_engine_no_key"
    );

    const alt = makeDeps({ env: { GEMINI_API_KEY: "alt" } });
    const res = await runMessengerGeminiTurn(ARGS, alt);
    expect(res.reply).toContain("$99");
    expect(vi.mocked(alt.chatStep).mock.calls[0][0].apiKey).toBe("alt");
  });

  it("throws messenger_engine_no_input when the window has no unanswered user turn", async () => {
    const deps = makeDeps();
    await expect(
      runMessengerGeminiTurn({ ...ARGS, history: [msg(1, "assistant", "hello")] }, deps)
    ).rejects.toThrow("messenger_engine_no_input");
    expect(deps.chatStep).not.toHaveBeenCalled();
  });

  it("refuses over-cap turns without calling Google or metering", async () => {
    const deps = makeDeps({
      getSpendSnapshot: vi.fn(async () => ({
        ...SNAPSHOT_UNDER,
        spendMicros: SNAPSHOT_UNDER.effectiveCapMicros
      }))
    });
    const res = await runMessengerGeminiTurn(ARGS, deps);
    expect(res).toEqual({
      reply: MESSENGER_ENGINE_OVER_CAP_REFUSAL,
      refusedOverCap: true,
      toolRounds: 0
    });
    expect(deps.chatStep).not.toHaveBeenCalled();
    expect(deps.meter).not.toHaveBeenCalled();
    expect(deps.getSpendSnapshot).toHaveBeenCalledWith(BIZ, "standard");
  });

  it("speaks the over-cap refusal in the thread's stored language", async () => {
    const deps = makeDeps({
      getSpendSnapshot: vi.fn(async () => ({
        ...SNAPSHOT_UNDER,
        spendMicros: SNAPSHOT_UNDER.effectiveCapMicros
      }))
    });
    const res = await runMessengerGeminiTurn(
      { ...ARGS, conversation: { ...CONVERSATION, preferred_language: "es" } },
      deps
    );
    expect(res.refusedOverCap).toBe(true);
    expect(res.reply).toBe(messengerOverCapRefusal("es"));
    expect(res.reply).toContain("asistente de chat");
  });

  it("grounds the system instruction with the vault instructions then the preamble", async () => {
    const deps = makeDeps();
    const res = await runMessengerGeminiTurn(ARGS, deps);
    expect(res).toEqual({
      reply: "Standard is $99/mo on a 24-month plan.",
      refusedOverCap: false,
      toolRounds: 0
    });

    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    const expectedInstructions = buildAgentInstructions(CONFIG, "");
    expect(step.systemInstruction).toBe(
      [
        expectedInstructions,
        customerLanguageLine({ defaultLang: "en" }),
        buildMessengerPreamble(CONVERSATION, new Date("2026-07-15T20:05:00Z"))
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    expect(step.contents).toEqual([
      { role: "user", parts: [{ text: "Hi! How much is the Standard plan?" }] }
    ]);
    expect(step.tools).toBe(WEBCHAT_TOOL_DECLARATIONS);
    expect(step.model).toBe(MESSENGER_ENGINE_DEFAULT_MODEL);

    expect(deps.meter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.meter).mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      model: MESSENGER_ENGINE_DEFAULT_MODEL,
      surface: "messenger_gemini_engine",
      usage: { promptTokens: 100, outputTokens: 20 }
    });
  });

  it("persists a confident Spanish detection and injects it as the thread language", async () => {
    const spanishHistory = [
      msg(1, "user", "Hola, quiero hacer una cita para el viernes por favor")
    ];
    const deps = makeDeps();
    await runMessengerGeminiTurn({ ...ARGS, history: spanishHistory }, deps);
    expect(deps.persistConversationLanguage).toHaveBeenCalledWith(CONV_ID, "es");
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("Current conversation language: es.");
  });

  it("does not re-persist when the thread language already matches", async () => {
    const spanishHistory = [msg(1, "user", "Quiero cambiar mi cita para el martes")];
    const deps = makeDeps();
    await runMessengerGeminiTurn(
      {
        ...ARGS,
        conversation: { ...CONVERSATION, preferred_language: "es" },
        history: spanishHistory
      },
      deps
    );
    expect(deps.persistConversationLanguage).not.toHaveBeenCalled();
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("Current conversation language: es.");
  });

  it("owner-set contact language is authoritative once a phone is captured", async () => {
    const deps = makeDeps({
      fetchContactLanguage: vi.fn(async () => ({
        preferred_language: "es" as const,
        language_source: "owner_set" as const
      }))
    });
    await runMessengerGeminiTurn(
      { ...ARGS, conversation: { ...CONVERSATION, contact_phone: "+16025550100" } },
      deps
    );
    expect(deps.fetchContactLanguage).toHaveBeenCalledWith(BIZ, "+16025550100");
    // Detection must not overwrite the override at the conversation level.
    expect(deps.persistConversationLanguage).not.toHaveBeenCalled();
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("Current conversation language: es.");
  });

  it("non-owner-set contact rows do not override, and read failures are best-effort", async () => {
    const deps = makeDeps({
      fetchContactLanguage: vi.fn(async () => ({
        preferred_language: "es" as const,
        language_source: "detected" as const
      }))
    });
    await runMessengerGeminiTurn(
      { ...ARGS, conversation: { ...CONVERSATION, contact_phone: "+16025550100" } },
      deps
    );
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).not.toContain("Current conversation language: es.");

    const failing = makeDeps({
      fetchContactLanguage: vi.fn(async () => Promise.reject(new Error("db down")))
    });
    expect(
      (
        await runMessengerGeminiTurn(
          { ...ARGS, conversation: { ...CONVERSATION, contact_phone: "+16025550100" } },
          failing
        )
      ).reply
    ).toContain("$99");
  });

  it("follows a confident mid-thread language switch over the stored thread language", async () => {
    const switchedHistory = [
      msg(1, "user", "Hi, do you have anything available Friday?"),
      msg(2, "assistant", "Yes, we have openings Friday."),
      msg(3, "user", "Perfecto, quiero cambiar mi cita para el viernes por favor")
    ];
    const deps = makeDeps();
    await runMessengerGeminiTurn(
      {
        ...ARGS,
        conversation: { ...CONVERSATION, preferred_language: "en" },
        history: switchedHistory
      },
      deps
    );
    expect(deps.persistConversationLanguage).toHaveBeenCalledWith(CONV_ID, "es");
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("Current conversation language: es.");
  });

  it("continues the reply when language persistence fails (Error and non-Error)", async () => {
    const spanishHistory = [
      msg(1, "user", "Hola, quiero hacer una cita para el viernes por favor")
    ];
    const deps = makeDeps({
      persistConversationLanguage: vi.fn(async () => Promise.reject(new Error("db down")))
    });
    expect(
      (await runMessengerGeminiTurn({ ...ARGS, history: spanishHistory }, deps)).reply
    ).toContain("$99");

    const stringy = makeDeps({
      persistConversationLanguage: vi.fn(async () => Promise.reject("plain refusal"))
    });
    expect(
      (await runMessengerGeminiTurn({ ...ARGS, history: spanishHistory }, stringy)).reply
    ).toContain("$99");
  });

  it("falls back to the default persona when the config row is missing", async () => {
    const deps = makeDeps({ fetchConfig: vi.fn(async () => null) });
    await runMessengerGeminiTurn(ARGS, deps);
    const step = vi.mocked(deps.chatStep).mock.calls[0][0];
    expect(step.systemInstruction).toContain("You are a professional AI coworker.");
  });

  it("continues without the documents digest when the list read fails", async () => {
    const deps = makeDeps({
      fetchDocuments: vi.fn(async () => Promise.reject(new Error("db down")))
    });
    expect((await runMessengerGeminiTurn(ARGS, deps)).reply).toContain("$99");

    const stringy = makeDeps({
      fetchDocuments: vi.fn(async () => Promise.reject("plain refusal"))
    });
    expect((await runMessengerGeminiTurn(ARGS, stringy)).reply).toContain("$99");
  });

  it("runs a tool round: executes the call, feeds the result back, aggregates usage", async () => {
    const deps = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce(
          toolStep("webchat_business_knowledge_lookup", { question: "price?" })
        )
        .mockResolvedValueOnce(
          textStep("It is $99/mo.", { promptTokens: 200, outputTokens: 30 })
        )
    });
    const res = await runMessengerGeminiTurn(ARGS, deps);
    expect(res).toEqual({ reply: "It is $99/mo.", refusedOverCap: false, toolRounds: 1 });

    expect(deps.executeTool).toHaveBeenCalledWith(BIZ, "webchat_business_knowledge_lookup", {
      question: "price?"
    });
    const second = vi.mocked(deps.chatStep).mock.calls[1][0];
    expect(second.contents).toHaveLength(3);
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
    const res = await runMessengerGeminiTurn(ARGS, deps);
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
    expect((await runMessengerGeminiTurn(ARGS, stringy)).reply).toBe("Noted.");
  });

  it("withholds tools on the final round so the model must answer in text", async () => {
    const always = toolStep("webchat_business_knowledge_lookup", { question: "q" });
    const deps = makeDeps({
      chatStep: vi.fn(async (params) =>
        params.tools.length === 0 ? textStep("Final answer.") : always
      )
    });
    const res = await runMessengerGeminiTurn(ARGS, deps);
    expect(res.reply).toBe("Final answer.");
    expect(res.toolRounds).toBe(MESSENGER_ENGINE_MAX_TOOL_ROUNDS);
    expect(deps.chatStep).toHaveBeenCalledTimes(MESSENGER_ENGINE_MAX_TOOL_ROUNDS + 1);
  });

  it("throws messenger_engine_no_reply on an empty step — after metering", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: { promptTokens: 5, outputTokens: 0 }
      }))
    });
    await expect(runMessengerGeminiTurn(ARGS, deps)).rejects.toThrow(
      "messenger_engine_no_reply"
    );
    expect(deps.meter).toHaveBeenCalledTimes(1);
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
    await runMessengerGeminiTurn(ARGS, deps);
    const call = vi.mocked(deps.meter).mock.calls[0][0];
    expect(call.usage).toBeNull();
    expect(call.outputChars).toBe("Answer.".length);
    expect(call.inputChars).toBeGreaterThan(0);
  });

  it("meters on a tool-round-only failure even with zero output chars", async () => {
    const deps = makeDeps({
      chatStep: vi
        .fn()
        .mockResolvedValueOnce({ ...toolStep("webchat_capture_lead", {}), usage: null })
        .mockResolvedValueOnce({
          text: null,
          functionCalls: [],
          modelContent: null,
          usage: null
        })
    });
    await expect(runMessengerGeminiTurn(ARGS, deps)).rejects.toThrow(
      "messenger_engine_no_reply"
    );
    expect(deps.meter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.meter).mock.calls[0][0].usage).toBeNull();
  });

  it("does not meter when nothing was plausibly billed (incl. zero-token reports)", async () => {
    const deps = makeDeps({
      chatStep: vi.fn(async () => ({
        text: null,
        functionCalls: [],
        modelContent: null,
        usage: null
      }))
    });
    await expect(runMessengerGeminiTurn(ARGS, deps)).rejects.toThrow(
      "messenger_engine_no_reply"
    );
    expect(deps.meter).not.toHaveBeenCalled();

    const zero = makeDeps({
      chatStep: vi.fn(async () => textStep("Free?", { promptTokens: 0, outputTokens: 0 }))
    });
    expect((await runMessengerGeminiTurn(ARGS, zero)).reply).toBe("Free?");
    expect(zero.meter).not.toHaveBeenCalled();
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
    const pending = runMessengerGeminiTurn(ARGS, deps);
    const assertion = expect(pending).rejects.toThrow("gemini_aborted");
    await vi.advanceTimersByTimeAsync(MESSENGER_ENGINE_TURN_TIMEOUT_MS + 1);
    await assertion;
    expect(deps.meter).not.toHaveBeenCalled();
  });
});
