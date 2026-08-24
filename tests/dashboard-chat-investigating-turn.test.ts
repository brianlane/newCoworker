/**
 * The escalation seam in the inline turn engine
 * (src/lib/dashboard-chat/inline-turn.ts): an owner ask that can only be
 * satisfied by changing an automation gets read-the-account treatment, and
 * every other ask, including a classifier outage, is left exactly as it was.
 *
 * The bug this closes: Amy Laidlaw asked on 2026-08-23 that her lead alerts
 * carry the lead's type, name, number, email, source and price. The turn saved
 * a memory rule and promised the alerts would change. They could not: those
 * alerts come from her AiFlow notify steps, and no flow step reads memory. The
 * surface had `list_aiflows` and `edit_aiflow` the whole time and never looked,
 * because the loop runs at thinking `low` with a tool budget sized for
 * "text Dave that the showing moved".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import type { GeminiChatStepParams, GeminiChatStepResult } from "@/lib/gemini-chat";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  UNKNOWN_ASK,
  type OwnerAskClassification
} from "@/lib/dashboard-chat/ask-classifier";
import type { ActionToolGates } from "@/lib/dashboard-chat/action-tools";

const BIZ = "11111111-1111-4111-8111-111111111111";

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "DASHBOARD_CHAT_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.DASHBOARD_CHAT_MODEL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const GATES_WITH_EDIT: ActionToolGates = {
  send_sms: true,
  send_whatsapp: false,
  calendar_find_slots: false,
  calendar_book_appointment: false,
  calendar_reschedule_appointment: false,
  calendar_cancel_appointment: false,
  calendar_join_waitlist: false,
  list_aiflows: true,
  run_aiflow: true,
  edit_aiflow: true,
  undo_aiflow_edit: true,
  generate_image: false,
  update_notification_preferences: false,
  flag_contact_spam: false,
  set_contact_reply_mode: false,
  manage_employee: false
};

const GATES_WITHOUT_EDIT: ActionToolGates = { ...GATES_WITH_EDIT, edit_aiflow: false };

function textStep(text: string): GeminiChatStepResult {
  return {
    text,
    functionCalls: [],
    modelContent: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  } as unknown as GeminiChatStepResult;
}

function toolStep(name: string): GeminiChatStepResult {
  return {
    text: "",
    functionCalls: [{ name, args: {} }],
    modelContent: { role: "model", parts: [{ text: "" }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  } as unknown as GeminiChatStepResult;
}

function baseArgs(gates: ActionToolGates = GATES_WITH_EDIT) {
  return {
    businessId: BIZ,
    systemInstruction: "SYSTEM",
    userMessage: "[SMS from owner] please put the price on these lead alerts",
    actionToolGates: gates
  };
}

const AUTOMATION_ASK: OwnerAskClassification = {
  kind: "automation_change",
  needsInvestigation: true,
  target: "the lead alerts"
};

const PREFERENCE_ASK: OwnerAskClassification = {
  kind: "preference",
  needsInvestigation: false,
  target: ""
};

describe("an ask that needs the account read", () => {
  it("raises thinking to high and appends the investigation directive", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("here is what I found"));
    const classifyAsk = vi.fn(async () => AUTOMATION_ASK);

    const res = await runInlineChatTurn(baseArgs(), {
      chatStep,
      classifyAsk: classifyAsk as never
    });

    expect(res).toMatchObject({ ok: true });
    const params = chatStep.mock.calls[0][0];
    expect(params.thinkingLevel).toBe("high");
    // The directive is APPENDED, never a replacement: the surface's own
    // prompt blocks still lead.
    expect(params.systemInstruction.startsWith("SYSTEM")).toBe(true);
    expect(params.systemInstruction).toContain("THIS ASK NEEDS THE ACCOUNT READ FIRST");
    expect(params.systemInstruction).toContain("the lead alerts");
    expect(params.systemInstruction).toContain("list_aiflows");
  });

  it("classifies the owner's message, with the resolved key", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("ok"));
    const classifyAsk = vi.fn(async () => AUTOMATION_ASK);
    await runInlineChatTurn(baseArgs(), { chatStep, classifyAsk: classifyAsk as never });
    expect(classifyAsk).toHaveBeenCalledWith({
      ownerMessage: "[SMS from owner] please put the price on these lead alerts",
      apiKey: "test-key"
    });
  });

  // A turn that runs out of tool steps mid-investigation answers from a
  // half-read account, which is the failure this feature exists to remove.
  it("gets extra tool steps to list and read with", async () => {
    // Every step asks for a tool, so the loop runs until the budget stops it:
    // the call count IS the budget.
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => toolStep("list_aiflows"));
    const runActionTool = vi.fn(async () => ({ ok: true, flows: [] }));

    await runInlineChatTurn(
      { ...baseArgs(), maxToolSteps: 2 },
      {
        chatStep,
        classifyAsk: (async () => AUTOMATION_ASK) as never,
        runActionTool: runActionTool as never
      }
    );
    // 2 requested + 4 for the investigation.
    expect(chatStep).toHaveBeenCalledTimes(6);
  });

  it("leaves the budget alone for an ask that does not investigate", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => toolStep("list_aiflows"));
    const runActionTool = vi.fn(async () => ({ ok: true, flows: [] }));
    await runInlineChatTurn(
      { ...baseArgs(), maxToolSteps: 2 },
      {
        chatStep,
        classifyAsk: (async () => PREFERENCE_ASK) as never,
        runActionTool: runActionTool as never
      }
    );
    expect(chatStep).toHaveBeenCalledTimes(2);
  });
});

describe("every other ask is left exactly as it was", () => {
  it("a preference keeps thinking low and an untouched system prompt", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("got it"));
    await runInlineChatTurn(baseArgs(), {
      chatStep,
      classifyAsk: (async () => PREFERENCE_ASK) as never
    });
    const params = chatStep.mock.calls[0][0];
    expect(params.thinkingLevel).toBe("low");
    expect(params.systemInstruction).toBe("SYSTEM");
  });

  // The degrade contract. A classifier outage must cost the OLD behavior,
  // never a worse one, so an owner turn is never held hostage to it.
  it("a classifier outage falls back to the pre-classifier settings", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("got it"));
    await runInlineChatTurn(baseArgs(), {
      chatStep,
      classifyAsk: (async () => UNKNOWN_ASK) as never
    });
    const params = chatStep.mock.calls[0][0];
    expect(params.thinkingLevel).toBe("low");
    expect(params.systemInstruction).toBe("SYSTEM");
  });

  // Investigating is only worth its cost on a surface that could act on what
  // it finds. With no automation-edit tool it is a slower road to the same
  // answer, so the classifier is not even called.
  it("does not classify at all when the surface cannot edit automations", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("got it"));
    const classifyAsk = vi.fn(async () => AUTOMATION_ASK);
    await runInlineChatTurn(baseArgs(GATES_WITHOUT_EDIT), {
      chatStep,
      classifyAsk: classifyAsk as never
    });
    expect(classifyAsk).not.toHaveBeenCalled();
    expect(chatStep.mock.calls[0][0].thinkingLevel).toBe("low");
    expect(chatStep.mock.calls[0][0].systemInstruction).toBe("SYSTEM");
  });

  it("does not classify when the surface declares no action tools at all", async () => {
    const chatStep = vi.fn(async (_p: GeminiChatStepParams) => textStep("got it"));
    const classifyAsk = vi.fn(async () => AUTOMATION_ASK);
    await runInlineChatTurn(
      { businessId: BIZ, systemInstruction: "SYSTEM", userMessage: "hello" },
      { chatStep, classifyAsk: classifyAsk as never }
    );
    expect(classifyAsk).not.toHaveBeenCalled();
  });
});
