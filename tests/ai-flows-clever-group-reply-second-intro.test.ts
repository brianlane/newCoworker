import { describe, expect, it } from "vitest";
import {
  CLEVER_GROUP_FROM,
  INTRO_FLOW_NAME,
  SECOND_INTRO_TRIGGER,
  addSecondIntroTrigger
} from "../scripts/oneshot/patch-clever-group-reply-second-intro";
import { evaluateSmsTrigger, flowTriggers } from "../supabase/functions/_shared/ai_flows/engine";
import type { SmsTrigger, TriggerContext } from "../supabase/functions/_shared/ai_flows/types";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Clever second-intro trigger one-shot (Donna/Kevin, Jul 31 2026): Clever's
 * group line started sending a second intro template ("Hi Donna, meet your
 * top-rated local Clever agent!") that contains neither "Clever Real Estate"
 * nor "introduce you to Amy", so the live Intro flow's AND-ed contains
 * conditions never matched, the default assistant replied inside the group
 * thread, and the owner was paged "needs you to take over with Clever Group
 * Intro". The one-shot appends an extra OR trigger for the new shape; these
 * tests pin the miss, the fix, and the non-overlap with the classic intro.
 */

/** Verbatim classic intro (the Pamela windowText from run c53ed929). */
const CLASSIC_INTRO =
  "Hi Pamela 👋 this is Team from Clever Real Estate!\r\n\r\n" +
  "In this group text, I'd like to introduce you to Amy Laidlaw,\r\n\r\n" +
  "They will provide you with the instant cash offer you requested, as well " +
  "as explain our 7 Day Sold program, to help sell your home quickly.\r\n\r\n" +
  "You can reach Amy at: ☎️: +16028053377 📧: amy@amylaidlaw.com Amy, when " +
  "is the earliest you'll be able to give Pamela a call?";

/**
 * Verbatim second template (Donna, Jul 31 2026, sms_inbound_jobs). The
 * "Amy Laidlaw – Homesmart" en dash is vendor data; do not normalize it.
 */
const SECOND_INTRO =
  "Hi Donna, meet your top-rated local Clever agent!\r\n\r\n" +
  "👤 Amy Laidlaw – Homesmart\r\n" +
  "📞 +16028053377\r\n" +
  "📧 amy@amylaidlaw.com\r\n" +
  "⭐ Top agent rated 4.8 / 5 stars\r\n\r\n" +
  "Amy, when is the soonest you can give Donna a quick call?";

const CLEVER_LINE = `+1${CLEVER_GROUP_FROM}`;
const BASE_MS = 2_000_000_000_000;

function ctx(
  msgs: Array<{ text: string; from?: string; atMs?: number }>,
  nowMs = BASE_MS
): TriggerContext {
  return {
    nowMs,
    messages: msgs.map((m) => ({
      text: m.text,
      from: m.from ?? CLEVER_LINE,
      atMs: m.atMs ?? BASE_MS
    }))
  };
}

/** The live Intro flow, reduced to what the one-shot touches (shape verified 2026-08-01). */
function introFlowDef(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 3,
      conditions: [
        { type: "from_matches", value: CLEVER_GROUP_FROM },
        { type: "contains", value: "Clever Real Estate", caseInsensitive: true },
        { type: "contains", value: "introduce you to Amy", caseInsensitive: true }
      ]
    },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [
          { name: "seller_first_name", description: "The seller's first name" }
        ]
      },
      { id: "s2", type: "send_sms", replyToGroup: true, body: "Hi {{vars.seller_first_name}}." }
    ],
    options: { suppressDefaultReply: true }
  };
}

const EXTRA = SECOND_INTRO_TRIGGER as unknown as SmsTrigger;

describe("addSecondIntroTrigger", () => {
  it("appends the OR trigger and the result stays a valid definition", () => {
    const def = introFlowDef();
    expect(addSecondIntroTrigger(def)).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    expect(flowTriggers(parsed)).toHaveLength(2);
    expect(parsed.triggers?.[0]).toMatchObject({
      channel: "sms",
      correlationWindowMinutes: 3,
      conditions: [
        { type: "from_matches", value: CLEVER_GROUP_FROM },
        { type: "contains", value: "meet your", caseInsensitive: true },
        { type: "contains", value: "Clever agent", caseInsensitive: true }
      ]
    });
    // The main trigger is left byte-identical.
    expect(parsed.trigger).toMatchObject({
      conditions: [
        { type: "from_matches", value: CLEVER_GROUP_FROM },
        { type: "contains", value: "Clever Real Estate" },
        { type: "contains", value: "introduce you to Amy" }
      ]
    });
  });

  it("is idempotent (second run is a byte-identical no-op)", () => {
    const def = introFlowDef();
    expect(addSecondIntroTrigger(def)).toBe(true);
    const frozen = JSON.stringify(def);
    expect(addSecondIntroTrigger(def)).toBe(false);
    expect(JSON.stringify(def)).toBe(frozen);
  });

  it("exports the stable flow name the apply-time assertion keys on", () => {
    expect(INTRO_FLOW_NAME).toBe("Clever Lead - Group Reply Intro Notify me");
  });
});

describe("trigger matching: classic vs second intro template", () => {
  const main = introFlowDef().trigger as SmsTrigger;

  it("baseline: the classic intro still matches the live main trigger", () => {
    expect(evaluateSmsTrigger(main, ctx([{ text: CLASSIC_INTRO }])).matched).toBe(true);
  });

  it("outage repro: the second template matches NEITHER live trigger condition set", () => {
    expect(evaluateSmsTrigger(main, ctx([{ text: SECOND_INTRO }])).matched).toBe(false);
  });

  it("fix: the second template matches the appended OR trigger", () => {
    const r = evaluateSmsTrigger(EXTRA, ctx([{ text: SECOND_INTRO }]));
    expect(r.matched).toBe(true);
    expect(r.windowText).toContain("Donna");
  });

  it("no cross-fire: the classic intro does not match the OR trigger", () => {
    expect(evaluateSmsTrigger(EXTRA, ctx([{ text: CLASSIC_INTRO }])).matched).toBe(false);
  });

  it("wrong sender: the second template from another number does not match", () => {
    expect(
      evaluateSmsTrigger(EXTRA, ctx([{ text: SECOND_INTRO, from: "+15551234567" }])).matched
    ).toBe(false);
  });

  it("group-line chatter matches neither trigger", () => {
    const chatter = ctx([{ text: "Thanks, we'll follow up tomorrow" }]);
    expect(evaluateSmsTrigger(main, chatter).matched).toBe(false);
    expect(evaluateSmsTrigger(EXTRA, chatter).matched).toBe(false);
  });

  it("window semantics: a follow-up inside 3 minutes keeps matching, outside does not", () => {
    const twoMin = ctx(
      [
        { text: SECOND_INTRO, atMs: BASE_MS },
        { text: "ok", atMs: BASE_MS + 2 * 60_000 }
      ],
      BASE_MS + 2 * 60_000
    );
    expect(evaluateSmsTrigger(EXTRA, twoMin).matched).toBe(true);

    const fourMin = ctx(
      [
        { text: SECOND_INTRO, atMs: BASE_MS },
        { text: "ok", atMs: BASE_MS + 4 * 60_000 }
      ],
      BASE_MS + 4 * 60_000
    );
    expect(evaluateSmsTrigger(EXTRA, fourMin).matched).toBe(false);
  });
});
