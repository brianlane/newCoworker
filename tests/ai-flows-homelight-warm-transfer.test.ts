import { describe, expect, it } from "vitest";
import {
  ALERT_REGEX,
  BRIEF_NEEDLE,
  briefOnBothWordings,
  matchWarmTransfers,
  type Definition
} from "../scripts/oneshot/homelight-warm-transfer-trigger";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

/** The real texts HomeLight sends, from Amy's inbox. */
const ALERTS = {
  referral: "New HomeLight Referral: Salma - $250K seller in Mesa, AZ. Follow the link below to contact the client.",
  clientRequest:
    "New HomeLight Referral - Client Request from Don - $380K seller in 85205. This client found you directly on our website and requested your help now. Follow the link below to accept and message them back.",
  warmTransfer:
    "New HomeLight Warm Transfer Opportunity: Jose - $250,000 seller in Mesa, AZ. Follow the link below to contact the client.",
  // Arrives ~2 minutes after a warm transfer nobody answered.
  tooLate:
    "Sorry, this referral is no longer available for a live transfer. Please respond to Warm Transfer Referrals quickly to be transferred to the client while they are speaking with the HomeLight Concierge!",
  // Post-call survey. Contains "HomeLight referral" AND a link, so the OLD
  // literal condition matched it: a run for a lead already handled.
  feedback:
    "Great job connecting with Aaron! Provide feedback for your experience with your HomeLight referral using the link below. https://hmlt.co/94bc4e95"
};

function smsDef(): Definition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      conditions: [
        { type: "has_url" },
        { type: "contains", value: "HomeLight Referral", caseInsensitive: true }
      ],
      correlationWindowMinutes: 15
    },
    steps: [{ id: "url", type: "extract_url", saveAs: "leadUrl" }]
  };
}

function voiceDef(brief = "HomeLight Referral"): Definition {
  return {
    version: 1,
    trigger: { channel: "voice", fromE164: "+14159851909" },
    steps: [
      { id: "ring1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 },
      {
        id: "ai",
        type: "voice_ai_intake",
        notifyE164: "+16025245719",
        answerFirst: true,
        acceptOnPrompt: { digit: "1", fallbackSeconds: 12 },
        briefFromSmsContaining: brief
      }
    ]
  };
}

const conditionsOf = (def: Definition) => def.trigger!.conditions!;
const regexOf = (def: Definition) =>
  new RegExp(conditionsOf(def).find((c) => c.type === "regex")!.value as string, "i");

describe("homelight-warm-transfer-trigger: the alert condition", () => {
  it("swaps the literal for a regex covering both wordings", () => {
    const def = smsDef();
    expect(matchWarmTransfers(def)).toBe(true);
    expect(conditionsOf(def)).toEqual([
      { type: "has_url" },
      { type: "regex", value: ALERT_REGEX, caseInsensitive: true }
    ]);
  });

  it("matches every alert that should start a run", () => {
    const def = smsDef();
    matchWarmTransfers(def);
    const re = regexOf(def);
    // The stream that already worked...
    expect(re.test(ALERTS.referral)).toBe(true);
    expect(re.test(ALERTS.clientRequest)).toBe(true);
    // ...and the one that was silently ignored, which is the whole point.
    expect(re.test(ALERTS.warmTransfer)).toBe(true);
  });

  it("still ignores the follow-ups that are not new leads", () => {
    const def = smsDef();
    matchWarmTransfers(def);
    const re = regexOf(def);
    expect(re.test(ALERTS.tooLate)).toBe(false);
    // Anchoring on "New" fixes a false positive the old literal allowed: this
    // one carries both the phrase and a link, so it could start a run for a
    // lead that had already been worked.
    expect(re.test(ALERTS.feedback)).toBe(false);
    expect(/HomeLight Referral/i.test(ALERTS.feedback)).toBe(true);
  });

  it("keeps has_url and the correlation window, which stitch the link message on", () => {
    // Neither alert carries a URL; HomeLight sends the link as its own message
    // in the same second, and the window is what joins the two.
    const def = smsDef();
    matchWarmTransfers(def);
    expect(conditionsOf(def).some((c) => c.type === "has_url")).toBe(true);
    expect(def.trigger!.correlationWindowMinutes).toBe(15);
  });

  it("rewrites additional triggers too, and is idempotent", () => {
    const def = smsDef();
    def.triggers = [
      {
        channel: "sms",
        conditions: [{ type: "contains", value: "homelight referral", caseInsensitive: true }]
      }
    ];
    expect(matchWarmTransfers(def)).toBe(true);
    expect(def.triggers[0].conditions![0]).toMatchObject({ type: "regex", value: ALERT_REGEX });
    expect(matchWarmTransfers(def)).toBe(false);
  });

  it("leaves an unrelated contains condition alone", () => {
    const def = smsDef();
    conditionsOf(def).push({ type: "contains", value: "Mesa", caseInsensitive: true });
    matchWarmTransfers(def);
    expect(conditionsOf(def)).toContainEqual({
      type: "contains",
      value: "Mesa",
      caseInsensitive: true
    });
  });

  it("throws on a flow with no trigger rather than writing nothing silently", () => {
    expect(() => matchWarmTransfers({ steps: [] } as Definition)).toThrow(/no trigger/);
  });

  it("produces a definition that still validates", () => {
    const def = smsDef();
    matchWarmTransfers(def);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });
});

describe("homelight-warm-transfer-trigger: the pre-call brief", () => {
  it("widens the needle so a warm transfer also briefs the AI", () => {
    // Otherwise the AI answers a warm transfer knowing nothing about the
    // seller, which it cannot recover mid-call.
    const def = voiceDef();
    expect(briefOnBothWordings(def)).toBe(true);
    const intake = def.steps!.find((s) => s.type === "voice_ai_intake")!;
    expect(intake.briefFromSmsContaining).toBe(BRIEF_NEEDLE);
    // Substring test, not a regex, so it has to be a literal both share.
    expect(ALERTS.referral).toContain(BRIEF_NEEDLE);
    expect(ALERTS.warmTransfer).toContain(BRIEF_NEEDLE);
  });

  it("is idempotent and leaves the rest of the intake alone", () => {
    const def = voiceDef();
    briefOnBothWordings(def);
    expect(briefOnBothWordings(def)).toBe(false);
    const intake = def.steps!.find((s) => s.type === "voice_ai_intake")!;
    expect(intake).toMatchObject({
      answerFirst: true,
      acceptOnPrompt: { digit: "1", fallbackSeconds: 12 },
      notifyE164: "+16025245719"
    });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("throws when there is no AI intake to brief", () => {
    const noIntake: Definition = {
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [{ id: "ring1", type: "ring_handoff", toE164: "+16025245719" }]
    };
    expect(() => briefOnBothWordings(noIntake)).toThrow(/voice_ai_intake/);
  });
});
