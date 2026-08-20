/**
 * AI assists over a finished demonstration: propose (a) which typed literals
 * should become {{...}} placeholders so the recording generalizes past the
 * one record it was demonstrated on, and (b) a "Proof it worked" marker
 * (expectText) read off the final page.
 *
 * The model PROPOSES and code DISPOSES: every suggestion is clamped here
 * before an owner ever sees it. A placeholder must be EXACTLY one of the
 * caller-supplied in-scope placeholders (the builder's own variables
 * palette), the index must point at a recorded action whose literal value is
 * non-empty, and an expectText must be a verbatim substring of the final
 * page's text or it is dropped. Clamping in code, not prompt, is what keeps
 * a hallucinated {{vars.nope}} out of a live step; the flow save re-checks
 * template scope anyway (parseAiFlowDefinition), so this is the near half of
 * a double fence. Each surviving suggestion is an individually-accepted chip
 * in the panel, never an auto-apply.
 */
import { z } from "zod";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { flowCompileModel, FLOW_COMPILE_THINKING_LEVEL } from "@/lib/ai-flows/compile-service";
import type { DemoRecordedAction } from "@/lib/ai-flows/demo-session-view";
import { logger } from "@/lib/logger";
import { NO_EM_DASH_PROMPT_LINE } from "../../../supabase/functions/_shared/sms_prompt_lines";

export type DemoFillSuggestion = {
  /** Which recorded action (0-based) the placeholder replaces the value of. */
  index: number;
  /** The exact placeholder, e.g. "{{vars.lead_name}}". Always from scope. */
  placeholder: string;
};

export type DemoSuggestions = {
  fills: DemoFillSuggestion[];
  /** A short verbatim excerpt of the final page proposed as expectText. */
  expectText?: string;
};

export type DemoSuggestFailure = "not_configured" | "generation_failed";

export type DemoSuggestResult =
  | { ok: true; suggestions: DemoSuggestions }
  | { ok: false; error: DemoSuggestFailure };

export type DemoSuggestDeps = {
  /** Injectable model call (tests). */
  generate?: typeof geminiGenerateTextDetailed;
};

/** Bounds on what rides into the prompt. */
export const DEMO_SUGGEST_MAX_VARS = 80;
export const DEMO_SUGGEST_PAGE_TEXT_MAX = 6000;
/** expectText mirrors the schema's cap on the step field. */
export const DEMO_SUGGEST_EXPECT_TEXT_MAX = 200;

/** Kinds whose recorded value is a candidate for a placeholder mapping. */
const FILLABLE_KINDS = new Set(["fill_selector", "fill_placeholder", "select_option"]);

const SUGGEST_SYSTEM_PROMPT = [
  "You review a recorded browser demonstration for a business automation step.",
  "The owner performed the workflow once on ONE example record, typing literal",
  "values. Your job: say which typed literals are really per-record data that",
  "should come from a variable, and propose a short proof-of-success marker.",
  "",
  "Reply with JSON only, in this exact shape:",
  '{ "fills": [{ "index": <number>, "placeholder": "<one of the available placeholders>" }],',
  '  "expectText": "<a short phrase copied VERBATIM from the final page text, or omit>" }',
  "",
  "Rules:",
  "- Only suggest a fill when the typed literal is clearly per-record data",
  "  (a name, a phone, an address, a date) AND an available placeholder",
  "  plainly means the same thing. When unsure, do not suggest.",
  "- Never invent a placeholder. Only the listed ones exist.",
  "- A note the owner typed as fixed wording (e.g. 'Called, no answer yet')",
  "  should stay literal: suggest nothing for it.",
  "- expectText must be copied character-for-character from the final page",
  "  text, short (a few words), and something that only appears AFTER the",
  "  workflow succeeded (a confirmation, not a page title). Omit it when the",
  "  page shows no such confirmation.",
  NO_EM_DASH_PROMPT_LINE
].join("\n");

const responseSchema = z.object({
  fills: z
    .array(
      z.object({
        index: z.number().int().min(0).max(14),
        placeholder: z.string().min(1).max(120)
      })
    )
    .max(15)
    .optional(),
  expectText: z.string().max(1000).optional()
});

function buildUserText(
  actions: DemoRecordedAction[],
  varsInScope: string[],
  afterPageText: string
): string {
  const actionLines = actions.map((a, i) => {
    const value = a.value && a.value.length > 0 ? ` value=${JSON.stringify(a.value)}` : "";
    return `${i}. kind=${a.kind} target=${JSON.stringify(a.target)}${value}`;
  });
  return [
    "Recorded actions (0-based):",
    ...actionLines,
    "",
    "Available placeholders (the ONLY ones that exist):",
    varsInScope.length > 0 ? varsInScope.join("\n") : "(none)",
    "",
    "Final page text (what the page showed after the last action):",
    afterPageText.length > 0 ? afterPageText : "(empty)"
  ].join("\n");
}

/**
 * Ask the model for refinements over a finished recording, then clamp them.
 * An empty suggestions object is a normal answer ("nothing worth changing"),
 * not a failure.
 */
export async function suggestDemoRefinements(
  args: {
    businessId: string;
    actions: DemoRecordedAction[];
    varsInScope: string[];
    afterPageText: string;
  },
  deps: DemoSuggestDeps = {}
): Promise<DemoSuggestResult> {
  /* c8 ignore next -- production default; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "not_configured" };
  const model = flowCompileModel();

  // Unique, bounded scope list. Order preserved so the prompt reads the way
  // the palette does (trigger fields first).
  const scope = [...new Set(args.varsInScope.filter((v) => v.length > 0))].slice(
    0,
    DEMO_SUGGEST_MAX_VARS
  );
  const scopeSet = new Set(scope);
  const pageText = args.afterPageText.slice(0, DEMO_SUGGEST_PAGE_TEXT_MAX);
  const userText = buildUserText(args.actions, scope, pageText);

  let raw: string;
  let usage: GeminiUsage | null;
  try {
    ({ text: raw, usage } = await generate({
      apiKey,
      model,
      systemInstruction: SUGGEST_SYSTEM_PROMPT,
      userText,
      temperature: 0,
      maxOutputTokens: 2000,
      responseMimeType: "application/json",
      thinkingLevel: FLOW_COMPILE_THINKING_LEVEL
    }));
  } catch (err) {
    // Empty replies (thinking-only output) are still billed; meter them
    // before surfacing the failure, same as the compiler.
    if (err instanceof GeminiEmptyError) {
      await meterGeminiSpendForBusiness({
        businessId: args.businessId,
        model,
        surface: "aiflow_demo_suggest",
        usage: err.usage,
        inputChars: SUGGEST_SYSTEM_PROMPT.length + userText.length,
        outputChars: 0
      });
    }
    logger.warn("demo-suggest: generation failed", {
      businessId: args.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, error: "generation_failed" };
  }
  await meterGeminiSpendForBusiness({
    businessId: args.businessId,
    model,
    surface: "aiflow_demo_suggest",
    usage,
    inputChars: SUGGEST_SYSTEM_PROMPT.length + userText.length,
    outputChars: raw.length
  });

  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(JSON.parse(raw));
  } catch {
    logger.warn("demo-suggest: unparseable model reply", { businessId: args.businessId });
    return { ok: false, error: "generation_failed" };
  }

  // The clamps. Everything that survives is safe to OFFER; the owner still
  // accepts each one by hand, and the flow save re-validates scope.
  const seen = new Set<number>();
  const fills: DemoFillSuggestion[] = [];
  for (const fill of parsed.fills ?? []) {
    if (seen.has(fill.index)) continue;
    const action = args.actions[fill.index];
    if (!action) continue;
    if (!FILLABLE_KINDS.has(action.kind)) continue;
    if (!action.value || action.value.length === 0) continue;
    if (!scopeSet.has(fill.placeholder)) continue;
    if (action.value === fill.placeholder) continue; // already a placeholder
    seen.add(fill.index);
    fills.push({ index: fill.index, placeholder: fill.placeholder });
  }

  const expectRaw = (parsed.expectText ?? "").trim();
  const expectText =
    expectRaw.length > 0 &&
    expectRaw.length <= DEMO_SUGGEST_EXPECT_TEXT_MAX &&
    pageText.includes(expectRaw)
      ? expectRaw
      : undefined;

  return { ok: true, suggestions: { fills, ...(expectText ? { expectText } : {}) } };
}
