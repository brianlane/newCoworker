import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  parseClassifyChoice
} from "../../supabase/functions/_shared/ai_flows/engine";
import {
  buildBadPhoneSteps,
  FLOW_CONFIGS
} from "../../scripts/oneshot/add-bad-phone-agent-report";
import { geminiJson } from "./gemini";

/**
 * Live-Gemini accuracy check for the bad-phone-report classifier (the
 * bp_classify step the add-bad-phone-agent-report one-shot appends to Amy's
 * lead flows): a teammate's post-claim text must land bad_phone_number ONLY
 * when it actually describes the lead's phone negatively. The near-misses
 * matter most — "she didn't pick up" or "left a voicemail" emailing the lead
 * "your number is wrong" would be a real-world embarrassment, so this suite
 * pins the separation with the EXACT question + categories production runs
 * (imported from the one-shot, not copied).
 */

type ClassifyStep = {
  question?: string;
  categories: Array<{ value: string; description?: string }>;
};

// The categories/question are identical across the four flow configs; take
// them from the first and let the shape assertion below catch drift.
const CLASSIFY = buildBadPhoneSteps(FLOW_CONFIGS[0]).find(
  (s) => s.type === "classify"
) as unknown as ClassifyStep;

const CASES: Array<[reply: string, want: string]> = [
  // Real bad-number reports → bad_phone_number.
  ["that number is disconnected", "bad_phone_number"],
  ["wrong number — some other guy answered", "bad_phone_number"],
  ["the number's no good, it says no longer in service", "bad_phone_number"],
  ["bad number", "bad_phone_number"],
  ["line is dead, couldn't get through at all", "bad_phone_number"],
  // Near-misses that must NOT trigger the bad-number emails.
  ["she didn't pick up, I'll try again tonight", "other_update"],
  ["left a voicemail, will try again tomorrow", "other_update"],
  ["spoke with them, setting up a showing Friday", "other_update"],
  ["no answer yet", "other_update"],
  ["they asked me to call back after 6", "other_update"]
];

describe("bad-phone-report classify (live Gemini)", () => {
  it("uses the two production categories", () => {
    expect(CLASSIFY.categories.map((c) => c.value)).toEqual([
      "bad_phone_number",
      "other_update"
    ]);
    expect(CLASSIFY.question).toBeTruthy();
  });

  it.each(CASES)('"%s" → %s', async (reply, want) => {
    const prompt = buildClassifyPrompt(CLASSIFY.categories, reply, CLASSIFY.question);
    const text = await geminiJson(prompt);
    expect(parseClassifyChoice(text, CLASSIFY.categories)).toBe(want);
  });
});
