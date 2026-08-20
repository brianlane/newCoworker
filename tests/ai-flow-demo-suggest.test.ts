import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import {
  DEMO_SUGGEST_MAX_OUTPUT_TOKENS,
  DEMO_SUGGEST_MAX_VARS,
  DEMO_SUGGEST_PAGE_TEXT_MAX,
  DEMO_SUGGEST_THINKING_LEVEL,
  suggestDemoRefinements
} from "@/lib/ai-flows/demo-suggest";
import { FLOW_COMPILE_THINKING_LEVEL } from "@/lib/ai-flows/compile-service";
import type { DemoRecordedAction } from "@/lib/ai-flows/demo-session-view";

const meter = vi.mocked(meterGeminiSpendForBusiness);

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const ACTIONS: DemoRecordedAction[] = [
  { kind: "click_text", target: "Provide Update" },
  { kind: "fill_selector", target: 'textarea[name="message"]', value: "Jane Doe called" },
  { kind: "select_option", target: 'select[name="hour"]', value: "9" },
  { kind: "click_text", target: "Next" },
  { kind: "fill_placeholder", target: "Add a note", value: "" }
];

const SCOPE = ["{{vars.lead_name}}", "{{vars.lead_phone}}", "{{trigger.body}}"];
const PAGE = "All done. Update submitted. Thanks!";

function generateReturning(payload: unknown) {
  return vi.fn(async () => ({
    text: typeof payload === "string" ? payload : JSON.stringify(payload),
    usage: { promptTokens: 10, outputTokens: 5 }
  })) as never;
}

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  vi.clearAllMocks();
});

describe("suggestDemoRefinements", () => {
  it("is not_configured with no Gemini key under either env name", async () => {
    delete process.env.GOOGLE_API_KEY;
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({}) }
    );
    expect(result).toEqual({ ok: false, error: "not_configured" });

    process.env.GEMINI_API_KEY = "alt-key";
    const viaAlt = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({ fills: [] }) }
    );
    expect(viaAlt.ok).toBe(true);
  });

  it("passes clamped scope and page text to the model, and meters the spend", async () => {
    const generate = generateReturning({ fills: [] });
    const manyVars = Array.from({ length: 100 }, (_, i) => `{{vars.v${i}}}`);
    const longPage = "x".repeat(DEMO_SUGGEST_PAGE_TEXT_MAX + 500);

    await suggestDemoRefinements(
      {
        businessId: BIZ,
        actions: ACTIONS,
        varsInScope: ["", ...manyVars, manyVars[0]],
        afterPageText: longPage
      },
      { generate }
    );

    const params = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      userText: string;
      responseMimeType: string;
      systemInstruction: string;
    };
    expect(params.responseMimeType).toBe("application/json");
    // Empty entries filtered, duplicates deduped, list capped.
    expect(params.userText).toContain(`{{vars.v${DEMO_SUGGEST_MAX_VARS - 1}}}`);
    expect(params.userText).not.toContain(`{{vars.v${DEMO_SUGGEST_MAX_VARS}}}`);
    // Page text bounded so a whole SPA never rides into the prompt.
    expect(params.userText.length).toBeLessThan(DEMO_SUGGEST_PAGE_TEXT_MAX + 2000);
    // Every AI prompt carries the no-em-dash line.
    expect(params.systemInstruction.toLowerCase()).toContain("em dash");
    expect(meter).toHaveBeenCalledTimes(1);
  });

  it("does not let hidden thinking eat the whole output budget", async () => {
    // Gemini 3 spends thinking tokens against maxOutputTokens, which is why
    // the COMPILER pairs high thinking with a 32k cap. This reply is a few
    // indexes and one phrase, so borrowing the compiler's high level under a
    // small cap would return empty text, and an empty reply fails closed:
    // "Suggest improvements" would quietly do nothing every time.
    expect(DEMO_SUGGEST_THINKING_LEVEL).not.toBe(FLOW_COMPILE_THINKING_LEVEL);
    expect(DEMO_SUGGEST_THINKING_LEVEL).toBe("low");
    expect(DEMO_SUGGEST_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(8000);

    const generate = generateReturning({ fills: [] });
    await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate }
    );
    const params = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      thinkingLevel: string;
      maxOutputTokens: number;
    };
    expect(params.thinkingLevel).toBe(DEMO_SUGGEST_THINKING_LEVEL);
    expect(params.maxOutputTokens).toBe(DEMO_SUGGEST_MAX_OUTPUT_TOKENS);
  });

  it("names the empty-scope and empty-page cases in the prompt", async () => {
    const generate = generateReturning({ fills: [] });
    await suggestDemoRefinements(
      { businessId: BIZ, actions: [ACTIONS[0]], varsInScope: [], afterPageText: "" },
      { generate }
    );
    const params = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { userText: string };
    expect(params.userText).toContain("(none)");
    expect(params.userText).toContain("(empty)");
  });

  it("keeps only fills that survive every clamp", async () => {
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      {
        generate: generateReturning({
          fills: [
            { index: 1, placeholder: "{{vars.lead_name}}" }, // valid
            { index: 1, placeholder: "{{vars.lead_phone}}" }, // dup index, dropped
            { index: 0, placeholder: "{{vars.lead_name}}" }, // click_text, dropped
            { index: 3, placeholder: "{{vars.lead_name}}" }, // no value, dropped
            { index: 4, placeholder: "{{vars.lead_name}}" }, // empty value, dropped
            { index: 9, placeholder: "{{vars.lead_name}}" }, // out of range, dropped
            { index: 2, placeholder: "{{vars.invented}}" } // not in scope, dropped
          ]
        })
      }
    );
    expect(result).toEqual({
      ok: true,
      suggestions: { fills: [{ index: 1, placeholder: "{{vars.lead_name}}" }] }
    });
  });

  it("drops a fill whose value is already that placeholder", async () => {
    const actions: DemoRecordedAction[] = [
      { kind: "fill_selector", target: "t", value: "{{vars.lead_name}}" }
    ];
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({ fills: [{ index: 0, placeholder: "{{vars.lead_name}}" }] }) }
    );
    expect(result).toEqual({ ok: true, suggestions: { fills: [] } });
  });

  it("keeps an expectText only when it is a verbatim excerpt of the final page", async () => {
    const kept = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({ fills: [], expectText: "  Update submitted. " }) }
    );
    expect(kept).toEqual({
      ok: true,
      suggestions: { fills: [], expectText: "Update submitted." }
    });

    const invented = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({ fills: [], expectText: "Definitely worked" }) }
    );
    expect(invented).toEqual({ ok: true, suggestions: { fills: [] } });

    const tooLong = await suggestDemoRefinements(
      {
        businessId: BIZ,
        actions: ACTIONS,
        varsInScope: SCOPE,
        afterPageText: "a".repeat(500)
      },
      { generate: generateReturning({ fills: [], expectText: "a".repeat(300) }) }
    );
    expect(tooLong).toEqual({ ok: true, suggestions: { fills: [] } });
  });

  it("treats a missing fills array as no suggestions", async () => {
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({}) }
    );
    expect(result).toEqual({ ok: true, suggestions: { fills: [] } });
  });

  it("fails closed on an unparseable or mis-shaped reply", async () => {
    const notJson = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning("here you go: {") }
    );
    expect(notJson).toEqual({ ok: false, error: "generation_failed" });

    const misShaped = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateReturning({ fills: [{ index: "one", placeholder: 3 }] }) }
    );
    expect(misShaped).toEqual({ ok: false, error: "generation_failed" });
  });

  it("meters a billed-but-empty reply before failing (the GeminiEmptyError case)", async () => {
    const generate = vi.fn(async () => {
      throw new GeminiEmptyError({ promptTokens: 20, outputTokens: 0 });
    }) as never;
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate }
    );
    expect(result).toEqual({ ok: false, error: "generation_failed" });
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      surface: "aiflow_demo_suggest",
      usage: { promptTokens: 20, outputTokens: 0 },
      outputChars: 0
    });
  });

  it("fails plainly on any other model error, metering nothing", async () => {
    const generate = vi.fn(async () => {
      throw new Error("503 upstream");
    }) as never;
    const result = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate }
    );
    expect(result).toEqual({ ok: false, error: "generation_failed" });
    expect(meter).not.toHaveBeenCalled();

    const generateOdd = vi.fn(async () => {
      throw "wat";
    }) as never;
    const odd = await suggestDemoRefinements(
      { businessId: BIZ, actions: ACTIONS, varsInScope: SCOPE, afterPageText: PAGE },
      { generate: generateOdd }
    );
    expect(odd).toEqual({ ok: false, error: "generation_failed" });
  });
});
