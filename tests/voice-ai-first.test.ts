import { describe, expect, it } from "vitest";
import {
  AI_FIRST_BRIEF_MAX_CHARS,
  AI_FIRST_DEFAULT_ACCEPT,
  AI_FIRST_DEFAULT_MEDIA_SECONDS,
  AI_FIRST_MAX_DELAY_SECONDS,
  aiFirstDelaySeconds,
  buildHandoffContext,
  buildPreCallBrief,
  planAiFirstAccept,
  type HandoffAiTakeover
} from "../supabase/functions/_shared/voice_handoff";

const takeover = (extra: Partial<HandoffAiTakeover> = {}): HandoffAiTakeover => ({
  notify_e164: "+16025245719",
  ...extra
});

describe("aiFirstDelaySeconds", () => {
  it("sums the digit waits and the media pause", () => {
    expect(aiFirstDelaySeconds([3, 1], 2)).toBe(6);
  });

  it("ignores absent, zero, negative, and non-finite waits", () => {
    expect(aiFirstDelaySeconds([undefined, 0, -4, Number.NaN, 2], undefined)).toBe(2);
    expect(aiFirstDelaySeconds(undefined, undefined)).toBe(0);
    expect(aiFirstDelaySeconds([], -1)).toBe(0);
  });
});

describe("planAiFirstAccept", () => {
  it("defaults to one '1' press and a media pause when nothing is authored", () => {
    const plan = planAiFirstAccept(takeover());
    expect(plan.digits).toEqual([{ digit: "1", after_seconds: 3 }]);
    expect(plan.mediaStartSeconds).toBe(AI_FIRST_DEFAULT_MEDIA_SECONDS);
    // The defaults sit exactly at the budget, never over it.
    expect(
      aiFirstDelaySeconds(plan.digits.map((d) => d.after_seconds), plan.mediaStartSeconds)
    ).toBe(AI_FIRST_MAX_DELAY_SECONDS);
  });

  it("keeps an authored two-press sequence in order", () => {
    const plan = planAiFirstAccept(
      takeover({
        accept_digits: [
          { digit: "1", after_seconds: 2 },
          { digit: "1", after_seconds: 1 }
        ],
        media_start_seconds: 1
      })
    );
    expect(plan.digits).toEqual([
      { digit: "1", after_seconds: 2 },
      { digit: "1", after_seconds: 1 }
    ]);
    expect(plan.mediaStartSeconds).toBe(1);
  });

  it("clamps the total budget by shortening later waits, never by pressing early", () => {
    // A digit sent before the announcement ends is not accepted at all, so the
    // FIRST press keeps its full wait and the overflow is taken off the tail.
    const plan = planAiFirstAccept(
      takeover({
        accept_digits: [
          { digit: "1", after_seconds: 5 },
          { digit: "2", after_seconds: 5 }
        ],
        media_start_seconds: 5
      })
    );
    expect(plan.digits[0]).toEqual({ digit: "1", after_seconds: 5 });
    expect(plan.digits[1]).toEqual({ digit: "2", after_seconds: 0 });
    expect(plan.mediaStartSeconds).toBe(0);
    expect(
      aiFirstDelaySeconds(plan.digits.map((d) => d.after_seconds), plan.mediaStartSeconds)
    ).toBeLessThanOrEqual(AI_FIRST_MAX_DELAY_SECONDS);
  });

  it("accepts *, # and numeric-string waits from JSONB", () => {
    const plan = planAiFirstAccept(
      takeover({
        accept_digits: [
          { digit: "*", after_seconds: "2" as unknown as number },
          { digit: "#", after_seconds: 1 }
        ]
      })
    );
    expect(plan.digits).toEqual([
      { digit: "*", after_seconds: 2 },
      { digit: "#", after_seconds: 1 }
    ]);
  });

  it("falls back to the default press when every authored digit is malformed", () => {
    // Answering and then never accepting would lose the referral outright.
    const plan = planAiFirstAccept(
      takeover({
        accept_digits: [
          { digit: "", after_seconds: 1 },
          { digit: "12", after_seconds: 1 },
          { digit: "x", after_seconds: 1 }
        ]
      })
    );
    expect(plan.digits).toEqual([...AI_FIRST_DEFAULT_ACCEPT]);
  });

  it("honors an explicit zero media pause instead of substituting the default", () => {
    const plan = planAiFirstAccept(takeover({ media_start_seconds: 0 }));
    expect(plan.mediaStartSeconds).toBe(0);
  });

  it("treats a null takeover as the default sequence", () => {
    expect(planAiFirstAccept(null).digits).toEqual([...AI_FIRST_DEFAULT_ACCEPT]);
  });

  it("ignores a non-string digit from hand-written JSONB", () => {
    const plan = planAiFirstAccept(
      takeover({
        accept_digits: [
          { digit: 1 as unknown as string, after_seconds: 1 },
          { digit: "1", after_seconds: 2 }
        ]
      })
    );
    expect(plan.digits).toEqual([{ digit: "1", after_seconds: 2 }]);
  });

  it("treats an empty authored sequence as unconfigured", () => {
    expect(planAiFirstAccept(takeover({ accept_digits: [] })).digits).toEqual([
      ...AI_FIRST_DEFAULT_ACCEPT
    ]);
  });
});

describe("buildPreCallBrief", () => {
  it("quotes the alert verbatim and forbids re-asking", () => {
    const brief = buildPreCallBrief("New HomeLight Referral: Salma A. - $250,000 seller in Mesa, AZ");
    expect(brief).toContain('"New HomeLight Referral: Salma A. - $250,000 seller in Mesa, AZ"');
    expect(brief).toContain("never ask for it");
  });

  it("collapses whitespace and clips a long alert", () => {
    expect(buildPreCallBrief("a\n\n  b")).toContain('"a b"');
    const long = buildPreCallBrief("x".repeat(AI_FIRST_BRIEF_MAX_CHARS + 200));
    expect(long).toContain("x".repeat(AI_FIRST_BRIEF_MAX_CHARS));
    expect(long).not.toContain("x".repeat(AI_FIRST_BRIEF_MAX_CHARS + 1));
  });

  it("returns nothing for an empty alert (no brief beats an empty one)", () => {
    expect(buildPreCallBrief("   \n ")).toBe("");
  });
});

describe("buildHandoffContext: AI-first takeover fields", () => {
  it("carries answer_first, digits, media pause, brief matcher, and the second recipient", () => {
    const ctx = buildHandoffContext({
      toE164: "+16023131823",
      steps: [{ to_e164: "+16025245719", ring_secs: 20 }],
      aiTakeover: {
        notify_e164: "+16025245719",
        also_notify_e164: " +16026951142 ",
        answer_first: true,
        accept_digits: [{ digit: "1", after_seconds: "3" }],
        media_start_seconds: 2,
        brief_sms_contains: " HomeLight Referral ",
        context_note: " what we know "
      }
    });
    expect(ctx.ai_takeover).toEqual({
      notify_e164: "+16025245719",
      persona: undefined,
      capture_fields: undefined,
      also_notify_e164: "+16026951142",
      answer_first: true,
      accept_digits: [{ digit: "1", after_seconds: 3 }],
      media_start_seconds: 2,
      brief_sms_contains: "HomeLight Referral",
      context_note: "what we know"
    });
  });

  it("omits every AI-first field on an ordinary takeover chain", () => {
    // An untouched chain's persisted context must stay byte-identical to what it
    // was before AI-first existed.
    const ctx = buildHandoffContext({
      toE164: "+16023131823",
      steps: [{ to_e164: "+16025245719", ring_secs: 20 }],
      aiTakeover: { notify_e164: "+16026951142", persona: "Hi" }
    });
    const keys = Object.keys(ctx.ai_takeover ?? {});
    for (const absent of [
      "also_notify_e164",
      "answer_first",
      "accept_digits",
      "media_start_seconds",
      "brief_sms_contains",
      "context_note"
    ]) {
      expect(keys).not.toContain(absent);
    }
  });

  it("drops answer_first unless it is literally true, and blank string fields", () => {
    const ctx = buildHandoffContext({
      toE164: "+1",
      steps: [{ to_e164: "+16025245719", ring_secs: 20 }],
      aiTakeover: {
        notify_e164: "+16026951142",
        answer_first: "yes",
        also_notify_e164: "   ",
        brief_sms_contains: "  ",
        context_note: "",
        accept_digits: [{ digit: "  " }]
      }
    });
    const keys = Object.keys(ctx.ai_takeover ?? {});
    expect(keys).not.toContain("answer_first");
    expect(keys).not.toContain("also_notify_e164");
    expect(keys).not.toContain("brief_sms_contains");
    expect(keys).not.toContain("context_note");
    // Every digit was blank, so no accept_digits key at all.
    expect(keys).not.toContain("accept_digits");
  });

  it("tolerates a non-array accept_digits payload", () => {
    const ctx = buildHandoffContext({
      toE164: "+1",
      steps: [{ to_e164: "+16025245719", ring_secs: 20 }],
      aiTakeover: { notify_e164: "+16026951142", accept_digits: "1" }
    });
    expect(Object.keys(ctx.ai_takeover ?? {})).not.toContain("accept_digits");
  });

  it("drops null and non-string-digit entries from a JSONB accept sequence", () => {
    const ctx = buildHandoffContext({
      toE164: "+1",
      steps: [{ to_e164: "+16025245719", ring_secs: 20 }],
      aiTakeover: {
        notify_e164: "+16026951142",
        accept_digits: [null, { after_seconds: 2 }, { digit: 1 }, { digit: "1", after_seconds: 3 }]
      }
    });
    expect(ctx.ai_takeover?.accept_digits).toEqual([{ digit: "1", after_seconds: 3 }]);
  });
});
