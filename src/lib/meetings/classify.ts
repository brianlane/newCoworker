/**
 * Meeting-minutes classification: the model pass.
 *
 * Two Gemini calls against the condensed minutes, both metered into the
 * tenant's own shared AI budget on the `meeting_classify` surface, mirroring
 * `runCondense` in src/lib/documents/ingest.ts (same model resolution, same
 * abort budget, same meter-even-on-empty handling).
 *
 * Two calls rather than one combined prompt, deliberately. Each reuses a
 * proven prompt builder verbatim instead of introducing a third bespoke
 * prompt with its own parser, and the outcome survives an action-item
 * failure: a meeting whose to-do extraction returns nothing still moves the
 * card and files the note.
 *
 * Never throws. Every failure degrades to "unclear with no action items",
 * which the applier treats as "write nothing".
 */
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";
import {
  parseClassifyChoice,
  parseExtractionJson
} from "../../../supabase/functions/_shared/ai_flows/engine";
import {
  buildMeetingActionItemsPrompt,
  buildMeetingClassifyPrompt,
  MEETING_ACTION_ITEM_FIELDS,
  MEETING_OUTCOME_CATEGORIES,
  MEETING_OUTCOME_UNCLEAR,
  outcomeWantsActionItems,
  parseMeetingActionItems,
  type MeetingActionItem,
  type MeetingOutcome
} from "./outcome-core";

/** Metering surface, so meeting spend is separable from document ingest. */
export const MEETING_CLASSIFY_SURFACE = "meeting_classify";

/** Same default as document ingest: cheap, and built for this kind of pass. */
const DEFAULT_MEETING_MODEL = "gemini-3.5-flash-lite";

/** Outbound budget per call. Well under the import route's 120s. */
const MEETING_CALL_TIMEOUT_MS = 30_000;

const CLASSIFY_SYSTEM_PROMPT =
  "You read the minutes of a business meeting and report what the meeting was, strictly and conservatively. You never infer a commitment that was not made.";

const EXTRACT_SYSTEM_PROMPT =
  "You read the minutes of a business meeting and list the follow-up tasks people committed to. You never invent a task that nobody agreed to.";

function resolveModel(): string {
  const configured = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_MEETING_MODEL;
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type ClassifyMeetingDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
};

export type ClassifiedMeeting = {
  outcome: MeetingOutcome;
  actionItems: MeetingActionItem[];
};

/**
 * One metered Gemini call. Returns the text, or null on any failure: this
 * whole pass is an enhancement to an import that already succeeded, so a
 * model outage must never surface as an error anywhere.
 */
async function runMeetingCall(
  businessId: string,
  systemInstruction: string,
  prompt: string,
  generate: GeminiCall
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return null;
  const model = resolveModel();
  const inputChars = systemInstruction.length + prompt.length;
  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real Gemini hang */
  const timer = setTimeout(() => controller.abort(), MEETING_CALL_TIMEOUT_MS);
  try {
    const { text, usage } = await generate({
      apiKey,
      model,
      systemInstruction,
      userText: prompt,
      // Low, not zero: this is a judgement call, but a reproducible one.
      temperature: 0.1,
      maxOutputTokens: 1000,
      signal: controller.signal
    });
    await meterGeminiSpendForBusiness({
      businessId,
      model,
      surface: MEETING_CLASSIFY_SURFACE,
      usage,
      inputChars,
      outputChars: text.length
    });
    return text;
  } catch (err) {
    if (err instanceof GeminiEmptyError) {
      // Billed even when empty (thinking-only output), so meter before
      // giving up, same as the document condenser.
      await meterGeminiSpendForBusiness({
        businessId,
        model,
        surface: MEETING_CLASSIFY_SURFACE,
        usage: err.usage,
        inputChars,
        outputChars: 0
      });
    }
    logger.warn("meeting classify: model call failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify the meeting and pull its action items.
 *
 * Blank minutes short-circuit to `unclear` without spending anything: an
 * empty condensation means the ingest already had nothing to work with.
 */
export async function classifyMeeting(
  businessId: string,
  minutes: string,
  deps: ClassifyMeetingDeps = {}
): Promise<ClassifiedMeeting> {
  /* c8 ignore next -- production default; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const text = minutes.trim();
  if (!text) return { outcome: MEETING_OUTCOME_UNCLEAR, actionItems: [] };

  const classifyRaw = await runMeetingCall(
    businessId,
    CLASSIFY_SYSTEM_PROMPT,
    buildMeetingClassifyPrompt(text),
    generate
  );
  const outcome = (
    classifyRaw === null
      ? MEETING_OUTCOME_UNCLEAR
      : parseClassifyChoice(
          classifyRaw,
          MEETING_OUTCOME_CATEGORIES.map((c) => ({ value: c.value }))
        )
  ) as MeetingOutcome;

  // An outcome that writes nothing to a contact record has nothing for
  // action items to hang off, so skip the second call rather than pay for a
  // list the applier will discard. That is `unclear` AND `internal`: every
  // team sync and vendor call used to buy a metered extraction it could
  // never apply.
  if (!outcomeWantsActionItems(outcome)) {
    return { outcome, actionItems: [] };
  }

  const extractRaw = await runMeetingCall(
    businessId,
    EXTRACT_SYSTEM_PROMPT,
    buildMeetingActionItemsPrompt(text),
    generate
  );
  const actionItems =
    extractRaw === null
      ? []
      : parseMeetingActionItems(parseExtractionJson(extractRaw, MEETING_ACTION_ITEM_FIELDS));

  return { outcome, actionItems };
}
